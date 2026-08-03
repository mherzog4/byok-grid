import { queueSqliteManualSourceRun } from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { sourceErrorResponse } from '@/lib/source-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ sourceId: string; tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { sourceId, tableId, workspaceId } = await context.params;
    return Response.json(
      await queueSqliteManualSourceRun(sqliteDb, {
        sourceId,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 202 }
    );
  } catch (error) {
    return sourceErrorResponse(error, request);
  }
}
