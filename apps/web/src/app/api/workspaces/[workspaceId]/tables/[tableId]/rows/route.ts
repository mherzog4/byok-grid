import { createSqliteGridRow } from '@byok-grid/db';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { tableId, workspaceId } = await context.params;
    const row = await createSqliteGridRow(sqliteDb, {
      tableId,
      userId: user.id,
      workspaceId,
    });
    return Response.json({ ...row, cells: {} }, { status: 201 });
  } catch (error) {
    return gridErrorResponse(error);
  }
}
