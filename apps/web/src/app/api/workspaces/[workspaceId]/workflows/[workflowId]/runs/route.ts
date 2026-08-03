import { readApiJsonBody } from '@/lib/request-body';
import { createSqliteWorkflowRun, listSqliteWorkflowRuns } from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { workflowErrorResponse } from '@/lib/workflow-api';
import { z } from 'zod';

const runRequestSchema = z.strictObject({
  input: z.record(z.string(), z.json()).default({}),
});

interface RouteContext {
  params: Promise<{ workflowId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { workflowId, workspaceId } = await context.params;
    return Response.json(
      await listSqliteWorkflowRuns(sqliteDb, {
        limit: 20,
        userId: user.id,
        workflowId,
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
    const rawBody = await readApiJsonBody(request);
    if (rawBody instanceof Response) return rawBody;
    const body = runRequestSchema.parse(rawBody ?? {});
    const { workflowId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteWorkflowRun(sqliteDb, {
        runInput: body.input,
        userId: user.id,
        workflowId,
        workspaceId,
      }),
      { status: 202 }
    );
  } catch (error) {
    return workflowErrorResponse(error);
  }
}
