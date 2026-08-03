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
import type { Database } from './client';
import {
  GridAccessError,
  GridConflictError,
  GridValidationError,
} from './grid';
import { columns, dataTables, workspaceMembers } from './schema';

type TableExecutor = Pick<Database, 'execute' | 'insert' | 'select' | 'update'>;

export interface WorkspaceTableSummary {
  id: string;
  name: string;
}

export interface CreatedWorkspaceTable extends WorkspaceTableSummary {
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

export async function createWorkspaceTable(
  db: Database,
  input: WorkspaceScope & CreateTableRequest
): Promise<CreatedWorkspaceTable> {
  const request = createTableRequestSchema.parse({
    firstColumnName: input.firstColumnName,
    firstColumnValueType: input.firstColumnValueType,
    name: input.name,
  });

  return db.transaction(async (tx) => {
    await lockNamespace(tx, `workspace-tables:${input.workspaceId}`);
    await requireWorkspaceMembership(tx, input);

    const [tableCount] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(dataTables)
      .where(eq(dataTables.workspaceId, input.workspaceId));
    if ((tableCount?.value ?? 0) >= MAXIMUM_WORKSPACE_TABLES) {
      throw new GridValidationError(
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
      throw new GridConflictError('A table with this name already exists.');
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

export async function renameWorkspaceTable(
  db: Database,
  input: TableScope & { name: string }
): Promise<WorkspaceTableSummary> {
  const request = updateTableRequestSchema.parse({ name: input.name });

  return db.transaction(async (tx) => {
    await lockNamespace(tx, `workspace-tables:${input.workspaceId}`);
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
      throw new GridConflictError('A table with this name already exists.');
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
    if (!updated) throw new GridAccessError('The table is not accessible.');
    return updated;
  });
}

export async function createInputColumn(
  db: Database,
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

  return db.transaction(async (tx) => {
    await lockNamespace(
      tx,
      `table-columns:${input.workspaceId}:${input.tableId}`
    );
    await requireTableMembership(tx, input);

    const [columnCount] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId)
        )
      );
    if ((columnCount?.value ?? 0) >= MAXIMUM_TABLE_COLUMNS) {
      throw new GridValidationError(
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
      throw new GridConflictError('A column with this name already exists.');
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
  db: TableExecutor,
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
  if (!membership)
    throw new GridAccessError('The workspace is not accessible.');
}

async function requireTableMembership(
  db: TableExecutor,
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
  if (!table) throw new GridAccessError('The table is not accessible.');
}

async function lockNamespace(
  db: TableExecutor,
  namespace: string
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
  );
}
