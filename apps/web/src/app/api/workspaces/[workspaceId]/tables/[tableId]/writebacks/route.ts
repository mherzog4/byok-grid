import {
  createSqliteWritebackDestination,
  listSqliteWritebackDestinations,
} from '@byok-grid/db';
import { writebackDestinationRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { writebackErrorResponse } from '@/lib/writeback-api';
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
      await listSqliteWritebackDestinations(sqliteDb, {
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return writebackErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const parsed = writebackDestinationRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          'The writeback destination is invalid.',
      },
      { status: 422 }
    );
  }
  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteWritebackDestination(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return writebackErrorResponse(error);
  }
}
