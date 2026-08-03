import { readApiJsonBody } from '@/lib/request-body';
import { queueSqliteWritebackDelivery } from '@byok-grid/db';
import { writebackDeliveryRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { writebackErrorResponse } from '@/lib/writeback-api';
import { sqliteDb } from '@/lib/sqlite-database';

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
  const parsed = writebackDeliveryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The writeback delivery request is invalid.' },
      { status: 422 }
    );
  }
  try {
    const { destinationId, tableId, workspaceId } = await context.params;
    return Response.json(
      await queueSqliteWritebackDelivery(sqliteDb, {
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
    return writebackErrorResponse(error);
  }
}
