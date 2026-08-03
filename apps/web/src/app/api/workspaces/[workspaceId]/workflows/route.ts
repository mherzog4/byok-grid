import { createSqliteWorkflow, listSqliteWorkflows } from '@byok-grid/db';
import { workflowDefinitionRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { workflowErrorResponse } from '@/lib/workflow-api';

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await listSqliteWorkflows(sqliteDb, {
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return workflowErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const body = workflowDefinitionRequestSchema.parse(
      await request.json().catch(() => null)
    );
    const { workspaceId } = await context.params;
    return Response.json(
      await createSqliteWorkflow(sqliteDb, {
        ...body,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return workflowErrorResponse(error);
  }
}
