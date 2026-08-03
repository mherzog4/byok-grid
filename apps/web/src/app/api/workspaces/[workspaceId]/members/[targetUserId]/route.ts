import { readApiJsonBody } from '@/lib/request-body';
import {
  removeSqliteWorkspaceMember,
  updateSqliteWorkspaceMemberRole,
} from '@byok-grid/db';
import { workspaceInvitationRoleSchema } from '@byok-grid/domain';
import { collaborationErrorResponse } from '@/lib/collaboration-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const updateRoleSchema = z.strictObject({
  role: workspaceInvitationRoleSchema,
});

interface RouteContext {
  params: Promise<{ targetUserId: string; workspaceId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'The role is invalid.' }, { status: 400 });
  }

  try {
    const { targetUserId, workspaceId } = await context.params;
    return Response.json(
      await updateSqliteWorkspaceMemberRole(sqliteDb, {
        role: parsed.data.role,
        targetUserId,
        userId: user.id,
        workspaceId,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return collaborationErrorResponse(error, request);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { targetUserId, workspaceId } = await context.params;
    return Response.json(
      await removeSqliteWorkspaceMember(sqliteDb, {
        targetUserId,
        userId: user.id,
        workspaceId,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return collaborationErrorResponse(error, request);
  }
}
