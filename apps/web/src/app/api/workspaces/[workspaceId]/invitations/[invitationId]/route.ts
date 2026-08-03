import { revokeSqliteWorkspaceInvitation } from '@byok-grid/db';
import { collaborationErrorResponse } from '@/lib/collaboration-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ invitationId: string; workspaceId: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { invitationId, workspaceId } = await context.params;
    return Response.json(
      await revokeSqliteWorkspaceInvitation(sqliteDb, {
        invitationId,
        userId: user.id,
        workspaceId,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return collaborationErrorResponse(error);
  }
}
