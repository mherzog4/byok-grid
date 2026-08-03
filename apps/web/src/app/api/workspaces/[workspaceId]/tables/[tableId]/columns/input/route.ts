import { createSqliteInputColumn } from '@byok-grid/db';
import { createInputColumnRequestSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const parsed = createInputColumnRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid column.' },
        { status: 400 }
      );
    }
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteInputColumn(sqliteDb, {
        ...parsed.data,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}
