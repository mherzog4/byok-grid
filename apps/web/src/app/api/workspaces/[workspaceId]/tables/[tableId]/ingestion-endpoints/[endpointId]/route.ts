import { revokeSqliteIngestionEndpoint } from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { ingestionErrorResponse } from '@/lib/ingestion-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{
    endpointId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { endpointId, tableId, workspaceId } = await context.params;
    return Response.json(
      await revokeSqliteIngestionEndpoint(sqliteDb, {
        endpointId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
