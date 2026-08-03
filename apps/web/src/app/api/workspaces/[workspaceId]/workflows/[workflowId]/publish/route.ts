import { publishSqliteWorkflow } from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { workflowErrorResponse } from '@/lib/workflow-api';
import { z } from 'zod';

const publishRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});

interface RouteContext {
  params: Promise<{ workflowId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const body = publishRequestSchema.parse(
      await request.json().catch(() => null)
    );
    const { workflowId, workspaceId } = await context.params;
    return Response.json(
      await publishSqliteWorkflow(sqliteDb, {
        expectedRevision: body.expectedRevision,
        userId: user.id,
        workflowId,
        workspaceId,
      })
    );
  } catch (error) {
    return workflowErrorResponse(error);
  }
}
