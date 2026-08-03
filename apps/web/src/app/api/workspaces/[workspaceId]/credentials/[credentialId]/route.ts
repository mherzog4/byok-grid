import { revokeSqliteCredential } from '@byok-grid/db';
import { credentialErrorResponse } from '@/lib/credential-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ credentialId: string; workspaceId: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { credentialId, workspaceId } = await context.params;
    return Response.json(
      await revokeSqliteCredential(sqliteDb, {
        credentialId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return credentialErrorResponse(error);
  }
}
