import { sql } from 'drizzle-orm';
import type { Database } from './client';

type LockExecutor = Pick<Database, 'execute'>;

interface TableCellSchemaScope {
  tableId: string;
  workspaceId: string;
}

export async function lockTableCellSchemaShared(
  db: LockExecutor,
  scope: TableCellSchemaScope
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockNamespace(scope)}, 0))`
  );
}

export async function lockTableCellSchemaExclusive(
  db: LockExecutor,
  scope: TableCellSchemaScope
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockNamespace(scope)}, 0))`
  );
}

function lockNamespace(scope: TableCellSchemaScope): string {
  return `table-cell-schema:${scope.workspaceId}:${scope.tableId}`;
}
