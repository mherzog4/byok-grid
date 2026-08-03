import { updateSqliteWebhookDestination } from '@byok-grid/db';
import { webhookDestinationUpdateSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { webhookErrorResponse } from '@/lib/webhook-api';

interface RouteContext {
  params: Promise<{
    destinationId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const parsed = webhookDestinationUpdateSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json(
      { error: 'The webhook destination update is invalid.' },
      { status: 422 }
    );
  }
  try {
    const { destinationId, tableId, workspaceId } = await context.params;
    return Response.json(
      await updateSqliteWebhookDestination(sqliteDb, {
        destinationId,
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return webhookErrorResponse(error);
  }
}
