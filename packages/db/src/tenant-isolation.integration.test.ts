import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase } from './client';
import { cells, columns, dataTables, rows, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('tenant isolation constraints', () => {
  it('rejects a cell whose column belongs to another workspace', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const workspaceIds: string[] = [];

    try {
      const [workspaceA, workspaceB] = await db
        .insert(workspaces)
        .values([
          { name: 'Isolation A', slug: `isolation-a-${crypto.randomUUID()}` },
          { name: 'Isolation B', slug: `isolation-b-${crypto.randomUUID()}` },
        ])
        .returning({ id: workspaces.id });

      expect(workspaceA).toBeDefined();
      expect(workspaceB).toBeDefined();
      workspaceIds.push(workspaceA!.id, workspaceB!.id);

      const [tableA, tableB] = await db
        .insert(dataTables)
        .values([
          { workspaceId: workspaceA!.id, name: 'Table A' },
          { workspaceId: workspaceB!.id, name: 'Table B' },
        ])
        .returning({ id: dataTables.id });

      const [rowA] = await db
        .insert(rows)
        .values({
          workspaceId: workspaceA!.id,
          tableId: tableA!.id,
          position: 'a0',
        })
        .returning({ id: rows.id });

      const [columnB] = await db
        .insert(columns)
        .values({
          workspaceId: workspaceB!.id,
          tableId: tableB!.id,
          name: 'Foreign column',
          kind: 'input',
          valueType: 'text',
          position: 'a0',
        })
        .returning({ id: columns.id });

      await expect(
        db.insert(cells).values({
          workspaceId: workspaceA!.id,
          tableId: tableA!.id,
          rowId: rowA!.id,
          columnId: columnB!.id,
          valueType: 'text',
          valueText: 'must never cross this boundary',
        })
      ).rejects.toMatchObject({
        cause: {
          code: '23503',
          constraint_name: 'cells_column_scope_fk',
        },
      });
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      await client.end();
    }
  });
});
