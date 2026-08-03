import {
  createSqliteHttpJsonSource,
  createSqliteHubSpotContactsSource,
  listSqliteSources,
} from '@byok-grid/db';
import {
  httpJsonSourceRequestSchema,
  hubSpotContactsSourceRequestSchema,
} from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sourceErrorResponse } from '@/lib/source-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await listSqliteSources(sqliteDb, {
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return sourceErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const raw = await request.json().catch(() => null);
  const hubSpotRequest =
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'adapterId' in raw &&
    raw.adapterId === 'hubspot_contacts';
  const candidate = hubSpotRequest
    ? Object.fromEntries(
        Object.entries(raw).filter(([key]) => key !== 'adapterId')
      )
    : raw;
  const parsed = hubSpotRequest
    ? hubSpotContactsSourceRequestSchema.safeParse(candidate)
    : httpJsonSourceRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'The source is invalid.' },
      { status: 422 }
    );
  }
  try {
    const { tableId, workspaceId } = await context.params;
    const source = hubSpotRequest
      ? await createSqliteHubSpotContactsSource(sqliteDb, {
          ...hubSpotContactsSourceRequestSchema.parse(candidate),
          tableId,
          userId: user.id,
          workspaceId,
        })
      : await createSqliteHttpJsonSource(sqliteDb, {
          ...httpJsonSourceRequestSchema.parse(candidate),
          tableId,
          userId: user.id,
          workspaceId,
        });
    return Response.json(source, { status: 201 });
  } catch (error) {
    return sourceErrorResponse(error);
  }
}
