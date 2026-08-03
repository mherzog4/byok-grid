import { readApiJsonBody } from '@/lib/request-body';
import {
  convertSqliteWorkspaceColumnType,
  previewSqliteColumnTypeConversion,
} from '@byok-grid/db';
import {
  columnTypeConversionPreviewRequestSchema,
  columnTypeConversionRequestSchema,
} from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

interface RouteContext {
  params: Promise<{
    columnId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const parsed = columnTypeConversionPreviewRequestSchema.safeParse({
      targetType: new URL(request.url).searchParams.get('targetType'),
    });
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid target type.' },
        { status: 400 }
      );
    }
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await previewSqliteColumnTypeConversion(sqliteDb, {
        columnId,
        tableId,
        targetType: parsed.data.targetType,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const body = await readApiJsonBody(request);
    if (body instanceof Response) return body;
    const parsed = columnTypeConversionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            parsed.error.issues[0]?.message ?? 'Invalid conversion request.',
        },
        { status: 400 }
      );
    }
    const { columnId, tableId, workspaceId } = await context.params;
    return Response.json(
      await convertSqliteWorkspaceColumnType(sqliteDb, {
        ...parsed.data,
        columnId,
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error);
  }
}
