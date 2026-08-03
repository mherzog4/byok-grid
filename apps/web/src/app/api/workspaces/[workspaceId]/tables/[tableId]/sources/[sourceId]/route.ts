import { readApiJsonBody } from '@/lib/request-body';
import { setSqliteSourceStatus } from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { sourceErrorResponse } from '@/lib/source-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const updateSourceSchema = z.strictObject({
  status: z.enum(['active', 'paused']),
});

interface RouteContext {
  params: Promise<{ sourceId: string; tableId: string; workspaceId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSourceSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The source status is invalid.' },
      { status: 422 }
    );
  }
  try {
    const { sourceId, tableId, workspaceId } = await context.params;
    return Response.json(
      await setSqliteSourceStatus(sqliteDb, {
        sourceId,
        status: parsed.data.status,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return sourceErrorResponse(error, request);
  }
}
