import { readApiJsonBody } from '@/lib/request-body';
import { queueSqliteWebhookDelivery } from '@byok-grid/db';
import { webhookDeliveryRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { webhookErrorResponse } from '@/lib/webhook-api';
import { z } from 'zod';

const queueDeliverySchema = webhookDeliveryRequestSchema.extend({
  rowId: z.string().uuid(),
});

interface RouteContext {
  params: Promise<{
    destinationId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = queueDeliverySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The webhook delivery request is invalid.' },
      { status: 422 }
    );
  }
  try {
    const { destinationId, tableId, workspaceId } = await context.params;
    return Response.json(
      await queueSqliteWebhookDelivery(sqliteDb, {
        deliveryId: parsed.data.deliveryId,
        destinationId,
        rowId: parsed.data.rowId,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 202 }
    );
  } catch (error) {
    return webhookErrorResponse(error);
  }
}
