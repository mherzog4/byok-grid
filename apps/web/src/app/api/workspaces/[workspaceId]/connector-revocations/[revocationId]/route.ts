import { readApiJsonBody } from '@/lib/request-body';
import { liftSqliteWorkspaceConnectorRevocation } from '@byok-grid/db';
import { liftConnectorRevocationRequestSchema } from '@byok-grid/domain';
import { connectorRevocationErrorResponse } from '@/lib/connector-revocation-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ revocationId: string; workspaceId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = liftConnectorRevocationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid confirmation.' },
      { status: 400 }
    );
  }
  try {
    const { revocationId, workspaceId } = await context.params;
    return Response.json(
      await liftSqliteWorkspaceConnectorRevocation(sqliteDb, {
        ...parsed.data,
        revocationId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return connectorRevocationErrorResponse(error);
  }
}
