import { getSqliteGridRow } from '@byok-grid/db';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{
    rowId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { rowId, tableId, workspaceId } = await context.params;
    return Response.json(
      await getSqliteGridRow(sqliteDb, {
        rowId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}
