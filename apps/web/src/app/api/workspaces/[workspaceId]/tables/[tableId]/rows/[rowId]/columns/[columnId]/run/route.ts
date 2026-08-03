import { queueSqliteEnrichmentCellRun } from '@byok-grid/db';
import { enrichmentErrorResponse } from '@/lib/enrichment-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{
    columnId: string;
    rowId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { columnId, rowId, tableId, workspaceId } = await context.params;
    return Response.json(
      await queueSqliteEnrichmentCellRun(sqliteDb, {
        columnId,
        rowId,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 202 }
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}
