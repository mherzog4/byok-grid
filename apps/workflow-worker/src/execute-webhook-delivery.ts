import {
  buildWebhookHeaders,
  classifyWebhookStatus,
  ConnectorError,
  guardedEgressFetch,
  WebhookHttpError,
  webhookSigningCredentialSchema,
} from '@byok-grid/connectors';
import {
  credentials,
  markSqliteWebhookDeliveryRunning,
  markSqliteWebhookDeliverySucceeded,
  setSqliteWebhookDeliveryFailure,
  webhookDeliveries,
  webhookDestinations,
  workspaceKeys,
} from '@byok-grid/db';
import {
  webhookDeliveryInputSchema,
  webhookDestinationRequestSchema,
  webhookPayloadSchema,
  type WebhookDeliveryInput,
} from '@byok-grid/domain';
import {
  decryptCredential,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { workflowMasterKeys } from './master-keys';
import { workflowDb } from './database';
import { workflowHatchet } from './hatchet';

export const MAXIMUM_WEBHOOK_RETRIES = 4;
export const executeSqliteWebhookDeliveryTask = workflowHatchet.task({
  name: 'execute-sqlite-webhook-delivery',
  retries: MAXIMUM_WEBHOOK_RETRIES,
  backoff: { factor: 2, maxSeconds: 300 },
  executionTimeout: '2m',
  idempotency: {
    expression: 'input.deliveryId',
    fallbackTtlMs: 7 * 86_400_000,
    strategy: 'status',
  },
  inputValidator: webhookDeliveryInputSchema,
  fn: (input, context) =>
    executeSqliteWebhookDelivery(
      webhookDeliveryInputSchema.parse(input),
      context.retryCount()
    ),
});

export async function executeSqliteWebhookDelivery(
  input: WebhookDeliveryInput,
  retryCount: number
) {
  const state = await markSqliteWebhookDeliveryRunning(workflowDb, input);
  if (state !== 'ready') return { deliveryId: input.deliveryId, status: state };

  try {
    const execution = await loadExecution(input);
    const body = JSON.stringify(
      webhookPayloadSchema.parse(execution.delivery.payload)
    );
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await guardedEgressFetch(execution.destination.endpointUrl, {
        body,
        headers: buildWebhookHeaders({
          body,
          deliveryId: input.deliveryId,
          secret: resolveSigningSecret(execution, input.workspaceId),
          timestamp,
        }),
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const statusFailure = classifyWebhookStatus(response.status);
    await response.body?.cancel().catch(() => undefined);
    if (statusFailure) throw statusFailure;

    await Promise.all([
      markSqliteWebhookDeliverySucceeded(workflowDb, {
        ...input,
        responseStatus: response.status,
      }),
      workflowDb
        .update(credentials)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(credentials.id, execution.credential.id),
            eq(credentials.workspaceId, input.workspaceId)
          )
        ),
    ]);
    return { deliveryId: input.deliveryId, status: 'succeeded' as const };
  } catch (error) {
    const failure = classifyFailure(error);
    const retrying = failure.retryable && retryCount < MAXIMUM_WEBHOOK_RETRIES;
    await setSqliteWebhookDeliveryFailure(workflowDb, {
      ...input,
      errorCode: failure.code,
      errorMessage: failure.message,
      responseStatus: failure.responseStatus,
      retrying,
    });
    if (!failure.retryable) throw new NonRetryableError(failure.message);
    throw new Error(failure.message, { cause: error });
  }
}

async function loadExecution(input: WebhookDeliveryInput) {
  const [execution] = await workflowDb
    .select({
      credential: credentials,
      delivery: webhookDeliveries,
      destination: webhookDestinations,
      workspaceKey: workspaceKeys,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookDestinations,
      and(
        eq(webhookDestinations.id, webhookDeliveries.destinationId),
        eq(webhookDestinations.workspaceId, webhookDeliveries.workspaceId)
      )
    )
    .innerJoin(
      credentials,
      and(
        eq(credentials.id, webhookDestinations.signingCredentialId),
        eq(credentials.workspaceId, webhookDestinations.workspaceId)
      )
    )
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, webhookDeliveries.workspaceId)
    )
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.destinationId, input.destinationId),
        eq(webhookDeliveries.tableId, input.tableId),
        eq(webhookDeliveries.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!execution) {
    throw new WebhookHttpError(
      'invalid_delivery',
      'The webhook delivery does not exist.',
      false
    );
  }
  webhookDestinationRequestSchema.parse({
    name: execution.destination.name,
    signingCredentialId: execution.destination.signingCredentialId,
    triggerMode: execution.destination.triggerMode,
    url: execution.destination.endpointUrl,
  });
  if (
    execution.credential.connectorId !== 'webhook' ||
    execution.credential.revokedAt
  ) {
    throw new WebhookHttpError(
      'authentication',
      'The webhook signing credential is missing or revoked.',
      false
    );
  }
  return execution;
}

function resolveSigningSecret(
  execution: Awaited<ReturnType<typeof loadExecution>>,
  workspaceId: string
): string {
  if (!execution.workspaceKey) {
    throw new WebhookHttpError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  const workspaceKey = unwrapWorkspaceKeyFromRing(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    workflowMasterKeys
  );
  try {
    return webhookSigningCredentialSchema.parse(
      decryptCredential(
        workspaceId,
        execution.credential.id,
        workspaceKey,
        execution.credential.encryptedValue
      )
    ).secret;
  } finally {
    workspaceKey.fill(0);
  }
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
  responseStatus: number | null;
  retryable: boolean;
} {
  if (error instanceof WebhookHttpError) {
    return {
      code: error.code,
      message: error.message,
      responseStatus: error.responseStatus,
      retryable: error.retryable,
    };
  }
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      responseStatus: null,
      retryable: error.retryable,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_delivery',
      message: 'The stored webhook configuration or payload is invalid.',
      responseStatus: null,
      retryable: false,
    };
  }
  return {
    code: 'transient',
    message: 'The webhook endpoint could not be reached.',
    responseStatus: null,
    retryable: true,
  };
}
