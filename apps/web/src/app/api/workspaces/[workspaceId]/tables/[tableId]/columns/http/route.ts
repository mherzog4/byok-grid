import { readApiJsonBody } from '@/lib/request-body';
import { createSqliteHttpEnrichmentColumn } from '@byok-grid/db';
import { enrichmentErrorResponse } from '@/lib/enrichment-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const createColumnSchema = z.object({
  baseUrl: z.url(),
  credentialId: z.uuid().nullable(),
  inputColumnId: z.uuid(),
  name: z.string().min(1).max(120),
  queryParameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  runMode: z.enum(['manual', 'on_change']).default('manual'),
});

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = createColumnSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The column configuration is invalid.' },
      { status: 400 }
    );
  }

  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteHttpEnrichmentColumn(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}
