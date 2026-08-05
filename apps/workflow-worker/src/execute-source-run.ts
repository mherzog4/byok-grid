import {
  ConnectorError,
  executeAction,
  guardedEgressFetch,
  HUBSPOT_API_HOST,
  httpConnector,
  hubSpotConnector,
} from '@byok-grid/connectors';
import {
  applySqliteSourceRunPage,
  loadSqliteSourceRunExecution,
  markSqliteSourceCredentialUsed,
  markSqliteSourceRunRunning,
  requireSqliteConnectorExecutionAllowed,
  setSqliteSourceRunWorkerFailure,
  SqliteConnectorRevokedError,
  SqliteSourceAccessError,
  type SqliteSourceRunExecution,
} from '@byok-grid/db';
import {
  decideSourcePageRequest,
  extractNextSourceCursor,
  hubSpotContactsSourceConfigurationSchema,
  normalizeHubSpotContactsSourceResponse,
  normalizeHttpJsonSourceResponse,
  SourceResponseError,
  type SourceRunInput,
} from '@byok-grid/domain';
import {
  decryptCredential,
  decryptSourceCursor,
  encryptSourceCursor,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { z } from 'zod';
import { workflowMasterKeys } from './master-keys';
import { workflowDb } from './database';

export const MAXIMUM_SOURCE_RUN_RETRIES = 2;
const maximumSourceResponseBytes = 5 * 1_048_576;

export async function executeSqliteSourceRun(
  input: SourceRunInput,
  retryCount: number
) {
  const state = await markSqliteSourceRunRunning(workflowDb, input);
  if (state !== 'ready') {
    return { sourceRunId: input.sourceRunId, status: state };
  }

  try {
    let execution = await validateSourceExecution(
      await loadSqliteSourceRunExecution(workflowDb, input),
      input
    );
    const workspaceKey = resolveWorkspaceKey(execution, input.workspaceId);
    try {
      const credential = resolveCredential(
        execution,
        input.workspaceId,
        workspaceKey
      );
      if (execution.credential) {
        await markSqliteSourceCredentialUsed(workflowDb, {
          credentialId: execution.credential.id,
          workspaceId: input.workspaceId,
        });
      }
      for (;;) {
        const decision = decideSourcePageRequest({
          maxPages: execution.source.maxPages,
          maxRecords: execution.source.maxRecords,
          pageCount: execution.run.pageCount,
          receivedRecordCount: execution.run.receivedRecordCount,
        });
        if (decision.kind === 'blocked') {
          throw new SourceResponseError(
            decision.reason === 'page_limit'
              ? `The source exceeded its ${execution.source.maxPages}-page limit; already-applied rows remain visible.`
              : `The source exceeded its ${execution.source.maxRecords}-record limit; already-applied rows remain visible.`
          );
        }

        const currentCursor = readSourceCursor(execution, input, workspaceKey);
        const { batch, nextCursor } = await requestAndNormalizeSourcePage({
          credential,
          currentCursor,
          execution,
          idempotencyKey: `${input.sourceRunId}:page:${execution.run.pageCount + 1}`,
        });
        if (nextCursor !== null && nextCursor === currentCursor) {
          throw new SourceResponseError(
            'The source repeated its current cursor without making progress.'
          );
        }
        const result = await applySqliteSourceRunPage(workflowDb, {
          ...input,
          batch,
          expectedPage: execution.run.pageCount + 1,
          nextCursorEncrypted: nextCursor
            ? encryptSourceCursor(
                input.workspaceId,
                input.sourceRunId,
                workspaceKey,
                nextCursor
              )
            : null,
        });
        if (result.status === 'succeeded') {
          return { sourceRunId: result.id, status: result.status };
        }
        execution = await validateSourceExecution(
          await loadSqliteSourceRunExecution(workflowDb, input),
          input
        );
      }
    } finally {
      workspaceKey.fill(0);
    }
  } catch (error) {
    const failure = classifySourceFailure(error);
    const retrying =
      failure.retryable && retryCount < MAXIMUM_SOURCE_RUN_RETRIES;
    await setSqliteSourceRunWorkerFailure(workflowDb, {
      errorCode: failure.code,
      errorMessage: failure.message,
      retrying,
      sourceRunId: input.sourceRunId,
      workspaceId: input.workspaceId,
    });
    if (!failure.retryable) throw new NonRetryableError(failure.message);
    throw new Error(failure.message, { cause: error });
  }
}

async function validateSourceExecution(
  execution: SqliteSourceRunExecution,
  input: SourceRunInput
): Promise<SqliteSourceRunExecution> {
  if (
    execution.source.adapterId !== 'http_json' &&
    execution.source.adapterId !== 'hubspot_contacts'
  ) {
    throw new SourceResponseError('The source adapter is not installed.');
  }
  const connector =
    execution.source.adapterId === 'hubspot_contacts'
      ? hubSpotConnector
      : httpConnector;
  await requireSqliteConnectorExecutionAllowed(workflowDb, input.workspaceId, {
    artifactSha256: null,
    connectorId: connector.id,
    connectorVersion: connector.version,
    publisherKeyIds: [],
  });
  if (execution.credential?.revokedAt) {
    throw new ConnectorError(
      'authentication',
      'The selected source credential has been revoked.',
      false
    );
  }
  const expectedConnectorId =
    execution.source.adapterId === 'hubspot_contacts' ? 'hubspot' : 'http';
  if (
    (execution.source.adapterId === 'hubspot_contacts' &&
      !execution.credential) ||
    (execution.credential &&
      (execution.credential.workspaceId !== input.workspaceId ||
        execution.credential.connectorId !== expectedConnectorId))
  ) {
    throw new ConnectorError(
      'authentication',
      `The selected source credential is not a workspace ${expectedConnectorId} credential.`,
      false
    );
  }
  return execution;
}

function resolveCredential(
  execution: SqliteSourceRunExecution,
  workspaceId: string,
  workspaceKey: Buffer
): Readonly<Record<string, unknown>> {
  if (!execution.credential) return { type: 'none' };
  return decryptCredential(
    workspaceId,
    execution.credential.id,
    workspaceKey,
    execution.credential.encryptedValue
  );
}

function resolveWorkspaceKey(
  execution: SqliteSourceRunExecution,
  workspaceId: string
): Buffer {
  if (!execution.workspaceKey) {
    throw new ConnectorError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  return unwrapWorkspaceKeyFromRing(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    workflowMasterKeys
  );
}

function readSourceCursor(
  execution: SqliteSourceRunExecution,
  input: SourceRunInput,
  workspaceKey: Buffer
): string | null {
  if (!execution.run.nextCursorEncrypted) return null;
  try {
    return decryptSourceCursor(
      input.workspaceId,
      input.sourceRunId,
      workspaceKey,
      execution.run.nextCursorEncrypted
    );
  } catch {
    throw new SourceResponseError(
      'The stored source cursor could not be decrypted.'
    );
  }
}

function sourcePageUrl(
  source: SqliteSourceRunExecution['source'],
  cursor: string | null
): string {
  const url = new URL(source.endpointUrl);
  if (source.paginationMode === 'cursor' && cursor !== null) {
    if (!source.cursorParameter) {
      throw new SourceResponseError(
        'The source cursor parameter is not configured.'
      );
    }
    url.searchParams.set(source.cursorParameter, cursor);
  }
  return url.toString();
}

async function requestHttpSource(input: {
  credential: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  url: string;
}) {
  const url = new URL(input.url);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 60_000);
  try {
    return await executeAction({
      action: httpConnector.actions.request,
      context: {
        abortSignal: abortController.signal,
        allowedHosts: new Set([url.hostname.toLowerCase()]),
        fetch: guardedEgressFetch,
        idempotencyKey: input.idempotencyKey,
        maxResponseBytes: maximumSourceResponseBytes,
      },
      credential: input.credential,
      credentialSchema: httpConnector.credentialSchema,
      input: { method: 'GET', url: input.url },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAndNormalizeSourcePage(input: {
  credential: Readonly<Record<string, unknown>>;
  currentCursor: string | null;
  execution: SqliteSourceRunExecution;
  idempotencyKey: string;
}) {
  const remainingRecords =
    input.execution.source.maxRecords - input.execution.run.receivedRecordCount;
  if (input.execution.source.adapterId === 'hubspot_contacts') {
    const configuration = hubSpotContactsSourceConfigurationSchema.parse(
      input.execution.source.adapterConfiguration
    );
    const { incrementalWindowEnd, incrementalWindowStart } =
      input.execution.run;
    if (!incrementalWindowStart || !incrementalWindowEnd) {
      throw new SourceResponseError(
        'The HubSpot source run has no frozen incremental window.'
      );
    }
    const body = await requestHubSpotContacts({
      after: input.currentCursor,
      credential: input.credential,
      idempotencyKey: input.idempotencyKey,
      properties: configuration.properties,
      windowEnd: incrementalWindowEnd.toISOString(),
      windowStart: incrementalWindowStart.toISOString(),
    });
    return normalizeHubSpotContactsSourceResponse(body, {
      maxRecords: remainingRecords,
      properties: configuration.properties,
    });
  }
  const requestUrl = sourcePageUrl(input.execution.source, input.currentCursor);
  const output = await requestHttpSource({
    credential: input.credential,
    idempotencyKey: input.idempotencyKey,
    url: requestUrl,
  });
  return {
    batch: normalizeHttpJsonSourceResponse(output.body, {
      maxRecords: remainingRecords,
      recordKeyField: input.execution.source.recordKeyField,
      recordPath: input.execution.source.recordPath,
    }),
    nextCursor:
      input.execution.source.paginationMode === 'cursor'
        ? extractNextSourceCursor(
            output.body,
            input.execution.source.nextCursorPath!
          )
        : null,
  };
}

async function requestHubSpotContacts(input: {
  after: string | null;
  credential: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  properties: readonly string[];
  windowEnd: string;
  windowStart: string;
}): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 60_000);
  try {
    return await executeAction({
      action: hubSpotConnector.actions.search_changed_contacts,
      context: {
        abortSignal: abortController.signal,
        allowedHosts: new Set([HUBSPOT_API_HOST]),
        fetch: guardedEgressFetch,
        idempotencyKey: input.idempotencyKey,
        maxResponseBytes: maximumSourceResponseBytes,
      },
      credential: input.credential,
      credentialSchema: hubSpotConnector.credentialSchema,
      input: {
        after: input.after,
        properties: [...input.properties],
        windowEnd: input.windowEnd,
        windowStart: input.windowStart,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function classifySourceFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof SqliteConnectorRevokedError) {
    return { code: 'revoked', message: error.message, retryable: false };
  }
  if (
    error instanceof SourceResponseError ||
    error instanceof SqliteSourceAccessError ||
    error instanceof z.ZodError
  ) {
    return {
      code: 'invalid_response',
      message:
        error instanceof z.ZodError
          ? 'The source configuration or response is invalid.'
          : error.message,
      retryable: false,
    };
  }
  return {
    code: 'internal',
    message: 'The source run failed unexpectedly.',
    retryable: true,
  };
}
