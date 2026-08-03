import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { createSqliteWorkspaceTable } from './tables';
import {
  partitionSqliteWorkflowRowBatch,
  selectSqliteWorkflowRowBatch,
  writeSqliteWorkflowRowBatch,
} from './workflow-data';
import { SqliteWorkflowRunValidationError } from './workflow-runs';

const userId = '00000000-0000-4000-8000-000000000301';
const workspaceId = '00000000-0000-4000-8000-000000000302';

describe('SQLite workflow row data', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-workflow-data-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'workflow-data@example.test', 'Data Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Workflow Data', 'workflow-data');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('selects the grid universe and partitions it with shared filter semantics', async () => {
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Prospects',
      userId,
      workspaceId,
    });
    const [acme, globex] = await Promise.all([
      createSqliteGridRow(handle.db, {
        tableId: table.id,
        userId,
        workspaceId,
      }),
      createSqliteGridRow(handle.db, {
        tableId: table.id,
        userId,
        workspaceId,
      }),
    ]);
    await Promise.all([
      writeSqliteGridCell(handle.db, {
        columnId: table.firstColumn.id,
        expectedVersion: 0,
        rowId: acme.id,
        tableId: table.id,
        userId,
        value: { type: 'text', value: 'Acme Labs' },
        workspaceId,
      }),
      writeSqliteGridCell(handle.db, {
        columnId: table.firstColumn.id,
        expectedVersion: 0,
        rowId: globex.id,
        tableId: table.id,
        userId,
        value: { type: 'text', value: 'Globex' },
        workspaceId,
      }),
    ]);

    const allRows = await selectSqliteWorkflowRowBatch(handle.db, {
      searchQuery: null,
      tableId: table.id,
      userId,
      viewId: null,
      workspaceId,
    });
    expect(allRows.rows).toHaveLength(2);
    const searchRows = await selectSqliteWorkflowRowBatch(handle.db, {
      searchQuery: 'Acme',
      tableId: table.id,
      userId,
      viewId: null,
      workspaceId,
    });
    expect(searchRows.rows).toEqual([
      expect.objectContaining({ rowId: acme.id, tableId: table.id }),
    ]);

    const partition = await partitionSqliteWorkflowRowBatch(handle.db, {
      batch: allRows,
      filterTree: {
        children: [
          {
            columnId: table.firstColumn.id,
            operator: 'text_contains',
            value: 'acme',
          },
        ],
        combinator: 'and',
      },
      workspaceId,
    });
    expect(partition.matched.rows.map((row) => row.rowId)).toEqual([acme.id]);
    expect(partition.rejected.rows.map((row) => row.rowId)).toEqual([
      globex.id,
    ]);

    const target = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Qualified',
      userId,
      workspaceId,
    });
    const writeInput = {
      batch: allRows,
      columnMappings: [
        {
          sourceColumnId: table.firstColumn.id,
          targetColumnId: target.firstColumn.id,
        },
      ],
      runId: '00000000-0000-4000-8000-000000000311',
      stepId: '00000000-0000-4000-8000-000000000312',
      tableId: target.id,
      workspaceId,
    } as const;
    const firstWrite = await writeSqliteWorkflowRowBatch(handle.db, writeInput);
    const replayedWrite = await writeSqliteWorkflowRowBatch(
      handle.db,
      writeInput
    );
    expect(replayedWrite).toEqual(firstWrite);
    const targetSnapshot = await selectSqliteWorkflowRowBatch(handle.db, {
      searchQuery: null,
      tableId: target.id,
      userId,
      viewId: null,
      workspaceId,
    });
    expect(targetSnapshot.rows).toEqual(firstWrite.rows);
    const copiedAcme = await selectSqliteWorkflowRowBatch(handle.db, {
      searchQuery: 'Acme',
      tableId: target.id,
      userId,
      viewId: null,
      workspaceId,
    });
    expect(copiedAcme.rows).toHaveLength(1);

    await expect(
      partitionSqliteWorkflowRowBatch(handle.db, {
        batch: {
          rows: [{ rowId: randomUUID(), tableId: table.id }],
          schemaVersion: 1,
        },
        filterTree: { children: [], combinator: 'and' },
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkflowRunValidationError);
  });
});
