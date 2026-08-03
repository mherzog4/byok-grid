import {
  archiveSqliteWorkspaceTable,
  previewSqliteTableArchive,
  restoreSqliteWorkspaceTable,
} from '@byok-grid/db';
import { schemaArchiveRequestSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await previewSqliteTableArchive(sqliteDb, {
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
    const parsed = schemaArchiveRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid confirmation.' },
        { status: 400 }
      );
    }
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await archiveSqliteWorkspaceTable(sqliteDb, {
        ...parsed.data,
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
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await restoreSqliteWorkspaceTable(sqliteDb, {
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}
