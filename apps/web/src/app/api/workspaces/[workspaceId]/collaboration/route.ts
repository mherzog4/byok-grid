import {
  createSqliteWorkspaceInvitation,
  listSqliteWorkspaceCollaboration,
} from '@byok-grid/db';
import { workspaceInvitationRequestSchema } from '@byok-grid/domain';
import { collaborationErrorResponse } from '@/lib/collaboration-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await listSqliteWorkspaceCollaboration(sqliteDb, {
        userId: user.id,
        workspaceId,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return collaborationErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const parsed = workspaceInvitationRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json(
      { error: 'Enter a valid email address and invitation role.' },
      { status: 400 }
    );
  }

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await createSqliteWorkspaceInvitation(sqliteDb, {
        ...parsed.data,
        userId: user.id,
        workspaceId,
      }),
      {
        headers: { 'cache-control': 'no-store' },
        status: 201,
      }
    );
  } catch (error) {
    return collaborationErrorResponse(error);
  }
}
