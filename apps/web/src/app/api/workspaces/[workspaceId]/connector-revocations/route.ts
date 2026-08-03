import { readApiJsonBody } from '@/lib/request-body';
import {
  createSqliteWorkspaceConnectorRevocation,
  listSqliteWorkspaceConnectorRevocations,
} from '@byok-grid/db';
import { createConnectorRevocationRequestSchema } from '@byok-grid/domain';
import { connectorRevocationErrorResponse } from '@/lib/connector-revocation-api';
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
      await listSqliteWorkspaceConnectorRevocations(sqliteDb, {
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return connectorRevocationErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = createConnectorRevocationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid revocation.' },
      { status: 400 }
    );
  }
  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await createSqliteWorkspaceConnectorRevocation(sqliteDb, {
        ...parsed.data,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return connectorRevocationErrorResponse(error);
  }
}
