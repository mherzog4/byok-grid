import { getSqliteGridSnapshot, type SqliteGridCell } from '@byok-grid/db';
import { formatCsvField } from '@/lib/csv';
import { getApiUser, gridErrorResponse } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const { tableId, workspaceId } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const searchQuery = searchParams.get('search');
  const viewId = searchParams.get('view');

  try {
    const firstPage = await getSqliteGridSnapshot(
      sqliteDb,
      { tableId, userId: user.id, workspaceId },
      { limit: 200, searchQuery, viewId }
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              `${firstPage.columns.map((column) => formatCsvField(column.name)).join(',')}\r\n`
            )
          );
          let page = firstPage;
          while (true) {
            if (request.signal.aborted) break;
            for (const row of page.rows) {
              const fields = page.columns.map((column) =>
                formatCsvField(formatExportCell(row.cells[column.id]))
              );
              controller.enqueue(encoder.encode(`${fields.join(',')}\r\n`));
            }
            if (!page.pageInfo.nextCursor) break;
            page = await getSqliteGridSnapshot(
              sqliteDb,
              { tableId, userId: user.id, workspaceId },
              {
                cursor: page.pageInfo.nextCursor,
                limit: 200,
                searchQuery,
                viewId,
              }
            );
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const filenameParts = [firstPage.table.name, firstPage.activeView?.name]
      .filter(Boolean)
      .join('-');
    const safeFilename = `${filenameParts.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'table'}.csv`;
    return new Response(stream, {
      headers: {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${safeFilename}"`,
        'content-type': 'text/csv; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return gridErrorResponse(error, request);
  }
}

function formatExportCell(cell: SqliteGridCell | undefined): string {
  if (!cell || cell.value.type === 'empty') return '';
  if (cell.value.type === 'json') return JSON.stringify(cell.value.value);
  return String(cell.value.value);
}
