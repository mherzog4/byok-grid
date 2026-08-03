import {
  collectFormulaColumnIds,
  evaluateFormula,
  FormulaDefinitionError,
  formulaColumnConfigurationSchema,
  parseFormulaSource,
  validateFormulaDefinition,
  type FormulaExpression,
} from '@byok-grid/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client';
import { deserializeCellValue, serializeCellValue } from './cell-values';
import { recordRowMutationAndMaybeQueueSettlement } from './row-automations';
import {
  cells,
  columnDependencies,
  columns,
  dataTables,
  rows,
  workspaceMembers,
} from './schema';

export class FormulaAccessError extends Error {}
export class FormulaValidationError extends Error {}

type FormulaExecutor = Pick<Database, 'insert' | 'select' | 'update'>;

interface FormulaScope {
  rowId: string;
  tableId: string;
  workspaceId: string;
}

export async function createFormulaColumn(
  db: Database,
  input: {
    expression?: FormulaExpression;
    name: string;
    source?: string;
    tableId: string;
    userId: string;
    workspaceId: string;
  }
) {
  if ((input.expression === undefined) === (input.source === undefined)) {
    throw new FormulaValidationError(
      'Provide exactly one formula expression or formula source string.'
    );
  }
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new FormulaValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }
  return db.transaction(async (tx) => {
    const [table] = await tx
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
    if (!table) throw new FormulaAccessError('The table is not accessible.');

    const availableColumns = await tx
      .select({
        id: columns.id,
        name: columns.name,
        valueType: columns.valueType,
      })
      .from(columns)
      .where(
        and(
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      );
    let expression: FormulaExpression;
    try {
      expression =
        input.source !== undefined
          ? parseFormulaSource(input.source, availableColumns)
          : input.expression!;
    } catch (error) {
      if (error instanceof FormulaDefinitionError) {
        throw new FormulaValidationError(error.message);
      }
      throw error;
    }
    const parsedConfiguration = formulaColumnConfigurationSchema.safeParse({
      expression,
      version: 1,
    });
    if (!parsedConfiguration.success) {
      throw new FormulaValidationError(
        parsedConfiguration.error.issues[0]?.message ??
          'The formula configuration is invalid.'
      );
    }
    const configuration = parsedConfiguration.data;
    const dependencyIds = collectFormulaColumnIds(configuration.expression);
    if (dependencyIds.length === 0) {
      throw new FormulaValidationError(
        'A formula must reference at least one source column.'
      );
    }
    const dependencyIdSet = new Set(dependencyIds);
    const sourceColumns = availableColumns.filter((column) =>
      dependencyIdSet.has(column.id)
    );
    if (sourceColumns.length !== dependencyIds.length) {
      throw new FormulaAccessError(
        'One or more formula source columns are not accessible.'
      );
    }

    let valueType: Exclude<(typeof columns.$inferSelect)['valueType'], 'empty'>;
    try {
      valueType = validateFormulaDefinition(
        configuration.expression,
        new Map(sourceColumns.map((column) => [column.id, column.valueType]))
      );
    } catch (error) {
      if (error instanceof FormulaDefinitionError) {
        throw new FormulaValidationError(error.message);
      }
      throw error;
    }

    const [created] = await tx
      .insert(columns)
      .values({
        configuration,
        kind: 'formula',
        name,
        position: `y-${Date.now()}-${crypto.randomUUID()}`,
        tableId: input.tableId,
        valueType,
        workspaceId: input.workspaceId,
      })
      .returning({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        position: columns.position,
        valueType: columns.valueType,
      });
    if (!created) throw new Error('The formula column could not be created.');

    await tx.insert(columnDependencies).values(
      dependencyIds.map((dependsOnColumnId) => ({
        columnId: created.id,
        dependsOnColumnId,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }))
    );

    const existingRows = await tx
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(
          eq(rows.tableId, input.tableId),
          eq(rows.workspaceId, input.workspaceId),
          isNull(rows.archivedAt)
        )
      )
      .orderBy(asc(rows.position));
    for (const row of existingRows) {
      const changedFormulaIds = await recomputeDependentFormulasForRow(tx, {
        changedColumnIds: dependencyIds,
        rowId: row.id,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      });
      await recordRowMutationAndMaybeQueueSettlement(tx, {
        changedColumnIds: changedFormulaIds,
        rowId: row.id,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      });
    }

    return created;
  });
}

export async function recomputeDependentFormulasForRow(
  db: FormulaExecutor,
  input: FormulaScope & { changedColumnIds: readonly string[] }
): Promise<string[]> {
  if (input.changedColumnIds.length === 0) return [];

  const [formulaColumns, dependencies, rowCells] = await Promise.all([
    db
      .select({
        configuration: columns.configuration,
        id: columns.id,
        valueType: columns.valueType,
      })
      .from(columns)
      .where(
        and(
          eq(columns.kind, 'formula'),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      ),
    db
      .select({
        columnId: columnDependencies.columnId,
        dependsOnColumnId: columnDependencies.dependsOnColumnId,
      })
      .from(columnDependencies)
      .where(
        and(
          eq(columnDependencies.tableId, input.tableId),
          eq(columnDependencies.workspaceId, input.workspaceId)
        )
      ),
    db
      .select()
      .from(cells)
      .where(
        and(
          eq(cells.rowId, input.rowId),
          eq(cells.tableId, input.tableId),
          eq(cells.workspaceId, input.workspaceId)
        )
      ),
  ]);
  if (formulaColumns.length === 0) return [];

  const formulas = new Map(formulaColumns.map((column) => [column.id, column]));
  const dependents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const current = dependents.get(dependency.dependsOnColumnId) ?? [];
    current.push(dependency.columnId);
    dependents.set(dependency.dependsOnColumnId, current);
  }

  const reachable = new Set<string>();
  const queue = [...input.changedColumnIds];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const dependent of dependents.get(queue[cursor]!) ?? []) {
      if (reachable.has(dependent)) continue;
      reachable.add(dependent);
      queue.push(dependent);
    }
  }
  if (reachable.size === 0) return [];

  const indegrees = new Map([...reachable].map((id) => [id, 0]));
  for (const dependency of dependencies) {
    if (
      reachable.has(dependency.columnId) &&
      reachable.has(dependency.dependsOnColumnId)
    ) {
      indegrees.set(
        dependency.columnId,
        (indegrees.get(dependency.columnId) ?? 0) + 1
      );
    }
  }
  const ready = [...indegrees]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      if (!reachable.has(dependent)) continue;
      const next = (indegrees.get(dependent) ?? 0) - 1;
      indegrees.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
    ready.sort();
  }
  if (ordered.length !== reachable.size) {
    throw new FormulaDefinitionError('The formula dependency graph is cyclic.');
  }

  const cellByColumn = new Map(rowCells.map((cell) => [cell.columnId, cell]));
  const values = new Map(
    rowCells.map((cell) => [cell.columnId, deserializeCellValue(cell)])
  );
  const changedFormulaIds: string[] = [];

  for (const formulaId of ordered) {
    const formula = formulas.get(formulaId);
    if (!formula) continue;
    const configuration = formulaColumnConfigurationSchema.safeParse(
      formula.configuration
    );
    if (!configuration.success) {
      throw new FormulaDefinitionError(
        `Formula column ${formula.id} has an invalid configuration.`
      );
    }
    const value = evaluateFormula(configuration.data.expression, values);
    if (value.type !== 'empty' && value.type !== formula.valueType) {
      throw new FormulaDefinitionError(
        `Formula column ${formula.id} produced ${value.type}, expected ${formula.valueType}.`
      );
    }
    values.set(formula.id, value);
    const serialized = serializeCellValue(value);
    const existing = cellByColumn.get(formula.id);
    if (existing) {
      const [updated] = await db
        .update(cells)
        .set({
          ...serialized,
          status: 'succeeded',
          updatedAt: new Date(),
          version: sql`${cells.version} + 1`,
        })
        .where(eq(cells.id, existing.id))
        .returning();
      if (updated) {
        cellByColumn.set(formula.id, updated);
        changedFormulaIds.push(formula.id);
      }
    } else if (value.type !== 'empty') {
      const [created] = await db
        .insert(cells)
        .values({
          ...serialized,
          columnId: formula.id,
          rowId: input.rowId,
          status: 'succeeded',
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        })
        .returning();
      if (created) {
        cellByColumn.set(formula.id, created);
        changedFormulaIds.push(formula.id);
      }
    }
  }
  return changedFormulaIds;
}
