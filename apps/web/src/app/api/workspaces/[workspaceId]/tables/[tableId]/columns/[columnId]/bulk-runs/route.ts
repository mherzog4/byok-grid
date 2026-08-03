import {
  createSqliteBulkRunBatch,
  previewSqliteBulkRun,
  SqliteBulkRunConflictError,
} from '@byok-grid/db';
import { bulkRunModeSchema, gridSearchQuerySchema } from '@byok-grid/domain';
import { z } from 'zod';
import { getBulkRunLimits } from '@/lib/bulk-run';
import { enrichmentErrorResponse } from '@/lib/enrichment-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

const previewInputSchema = z.strictObject({
  mode: bulkRunModeSchema.default('pending'),
  rowLimit: z.coerce.number().int().min(1).max(10_000).default(100),
  searchQuery: gridSearchQuerySchema.nullable().optional(),
  viewId: z.string().uuid().optional(),
});

const createInputSchema = previewInputSchema.extend({
  expectedSelectedRows: z.number().int().min(0),
  expectedSelectionDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

interface RouteContext {
  params: Promise<{
    columnId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const url = new URL(request.url);
  const parsed = previewInputSchema.safeParse({
    mode: url.searchParams.get('mode') ?? undefined,
    rowLimit: url.searchParams.get('rowLimit') ?? undefined,
    searchQuery: url.searchParams.get('search') ?? undefined,
    viewId: url.searchParams.get('view') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: 'The bulk-run preview settings are invalid.' },
      { status: 422 }
    );
  }

  try {
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await previewSqliteBulkRun(sqliteDb, {
        ...parsed.data,
        columnId,
        limits: getBulkRunLimits(),
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const parsed = createInputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: 'The bulk-run confirmation is invalid.' },
      { status: 422 }
    );
  }

  try {
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteBulkRunBatch(sqliteDb, {
        ...parsed.data,
        columnId,
        limits: getBulkRunLimits(),
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof SqliteBulkRunConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return enrichmentErrorResponse(error);
  }
}
