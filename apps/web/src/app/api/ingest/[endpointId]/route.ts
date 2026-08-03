import {
  getSqliteIngestionEndpointCapability,
  hashSqliteIngestionToken,
  stageSqliteIngestionBatch,
} from '@byok-grid/db';
import {
  entityIdSchema,
  ingestionIdempotencyKeySchema,
  MAXIMUM_INGESTION_BODY_BYTES,
  MAXIMUM_INGESTION_RECORDS,
  normalizeIngestionEnvelope,
  SourceResponseError,
} from '@byok-grid/domain';
import { createHash } from 'node:crypto';
import { sqliteDb } from '@/lib/sqlite-database';
import {
  ingestionErrorResponse,
  readIngestionBearerToken,
  readBoundedJsonBody,
} from '@/lib/ingestion-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ endpointId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const token = readIngestionBearerToken(request);
  if (!token) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const endpointId = entityIdSchema.safeParse(
    (await context.params).endpointId
  );
  if (!endpointId.success) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  try {
    const capability = await getSqliteIngestionEndpointCapability(sqliteDb, {
      endpointId: endpointId.data,
      tokenHash: hashSqliteIngestionToken(token),
    });
    return Response.json(
      {
        ...capability,
        maximumBodyBytes: MAXIMUM_INGESTION_BODY_BYTES,
        maximumRecords: MAXIMUM_INGESTION_RECORDS,
        status: 'active',
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return ingestionErrorResponse(error, request);
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    return Response.json(
      { error: 'Content-Type must be application/json.' },
      { status: 415 }
    );
  }
  const token = readIngestionBearerToken(request);
  if (!token) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const idempotency = ingestionIdempotencyKeySchema.safeParse(
    request.headers.get('idempotency-key')
  );
  if (!idempotency.success) {
    return Response.json(
      {
        error:
          idempotency.error.issues[0]?.message ??
          'An idempotency key is required.',
      },
      { status: 422 }
    );
  }

  try {
    const rawEndpointId = (await context.params).endpointId;
    const parsedEndpointId = entityIdSchema.safeParse(rawEndpointId);
    if (!parsedEndpointId.success) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const endpointId = parsedEndpointId.data;
    const tokenHash = hashSqliteIngestionToken(token);
    const endpoint = await getSqliteIngestionEndpointCapability(sqliteDb, {
      endpointId,
      tokenHash,
    });
    const raw = await readBoundedJsonBody(request);
    let batch;
    try {
      batch = normalizeIngestionEnvelope(raw.body, endpoint.recordKeyField);
    } catch (error) {
      if (error instanceof SourceResponseError) {
        return Response.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }
    const staged = await stageSqliteIngestionBatch(sqliteDb, {
      batch,
      endpointId,
      idempotencyKey: idempotency.data,
      requestDigest: createHash('sha256').update(raw.bytes).digest('hex'),
      tokenHash,
    });
    return Response.json(staged, {
      headers: {
        'cache-control': 'no-store',
        location: `/api/ingest/${endpointId}/batches/${staged.id}`,
      },
      status: 202,
    });
  } catch (error) {
    return ingestionErrorResponse(error, request);
  }
}
