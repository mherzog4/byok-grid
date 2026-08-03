import {
  getSqliteIngestionBatchStatus,
  hashSqliteIngestionToken,
} from '@byok-grid/db';
import { entityIdSchema } from '@byok-grid/domain';
import { sqliteDb } from '@/lib/sqlite-database';
import {
  ingestionErrorResponse,
  readIngestionBearerToken,
} from '@/lib/ingestion-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ batchId: string; endpointId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const token = readIngestionBearerToken(request);
  if (!token) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const parameters = await context.params;
  const endpointId = entityIdSchema.safeParse(parameters.endpointId);
  const batchId = entityIdSchema.safeParse(parameters.batchId);
  if (!endpointId.success || !batchId.success) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  try {
    return Response.json(
      await getSqliteIngestionBatchStatus(sqliteDb, {
        batchId: batchId.data,
        endpointId: endpointId.data,
        tokenHash: hashSqliteIngestionToken(token),
      }),
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return ingestionErrorResponse(error, request);
  }
}
