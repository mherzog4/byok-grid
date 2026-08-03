import {
  createSqliteFormulaColumn,
  SqliteFormulaAccessError,
  SqliteFormulaConflictError,
  SqliteFormulaValidationError,
} from '@byok-grid/db';
import {
  formulaExpressionSchema,
  MAXIMUM_FORMULA_SOURCE_CHARACTERS,
} from '@byok-grid/domain';
import { sqliteDb } from '@/lib/sqlite-database';
import { getApiUser } from '@/lib/grid-api';
import { z } from 'zod';

const createColumnSchema = z.union([
  z.strictObject({
    expression: formulaExpressionSchema,
    name: z.string().min(1).max(120),
  }),
  z.strictObject({
    name: z.string().min(1).max(120),
    source: z.string().min(1).max(MAXIMUM_FORMULA_SOURCE_CHARACTERS),
  }),
]);

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = createColumnSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The formula configuration is invalid.' },
      { status: 400 }
    );
  }

  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteFormulaColumn(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SqliteFormulaAccessError) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }
    if (error instanceof SqliteFormulaConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SqliteFormulaValidationError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error('Unexpected formula API error', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return Response.json({ error: 'The request failed.' }, { status: 500 });
  }
}
