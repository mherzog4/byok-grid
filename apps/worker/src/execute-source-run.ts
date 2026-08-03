import {
  ConnectorError,
  executeAction,
  HUBSPOT_API_HOST,
  httpConnector,
  hubSpotConnector,
} from '@byok-grid/connectors';
import {
  applySourceRunPage,
  credentials,
  markSourceRunRunning,
  setSourceRunWorkerFailure,
  sourceDefinitions,
  sourceRuns,
  workspaceKeys,
} from '@byok-grid/db/postgres';
import {
  decideSourcePageRequest,
  extractNextSourceCursor,
  hubSpotContactsSourceConfigurationSchema,
  normalizeHubSpotContactsSourceResponse,
  normalizeHttpJsonSourceResponse,
  SourceResponseError,
  sourceRunInputSchema,
  type SourceRunInput,
} from '@byok-grid/domain';
import {
  decryptCredential,
  decryptSourceCursor,
  encryptSourceCursor,
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

const maximumRetries = 2;
const maximumSourceResponseBytes = 5 * 1_048_576;
const masterKey = parseMasterKey(
  config.BYOK_GRID_MASTER_KEY_ID,
  config.BYOK_GRID_MASTER_KEY
);

export const executeSourceRunTask = hatchet.task({
  name: 'execute-source-run',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 60 },
  executionTimeout: '30m',
  idempotency: {
    expression: 'input.sourceRunId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: sourceRunInputSchema,
  fn: (input, context) =>
    executeSourceRun(sourceRunInputSchema.parse(input), context.retryCount()),
});

async function executeSourceRun(input: SourceRunInput, retryCount: number) {
  const state = await markSourceRunRunning(db, input);
  if (state !== 'ready') {
    return { sourceRunId: input.sourceRunId, status: state };
  }

  try {
    let execution = await loadSourceExecution(input);
    const workspaceKey = resolveWorkspaceKey(execution, input.workspaceId);
    try {
      const credential = resolveCredential(
        execution,
        input.workspaceId,
        workspaceKey
      );
      if (execution.credential) {
        await db
          .update(credentials)
          .set({ lastUsedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(credentials.id, execution.credential.id),
              eq(credentials.workspaceId, input.workspaceId)
            )
          );
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
        const page = await requestAndNormalizeSourcePage({
          credential,
          currentCursor,
          execution,
          idempotencyKey: `${input.sourceRunId}:page:${execution.run.pageCount + 1}`,
        });
        const { batch, nextCursor } = page;
        if (nextCursor !== null && nextCursor === currentCursor) {
          throw new SourceResponseError(
            'The source repeated its current cursor without making progress.'
          );
        }
        const nextCursorEncrypted = nextCursor
          ? encryptSourceCursor(
              input.workspaceId,
              input.sourceRunId,
              workspaceKey,
              nextCursor
            )
          : null;
        const result = await applySourceRunPage(db, {
          ...input,
          batch,
          expectedPage: execution.run.pageCount + 1,
          nextCursorEncrypted,
        });
        if (result.status === 'succeeded') {
          return { sourceRunId: result.id, status: result.status };
        }
        execution = await loadSourceExecution(input);
      }
    } finally {
      workspaceKey.fill(0);
    }
  } catch (error) {
    const failure = classifyFailure(error);
    const retrying = failure.retryable && retryCount < maximumRetries;
    await setSourceRunWorkerFailure(db, {
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

async function loadSourceExecution(input: SourceRunInput) {
  const [execution] = await db
    .select({
      credential: credentials,
      run: sourceRuns,
      source: sourceDefinitions,
      workspaceKey: workspaceKeys,
    })
    .from(sourceRuns)
    .innerJoin(
      sourceDefinitions,
      and(
        eq(sourceDefinitions.id, sourceRuns.sourceId),
        eq(sourceDefinitions.workspaceId, sourceRuns.workspaceId)
      )
    )
    .leftJoin(credentials, eq(credentials.id, sourceDefinitions.credentialId))
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, sourceRuns.workspaceId)
    )
    .where(
      and(
        eq(sourceRuns.id, input.sourceRunId),
        eq(sourceRuns.sourceId, input.sourceId),
        eq(sourceRuns.tableId, input.tableId),
        eq(sourceRuns.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!execution)
    throw new SourceResponseError('The source run does not exist.');
  if (
    execution.source.adapterId !== 'http_json' &&
    execution.source.adapterId !== 'hubspot_contacts'
  ) {
    throw new SourceResponseError('The source adapter is not installed.');
  }
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
  execution: Awaited<ReturnType<typeof loadSourceExecution>>,
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
  execution: Awaited<ReturnType<typeof loadSourceExecution>>,
  workspaceId: string
): Buffer {
  if (!execution.workspaceKey) {
    throw new ConnectorError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  return unwrapWorkspaceKey(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    masterKey
  );
}

function readSourceCursor(
  execution: Awaited<ReturnType<typeof loadSourceExecution>>,
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
  source: Awaited<ReturnType<typeof loadSourceExecution>>['source'],
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

async function requestSource(input: {
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
  execution: Awaited<ReturnType<typeof loadSourceExecution>>;
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
  const output = await requestSource({
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

function classifyFailure(error: unknown): {
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
  if (error instanceof SourceResponseError || error instanceof z.ZodError) {
    return {
      code: 'invalid_response',
      message:
        error instanceof SourceResponseError
          ? error.message
          : 'The source configuration or response is invalid.',
      retryable: false,
    };
  }
  return {
    code: 'internal',
    message: 'The source run failed unexpectedly.',
    retryable: true,
  };
}
