import {
  ConnectorError,
  executeAction,
  guardedEgressFetch,
  HUBSPOT_API_HOST,
  hubSpotConnector,
  hubSpotCredentialSchema,
  HubSpotWritebackError,
} from '@byok-grid/connectors';
import {
  loadSqliteWritebackExecution,
  markSqliteSourceCredentialUsed,
  markSqliteWritebackDeliveryRunning,
  markSqliteWritebackDeliverySucceeded,
  requireSqliteConnectorExecutionAllowed,
  setSqliteWritebackDeliveryWorkerFailure,
  SqliteConnectorRevokedError,
  type SqliteWritebackExecution,
} from '@byok-grid/db';
import {
  writebackPayloadSchema,
  type WritebackDeliveryInput,
} from '@byok-grid/domain';
import {
  decryptCredential,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { z } from 'zod';
import { workflowMasterKeys } from './master-keys';
import { workflowDb } from './database';

export const MAXIMUM_WRITEBACK_RETRIES = 3;
const maximumResponseBytes = 64 * 1_024;

export async function executeSqliteWritebackDelivery(
  input: WritebackDeliveryInput,
  retryCount: number
) {
  const state = await markSqliteWritebackDeliveryRunning(workflowDb, input);
  if (state !== 'ready') return { deliveryId: input.deliveryId, status: state };
  try {
    const execution = await loadSqliteWritebackExecution(workflowDb, input);
    await validateExecution(execution, input.workspaceId);
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
        input: { properties: payload.properties, recordId: payload.recordId },
      });
      await Promise.all([
        markSqliteWritebackDeliverySucceeded(workflowDb, {
          ...input,
          responseStatus: output.responseStatus,
        }),
        markSqliteSourceCredentialUsed(workflowDb, {
          credentialId: execution.credential.id,
          workspaceId: input.workspaceId,
        }),
      ]);
      return { deliveryId: input.deliveryId, status: 'succeeded' as const };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const failure = classifyFailure(error);
    const retrying =
      failure.retryable && retryCount < MAXIMUM_WRITEBACK_RETRIES;
    await setSqliteWritebackDeliveryWorkerFailure(workflowDb, {
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

async function validateExecution(
  execution: SqliteWritebackExecution,
  workspaceId: string
): Promise<void> {
  await requireSqliteConnectorExecutionAllowed(workflowDb, workspaceId, {
    artifactSha256: null,
    connectorId: hubSpotConnector.id,
    connectorVersion: hubSpotConnector.version,
    publisherKeyIds: [],
  });
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
}

function resolveCredential(
  execution: SqliteWritebackExecution,
  workspaceId: string
) {
  if (!execution.workspaceKey) {
    throw new ConnectorError(
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

function classifyFailure(error: unknown) {
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
  if (error instanceof SqliteConnectorRevokedError) {
    return {
      code: 'revoked',
      message: error.message,
      responseStatus: null,
      retryable: false,
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
