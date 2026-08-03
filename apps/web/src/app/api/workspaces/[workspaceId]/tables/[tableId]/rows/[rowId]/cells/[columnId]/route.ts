import { readApiJsonBody } from '@/lib/request-body';
import { writeSqliteGridCell } from '@byok-grid/db';
import { editableCellValueSchema } from '@byok-grid/domain';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const writeCellSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  value: editableCellValueSchema,
});

interface RouteContext {
  params: Promise<{
    columnId: string;
    rowId: string;
    tableId: string;
    workspaceId: string;
  }>;
}

export async function PUT(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = writeCellSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The cell value is invalid.' },
      { status: 400 }
    );
  }

  try {
    const { columnId, rowId, tableId, workspaceId } = await context.params;
    return Response.json(
      await writeSqliteGridCell(sqliteDb, {
        columnId,
        expectedVersion: parsed.data.expectedVersion,
        rowId,
        tableId,
        userId: user.id,
        value: parsed.data.value,
        workspaceId,
      })
    );
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}
