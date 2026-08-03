import {
  createInputColumnRequestSchema,
  createTableRequestSchema,
  MAXIMUM_TABLE_COLUMNS,
  MAXIMUM_WORKSPACE_TABLES,
  updateTableRequestSchema,
  type CreateTableRequest,
  type EditableInputValueType,
} from '@byok-grid/domain';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from './grid-errors';
import { columns, dataTables, workspaceMembers } from './schema';

export interface SqliteWorkspaceTableSummary {
  id: string;
  name: string;
}

export interface SqliteCreatedWorkspaceTable extends SqliteWorkspaceTableSummary {
  firstColumn: {
    id: string;
    kind: 'input';
    name: string;
    valueType: EditableInputValueType;
  };
}

interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

interface TableScope extends WorkspaceScope {
  tableId: string;
}

export async function createSqliteWorkspaceTable(
  db: SqliteDatabase,
  input: WorkspaceScope & CreateTableRequest
): Promise<SqliteCreatedWorkspaceTable> {
  const request = createTableRequestSchema.parse({
    firstColumnName: input.firstColumnName,
    firstColumnValueType: input.firstColumnValueType,
    name: input.name,
  });

  return withSqliteWriteTransaction(db, async (tx) => {
    await requireWorkspaceMembership(tx, input);

    const [tableCount] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(dataTables)
      .where(eq(dataTables.workspaceId, input.workspaceId));
    if ((tableCount?.value ?? 0) >= MAXIMUM_WORKSPACE_TABLES) {
      throw new SqliteGridValidationError(
        `A workspace can contain at most ${MAXIMUM_WORKSPACE_TABLES} tables.`
      );
    }

    const [duplicate] = await tx
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(
        and(
          eq(dataTables.workspaceId, input.workspaceId),
          sql`lower(${dataTables.name}) = lower(${request.name})`
        )
      )
      .limit(1);
    if (duplicate) {
      throw new SqliteGridConflictError(
        'A table with this name already exists.'
      );
    }

    const [table] = await tx
      .insert(dataTables)
      .values({ name: request.name, workspaceId: input.workspaceId })
      .returning({ id: dataTables.id, name: dataTables.name });
    if (!table) throw new Error('The table could not be created.');

    const [firstColumn] = await tx
      .insert(columns)
      .values({
        kind: 'input',
        name: request.firstColumnName,
        position: 'a0',
        tableId: table.id,
        valueType: request.firstColumnValueType,
        workspaceId: input.workspaceId,
      })
      .returning({ id: columns.id, name: columns.name });
    if (!firstColumn) throw new Error('The first column could not be created.');

    return {
      ...table,
      firstColumn: {
        ...firstColumn,
        kind: 'input',
        valueType: request.firstColumnValueType,
      },
    };
  });
}

export async function renameSqliteWorkspaceTable(
  db: SqliteDatabase,
  input: TableScope & { name: string }
): Promise<SqliteWorkspaceTableSummary> {
  const request = updateTableRequestSchema.parse({ name: input.name });

  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTableMembership(tx, input);

    const [duplicate] = await tx
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(
        and(
          eq(dataTables.workspaceId, input.workspaceId),
          ne(dataTables.id, input.tableId),
          sql`lower(${dataTables.name}) = lower(${request.name})`
        )
      )
      .limit(1);
    if (duplicate) {
      throw new SqliteGridConflictError(
        'A table with this name already exists.'
      );
    }

    const [updated] = await tx
      .update(dataTables)
      .set({ name: request.name, updatedAt: new Date() })
      .where(
        and(
          eq(dataTables.id, input.tableId),
          eq(dataTables.workspaceId, input.workspaceId),
          isNull(dataTables.archivedAt)
        )
      )
      .returning({ id: dataTables.id, name: dataTables.name });
    if (!updated) {
      throw new SqliteGridAccessError('The table is not accessible.');
    }
    return updated;
  });
}

export async function createSqliteInputColumn(
  db: SqliteDatabase,
  input: TableScope & { name: string; valueType: EditableInputValueType }
): Promise<{
  id: string;
  kind: 'input';
  name: string;
  position: string;
  valueType: EditableInputValueType;
}> {
  const request = createInputColumnRequestSchema.parse({
    name: input.name,
    valueType: input.valueType,
  });

  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTableMembership(tx, input);

    const [columnCount] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId)
        )
      );
    if ((columnCount?.value ?? 0) >= MAXIMUM_TABLE_COLUMNS) {
      throw new SqliteGridValidationError(
        `A table can contain at most ${MAXIMUM_TABLE_COLUMNS} columns.`
      );
    }

    const [duplicate] = await tx
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId),
          sql`lower(${columns.name}) = lower(${request.name})`
        )
      )
      .limit(1);
    if (duplicate) {
      throw new SqliteGridConflictError(
        'A column with this name already exists.'
      );
    }

    const position = `x-manual-${Date.now()}-${crypto.randomUUID()}`;
    const [column] = await tx
      .insert(columns)
      .values({
        kind: 'input',
        name: request.name,
        position,
        tableId: input.tableId,
        valueType: request.valueType,
        workspaceId: input.workspaceId,
      })
      .returning({ id: columns.id, name: columns.name });
    if (!column) throw new Error('The input column could not be created.');

    return {
      ...column,
      kind: 'input',
      position,
      valueType: request.valueType,
    };
  });
}

async function requireWorkspaceMembership(
  db: Pick<SqliteDatabase, 'select'>,
  input: WorkspaceScope
): Promise<void> {
  const [membership] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .limit(1);
  if (!membership) {
    throw new SqliteGridAccessError('The workspace is not accessible.');
  }
}

async function requireTableMembership(
  db: Pick<SqliteDatabase, 'select'>,
  input: TableScope
): Promise<void> {
  const [table] = await db
    .select({ id: dataTables.id })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(dataTables.id, input.tableId),
        eq(dataTables.workspaceId, input.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!table) {
    throw new SqliteGridAccessError('The table is not accessible.');
  }
}
