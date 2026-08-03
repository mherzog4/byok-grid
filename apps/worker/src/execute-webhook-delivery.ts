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
  markWebhookDeliveryRunning,
  markWebhookDeliverySucceeded,
  setWebhookDeliveryWorkerFailure,
  webhookDeliveries,
  webhookDestinations,
  workspaceKeys,
} from '@byok-grid/db/postgres';
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
import { workerMasterKeys } from './master-keys';
import { db } from './database';
import { hatchet } from './hatchet';

const maximumRetries = 4;
export const executeWebhookDeliveryTask = hatchet.task({
  name: 'execute-webhook-delivery',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 300 },
  executionTimeout: '2m',
  idempotency: {
    expression: 'input.deliveryId',
    fallbackTtlMs: 7 * 86_400_000,
    strategy: 'status',
  },
  inputValidator: webhookDeliveryInputSchema,
  fn: (input, context) =>
    executeWebhookDelivery(
      webhookDeliveryInputSchema.parse(input),
      context.retryCount()
    ),
});

async function executeWebhookDelivery(
  input: WebhookDeliveryInput,
  retryCount: number
) {
  const state = await markWebhookDeliveryRunning(db, input);
  if (state !== 'ready') return { deliveryId: input.deliveryId, status: state };

  try {
    const execution = await loadWebhookExecution(input);
    const secret = resolveSigningSecret(execution, input.workspaceId);
    const body = JSON.stringify(
      webhookPayloadSchema.parse(execution.delivery.payload)
    );
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);
    let response: Response;
    try {
      response = await guardedEgressFetch(execution.destination.endpointUrl, {
        body,
        headers: buildWebhookHeaders({
          body,
          deliveryId: input.deliveryId,
          secret,
          timestamp,
        }),
        method: 'POST',
        redirect: 'manual',
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const statusFailure = classifyWebhookStatus(response.status);
    await response.body?.cancel().catch(() => undefined);
    if (statusFailure) throw statusFailure;

    await Promise.all([
      markWebhookDeliverySucceeded(db, {
        ...input,
        responseStatus: response.status,
      }),
      db
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
    const retrying = failure.retryable && retryCount < maximumRetries;
    await setWebhookDeliveryWorkerFailure(db, {
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

async function loadWebhookExecution(input: WebhookDeliveryInput) {
  const [execution] = await db
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
  execution: Awaited<ReturnType<typeof loadWebhookExecution>>,
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
    workerMasterKeys
  );
  try {
    const decrypted = decryptCredential(
      workspaceId,
      execution.credential.id,
      workspaceKey,
      execution.credential.encryptedValue
    );
    return webhookSigningCredentialSchema.parse(decrypted).secret;
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
