import { createSqliteWorkspaceTable } from '@byok-grid/db';
import { createTableRequestSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const parsed = createTableRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid table.' },
        { status: 400 }
      );
    }
    const { workspaceId } = await context.params;
    return Response.json(
      await createSqliteWorkspaceTable(sqliteDb, {
        ...parsed.data,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}
