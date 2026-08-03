import {
  ConnectorError,
  executeAction,
  HUBSPOT_API_HOST,
  hubSpotConnector,
  hubSpotCredentialSchema,
  HubSpotWritebackError,
} from '@byok-grid/connectors';
import {
  credentials,
  markWritebackDeliveryRunning,
  markWritebackDeliverySucceeded,
  setWritebackDeliveryWorkerFailure,
  workspaceKeys,
  writebackDeliveries,
  writebackDestinations,
} from '@byok-grid/db/postgres';
import {
  writebackDeliveryInputSchema,
  writebackPayloadSchema,
  type WritebackDeliveryInput,
} from '@byok-grid/domain';
import {
  decryptCredential,
  parseMasterKey,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from './config';
import { db } from './database';
import { guardedEgressFetch } from '@byok-grid/connectors';
import { hatchet } from './hatchet';

const maximumRetries = 3;
const maximumResponseBytes = 64 * 1_024;
const masterKey = parseMasterKey(
  config.BYOK_GRID_MASTER_KEY_ID,
  config.BYOK_GRID_MASTER_KEY
);

export const executeWritebackDeliveryTask = hatchet.task({
  name: 'execute-writeback-delivery',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 300 },
  executionTimeout: '2m',
  idempotency: {
    expression: 'input.deliveryId',
    fallbackTtlMs: 7 * 86_400_000,
    strategy: 'status',
  },
  inputValidator: writebackDeliveryInputSchema,
  fn: (input, context) =>
    executeWritebackDelivery(
      writebackDeliveryInputSchema.parse(input),
      context.retryCount()
    ),
});

async function executeWritebackDelivery(
  input: WritebackDeliveryInput,
  retryCount: number
) {
  const state = await markWritebackDeliveryRunning(db, input);
  if (state !== 'ready') return { deliveryId: input.deliveryId, status: state };

  try {
    const execution = await loadWritebackExecution(input);
    const payload = writebackPayloadSchema.parse(execution.delivery.payload);
    const credential = resolveCredential(execution, input.workspaceId);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);
    try {
      const output = await executeAction({
        action: hubSpotConnector.actions.update_contact,
        context: {
          abortSignal: abortController.signal,
          allowedHosts: new Set([HUBSPOT_API_HOST]),
          fetch: guardedEgressFetch,
          idempotencyKey: input.deliveryId,
          maxResponseBytes: maximumResponseBytes,
        },
        credential,
        credentialSchema: hubSpotCredentialSchema,
        input: {
          properties: payload.properties,
          recordId: payload.recordId,
        },
      });
      await Promise.all([
        markWritebackDeliverySucceeded(db, {
          ...input,
          responseStatus: output.responseStatus,
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
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const failure = classifyFailure(error);
    const retrying = failure.retryable && retryCount < maximumRetries;
    await setWritebackDeliveryWorkerFailure(db, {
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

async function loadWritebackExecution(input: WritebackDeliveryInput) {
  const [execution] = await db
    .select({
      credential: credentials,
      delivery: writebackDeliveries,
      destination: writebackDestinations,
      workspaceKey: workspaceKeys,
    })
    .from(writebackDeliveries)
    .innerJoin(
      writebackDestinations,
      and(
        eq(writebackDestinations.id, writebackDeliveries.destinationId),
        eq(writebackDestinations.workspaceId, writebackDeliveries.workspaceId)
      )
    )
    .innerJoin(
      credentials,
      and(
        eq(credentials.id, writebackDestinations.credentialId),
        eq(credentials.workspaceId, writebackDestinations.workspaceId)
      )
    )
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, writebackDeliveries.workspaceId)
    )
    .where(
      and(
        eq(writebackDeliveries.id, input.deliveryId),
        eq(writebackDeliveries.destinationId, input.destinationId),
        eq(writebackDeliveries.tableId, input.tableId),
        eq(writebackDeliveries.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!execution) {
    throw new ConnectorError(
      'invalid_input',
      'The writeback delivery does not exist.',
      false
    );
  }
  if (
    execution.destination.adapterId !== 'hubspot_contact' ||
    execution.credential.connectorId !== 'hubspot' ||
    execution.credential.revokedAt
  ) {
    throw new ConnectorError(
      'authentication',
      'The HubSpot writeback credential is missing or revoked.',
      false
    );
  }
  return execution;
}

function resolveCredential(
  execution: Awaited<ReturnType<typeof loadWritebackExecution>>,
  workspaceId: string
) {
  if (!execution.workspaceKey) {
    throw new ConnectorError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  const workspaceKey = unwrapWorkspaceKey(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    masterKey
  );
  try {
    return hubSpotCredentialSchema.parse(
      decryptCredential(
        workspaceId,
        execution.credential.id,
        workspaceKey,
        execution.credential.encryptedValue
      )
    );
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
  if (error instanceof HubSpotWritebackError) {
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
      code: 'invalid_input',
      message: 'The stored writeback configuration or payload is invalid.',
      responseStatus: null,
      retryable: false,
    };
  }
  return {
    code: 'internal',
    message: 'The writeback delivery failed unexpectedly.',
    responseStatus: null,
    retryable: true,
  };
}
