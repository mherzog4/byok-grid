import { readApiJsonBody } from '@/lib/request-body';
import {
  createSqliteWebhookDestination,
  listSqliteWebhookDestinations,
} from '@byok-grid/db';
import { webhookDestinationRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { webhookErrorResponse } from '@/lib/webhook-api';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await listSqliteWebhookDestinations(sqliteDb, {
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return webhookErrorResponse(error, request);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = webhookDestinationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          'The webhook destination is invalid.',
      },
      { status: 422 }
    );
  }
  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteWebhookDestination(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return webhookErrorResponse(error, request);
  }
}
