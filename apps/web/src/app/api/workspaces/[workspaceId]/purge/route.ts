import {
  previewSqliteWorkspacePurge,
  purgeSqliteWorkspace,
} from '@byok-grid/db';
import { workspacePurgeRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { workspacePurgeErrorResponse } from '@/lib/workspace-purge-api';

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await previewSqliteWorkspacePurge(sqliteDb, {
        userId: user.id,
        workspaceId,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return workspacePurgeErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const parsed = workspacePurgeRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json(
      {
        error:
          parsed.error.issues[0]?.message ?? 'The confirmation is invalid.',
      },
      { status: 400 }
    );
  }

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await purgeSqliteWorkspace(sqliteDb, {
        ...parsed.data,
        userId: user.id,
        workspaceId,
      }),
      {
        headers: { 'cache-control': 'no-store' },
        status: 200,
      }
    );
  } catch (error) {
    return workspacePurgeErrorResponse(error);
  }
}
