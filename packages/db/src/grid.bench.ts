import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, bench } from 'vitest';
import {
  cells,
  columns,
  createSqliteHttpEnrichmentColumn,
  createSqliteSavedGridView,
  ensureSqlitePersonalWorkspace,
  getSqliteGridSnapshot,
  listSqliteWorkspaceTables,
  migrateSqliteDatabase,
  openSqliteDatabase,
  previewSqliteBulkRun,
  rows,
  type SqliteDatabaseHandle,
  users,
} from './sqlite/index';

let databasePath: string;
let handle: SqliteDatabaseHandle;
let scope: { tableId: string; userId: string; workspaceId: string };
let savedViewId: string;
let bulkColumnId: string;

beforeAll(async () => {
  databasePath = join(tmpdir(), `byok-grid-benchmark-${randomUUID()}.sqlite`);
  handle = await openSqliteDatabase({ url: `file:${databasePath}` });
  await migrateSqliteDatabase(handle.db);
  const userId = randomUUID();
  const [user] = await handle.db
    .insert(users)
    .values({
      id: userId,
      email: `grid-benchmark-${crypto.randomUUID()}@example.test`,
      name: 'Grid Benchmark',
    })
    .returning({ id: users.id, name: users.name });
  const workspace = await ensureSqlitePersonalWorkspace(handle.db, user!);
  const [table] = await listSqliteWorkspaceTables(handle.db, {
    userId: user!.id,
    workspaceId: workspace.id,
  });
  const [company] = await handle.db
    .select({ id: columns.id })
    .from(columns)
    .where(eq(columns.tableId, table!.id));

  const insertedRows = await handle.db
    .insert(rows)
    .values(
      Array.from({ length: 2_000 }, (_, index) => ({
        position: `benchmark-${String(index).padStart(8, '0')}`,
        tableId: table!.id,
        workspaceId: workspace.id,
      }))
    )
    .returning({ id: rows.id });
  await handle.db.insert(cells).values(
    insertedRows.map((row, index) => ({
      columnId: company!.id,
      rowId: row.id,
      tableId: table!.id,
      valueText: `Company ${index}`,
      valueType: 'text' as const,
      workspaceId: workspace.id,
    }))
  );
  scope = {
    tableId: table!.id,
    userId: user!.id,
    workspaceId: workspace.id,
  };
  savedViewId = (
    await createSqliteSavedGridView(handle.db, {
      filters: [
        {
          columnId: company!.id,
          operator: 'text_contains',
          value: 'Company 1',
        },
      ],
      name: 'Benchmark filtered view',
      sort: { columnId: company!.id, direction: 'asc' },
      ...scope,
    })
  ).id;
  bulkColumnId = (
    await createSqliteHttpEnrichmentColumn(handle.db, {
      baseUrl: 'https://api.example.test/company',
      credentialId: null,
      inputColumnId: company!.id,
      name: 'Benchmark firmographics',
      queryParameter: 'company',
      ...scope,
    })
  ).id;
}, 30_000);

afterAll(async () => {
  handle.close();
  for (const suffix of ['', '-shm', '-wal']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
});

bench('fetches the first 100 sparse rows from a 2,000-row table', async () => {
  const page = await getSqliteGridSnapshot(handle.db, scope, { limit: 100 });
  if (page.rows.length !== 100 || !page.pageInfo.hasMore) {
    throw new Error('The benchmark page is invalid.');
  }
});

bench('filters and sorts 100 rows through a saved view', async () => {
  const page = await getSqliteGridSnapshot(handle.db, scope, {
    limit: 100,
    viewId: savedViewId,
  });
  if (page.rows.length !== 100 || !page.pageInfo.hasMore) {
    throw new Error('The saved-view benchmark page is invalid.');
  }
});

bench(
  'previews an exact 100-row bulk selection from a saved view',
  async () => {
    const preview = await previewSqliteBulkRun(handle.db, {
      columnId: bulkColumnId,
      limits: {
        maxOutputTokens: 500_000,
        maxProviderRequests: 1_000,
        maxRows: 500,
      },
      mode: 'pending',
      rowLimit: 100,
      viewId: savedViewId,
      ...scope,
    });
    if (
      preview.selectedRows !== 100 ||
      preview.selection.kind !== 'saved_view'
    ) {
      throw new Error('The saved-view bulk preview is invalid.');
    }
  }
);
