import { cancelSqliteBulkRunBatch, getSqliteBulkRunBatch } from '@byok-grid/db';
import { entityIdSchema } from '@byok-grid/domain';
import { enrichmentErrorResponse } from '@/lib/enrichment-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{
    batchId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const { batchId, tableId, workspaceId } = await context.params;
  if (!entityIdSchema.safeParse(batchId).success) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  try {
    return Response.json(
      await getSqliteBulkRunBatch(sqliteDb, {
        batchId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const { batchId, tableId, workspaceId } = await context.params;
  if (!entityIdSchema.safeParse(batchId).success) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  try {
    return Response.json(
      await cancelSqliteBulkRunBatch(sqliteDb, {
        batchId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}
