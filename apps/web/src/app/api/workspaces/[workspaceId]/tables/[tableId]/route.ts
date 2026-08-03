import { readApiJsonBody } from '@/lib/request-body';
import {
  getSqliteGridSnapshot,
  renameSqliteWorkspaceTable,
} from '@byok-grid/db';
import { updateTableRequestSchema } from '@byok-grid/domain';
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
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') ?? '100');
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
      return Response.json(
        { error: 'The page limit must be between 1 and 200.' },
        { status: 400 }
      );
    }
    return Response.json(
      await getSqliteGridSnapshot(
        sqliteDb,
        { tableId, userId: user.id, workspaceId },
        {
          cursor: url.searchParams.get('cursor'),
          limit: rawLimit,
          searchQuery: url.searchParams.get('search'),
          viewId: url.searchParams.get('view'),
        }
      )
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const body = await readApiJsonBody(request);
    if (body instanceof Response) return body;
    const parsed = updateTableRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid table.' },
        { status: 400 }
      );
    }
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await renameSqliteWorkspaceTable(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}
