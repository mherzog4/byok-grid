import { readApiJsonBody } from '@/lib/request-body';
import { getSqliteWorkflow, updateSqliteWorkflowDraft } from '@byok-grid/db';
import { workflowDraftUpdateRequestSchema } from '@byok-grid/domain';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { workflowErrorResponse } from '@/lib/workflow-api';

interface RouteContext {
  params: Promise<{ workflowId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { workflowId, workspaceId } = await context.params;
    return Response.json(
      await getSqliteWorkflow(sqliteDb, {
        userId: user.id,
        workflowId,
        workspaceId,
      })
    );
  } catch (error) {
    return workflowErrorResponse(error, request);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const rawBody = await readApiJsonBody(request);
    if (rawBody instanceof Response) return rawBody;
    const body = workflowDraftUpdateRequestSchema.parse(rawBody);
    const { workflowId, workspaceId } = await context.params;
    return Response.json(
      await updateSqliteWorkflowDraft(sqliteDb, {
        ...body,
        userId: user.id,
        workflowId,
        workspaceId,
      })
    );
  } catch (error) {
    return workflowErrorResponse(error, request);
  }
}
