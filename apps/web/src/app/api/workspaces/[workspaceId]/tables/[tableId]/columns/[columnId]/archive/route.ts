import { readApiJsonBody } from '@/lib/request-body';
import {
  archiveSqliteWorkspaceColumn,
  previewSqliteColumnArchive,
  restoreSqliteWorkspaceColumn,
} from '@byok-grid/db';
import { schemaArchiveRequestSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

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

  try {
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await previewSqliteColumnArchive(sqliteDb, {
        columnId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const body = await readApiJsonBody(request);
    if (body instanceof Response) return body;
    const parsed = schemaArchiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid confirmation.' },
        { status: 400 }
      );
    }
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await archiveSqliteWorkspaceColumn(sqliteDb, {
        ...parsed.data,
        columnId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await restoreSqliteWorkspaceColumn(sqliteDb, {
        columnId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}
