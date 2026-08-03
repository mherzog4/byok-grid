import { parseMasterKey } from '@byok-grid/security';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteEncryptedCredential } from './credentials';
import {
  createSqliteWorkspaceConnectorRevocation,
  SqliteConnectorRevokedError,
} from './connector-revocations';
import {
  createSqliteConnectorActionColumn,
  createSqliteHttpEnrichmentColumn,
  createSqliteHttpWaterfallColumn,
  markSqliteCellRunRunning,
  markSqliteCellRunSucceeded,
  queueSqliteEnrichmentCellRun,
  queueSqliteWorkflowEnrichmentCellRuns,
  SqliteEnrichmentValidationError,
} from './enrichments';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { cellRuns, cells, outboxEvents, rows } from './schema';
import { createSqliteWorkspaceTable } from './tables';

const userId = '00000000-0000-4000-8000-000000000501';
const workspaceId = '00000000-0000-4000-8000-000000000502';

describe('SQLite connector enrichment ledger', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let masterKey: ReturnType<typeof parseMasterKey>;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-enrichment-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'enrichment@example.test', 'Enrichment Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Enrichment Workspace', 'enrichment-workspace');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
    masterKey = parseMasterKey(
      'enrichment-test-v1',
      randomBytes(32).toString('base64')
    );
  });

  afterEach(() => {
    masterKey.value.fill(0);
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('freezes inputs, deduplicates workflow replay, and honors run modes', async () => {
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Domain',
      firstColumnValueType: 'text',
      name: 'Prospects',
      userId,
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: table.firstColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'example.com' },
      workspaceId,
    });
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'hunter',
      masterKey,
      name: 'Hunter test key',
      secret: { apiKey: 'not-sent-in-this-test' },
      userId,
      workspaceId,
    });
    const column = await createSqliteConnectorActionColumn(handle.db, {
      actionId: 'domain_search',
      connectorId: 'hunter',
      connectorVersion: '1.0.0',
      credentialId: credential.id,
      inputBindings: {
        domain: { columnId: table.firstColumn.id, kind: 'column' },
      },
      name: 'Hunter result',
      outputValueType: 'json',
      protocolVersion: '1.1',
      tableId: table.id,
      userId,
      workspaceId,
    });
    const queueInput: Parameters<
      typeof queueSqliteWorkflowEnrichmentCellRuns
    >[1] = {
      batch: {
        rows: [{ rowId: row.id, tableId: table.id }],
        schemaVersion: 1,
      },
      columnId: column.id,
      mode: 'pending',
      runId: '00000000-0000-4000-8000-000000000511',
      stepId: '00000000-0000-4000-8000-000000000512',
      workspaceId,
    };
    const first = await queueSqliteWorkflowEnrichmentCellRuns(
      handle.db,
      queueInput
    );
    const replay = await queueSqliteWorkflowEnrichmentCellRuns(
      handle.db,
      queueInput
    );
    expect(replay).toEqual(first);
    expect(first).toHaveLength(1);

    const storedRuns = await handle.db.select().from(cellRuns);
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0]?.input).toEqual({ domain: 'example.com' });
    expect(JSON.stringify(storedRuns)).not.toContain('not-sent-in-this-test');

    const run = first[0]!;
    expect(await markSqliteCellRunRunning(handle.db, run)).toBe('ready');
    await markSqliteCellRunSucceeded(handle.db, {
      ...run,
      connectorId: 'hunter',
      output: { data: { domain: 'example.com', emails: [] } },
      value: {
        type: 'json',
        value: { data: { domain: 'example.com', emails: [] } },
      },
    });
    const [completedCell] = await handle.db
      .select()
      .from(cells)
      .where(eq(cells.id, run.cellId));
    expect(completedCell).toMatchObject({
      status: 'succeeded',
      valueType: 'json',
    });
    const [mutatedRow] = await handle.db
      .select({ version: rows.version })
      .from(rows)
      .where(eq(rows.id, row.id));
    expect(mutatedRow!.version).toBeGreaterThan(1);

    const pendingAfterSuccess = await queueSqliteWorkflowEnrichmentCellRuns(
      handle.db,
      {
        ...queueInput,
        runId: randomUUID(),
        stepId: randomUUID(),
      }
    );
    expect(pendingAfterSuccess).toEqual([]);

    const explicitRerun = await queueSqliteWorkflowEnrichmentCellRuns(
      handle.db,
      {
        ...queueInput,
        mode: 'all',
        runId: randomUUID(),
        stepId: randomUUID(),
      }
    );
    expect(explicitRerun).toHaveLength(1);
    expect(explicitRerun[0]?.runId).not.toBe(run.runId);

    await setSqliteCellRunFailureForTest(explicitRerun[0]!);
    await createSqliteWorkspaceConnectorRevocation(handle.db, {
      reason: 'Provider connector disabled during incident response.',
      target: { connectorId: 'hunter', kind: 'connector' },
      userId,
      workspaceId,
    });
    await expect(
      queueSqliteWorkflowEnrichmentCellRuns(handle.db, {
        ...queueInput,
        mode: 'all',
        runId: randomUUID(),
        stepId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(SqliteConnectorRevokedError);
  });

  it('freezes guarded HTTP and ordered waterfall plans without secrets', async () => {
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Domain',
      firstColumnValueType: 'text',
      name: 'HTTP prospects',
      userId,
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: table.firstColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'acme.example' },
      workspaceId,
    });

    const http = await createSqliteHttpEnrichmentColumn(handle.db, {
      baseUrl: 'https://api.example.test/company',
      credentialId: null,
      inputColumnId: table.firstColumn.id,
      name: 'HTTP company',
      queryParameter: 'domain',
      tableId: table.id,
      userId,
      workspaceId,
    });
    const httpRun = await queueSqliteEnrichmentCellRun(handle.db, {
      columnId: http.id,
      rowId: row.id,
      tableId: table.id,
      userId,
      workspaceId,
    });

    const waterfall = await createSqliteHttpWaterfallColumn(handle.db, {
      inputColumnId: table.firstColumn.id,
      name: 'Company waterfall',
      providers: [
        {
          baseUrl: 'https://primary.example.test/search',
          credentialId: null,
          name: 'Primary',
          queryParameter: 'domain',
          resultPath: 'body.company',
        },
        {
          baseUrl: 'https://fallback.example.test/lookup',
          credentialId: null,
          name: 'Fallback',
          queryParameter: 'q',
          resultPath: 'body.result',
        },
      ],
      tableId: table.id,
      userId,
      workspaceId,
    });
    const waterfallRun = await queueSqliteEnrichmentCellRun(handle.db, {
      columnId: waterfall.id,
      rowId: row.id,
      tableId: table.id,
      userId,
      workspaceId,
    });

    const storedRuns = await handle.db.select().from(cellRuns);
    expect(storedRuns.find((run) => run.id === httpRun.runId)).toMatchObject({
      actionId: 'request',
      allowedHosts: ['api.example.test'],
      connectorId: 'http',
      credentialId: null,
      input: {
        method: 'GET',
        url: 'https://api.example.test/company?domain=acme.example',
      },
    });
    expect(
      storedRuns.find((run) => run.id === waterfallRun.runId)
    ).toMatchObject({
      actionId: 'execute',
      allowedHosts: ['primary.example.test', 'fallback.example.test'],
      connectorId: 'http_waterfall',
      credentialId: null,
      input: {
        kind: 'http_waterfall',
        providers: [
          {
            name: 'Primary',
            resultPath: 'body.company',
            url: 'https://primary.example.test/search?domain=acme.example',
          },
          {
            name: 'Fallback',
            resultPath: 'body.result',
            url: 'https://fallback.example.test/lookup?q=acme.example',
          },
        ],
        version: 1,
      },
    });
    expect(await handle.db.select().from(outboxEvents)).toHaveLength(2);
    await expect(
      createSqliteHttpEnrichmentColumn(handle.db, {
        baseUrl: 'http://unsafe.example.test',
        credentialId: null,
        inputColumnId: table.firstColumn.id,
        name: 'Unsafe',
        queryParameter: 'q',
        tableId: table.id,
        userId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteEnrichmentValidationError);
  });

  async function setSqliteCellRunFailureForTest(
    run: Awaited<
      ReturnType<typeof queueSqliteWorkflowEnrichmentCellRuns>
    >[number]
  ) {
    expect(await markSqliteCellRunRunning(handle.db, run)).toBe('ready');
    const { setSqliteCellRunFailure } = await import('./enrichments');
    await setSqliteCellRunFailure(handle.db, {
      ...run,
      errorCode: 'test_failure',
      errorMessage: 'Reset target state for the revocation assertion.',
      retrying: false,
    });
  }
});
