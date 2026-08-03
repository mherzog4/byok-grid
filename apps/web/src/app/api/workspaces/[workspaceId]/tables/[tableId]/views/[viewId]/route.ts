import { readApiJsonBody } from '@/lib/request-body';
import {
  deleteSqliteSavedGridView,
  updateSqliteSavedGridView,
} from '@byok-grid/db';
import { savedGridViewRequestSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ tableId: string; viewId: string; workspaceId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const body = await readApiJsonBody(request);
    if (body instanceof Response) return body;
    const parsed = savedGridViewRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid saved view.' },
        { status: 400 }
      );
    }
    const { tableId, viewId, workspaceId } = await context.params;
    return Response.json(
      await updateSqliteSavedGridView(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        viewId,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { tableId, viewId, workspaceId } = await context.params;
    return Response.json(
      await deleteSqliteSavedGridView(sqliteDb, {
        tableId,
        userId: user.id,
        viewId,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}
