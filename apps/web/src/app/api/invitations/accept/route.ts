import { readApiJsonBody } from '@/lib/request-body';
import { acceptSqliteWorkspaceInvitation } from '@byok-grid/db';
import { collaborationErrorResponse } from '@/lib/collaboration-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const acceptInvitationSchema = z.strictObject({
  token: z.string().min(1).max(256),
});

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = acceptInvitationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The invitation token is invalid.' },
      { status: 400 }
    );
  }

  try {
    return Response.json(
      await acceptSqliteWorkspaceInvitation(sqliteDb, {
        email: user.email,
        token: parsed.data.token,
        userId: user.id,
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return collaborationErrorResponse(error, request);
  }
}
