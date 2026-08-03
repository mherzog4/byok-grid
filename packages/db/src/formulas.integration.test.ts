import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createFormulaColumn,
  createGridRow,
  ensurePersonalWorkspace,
  FormulaAccessError,
  FormulaValidationError,
  getGridSnapshot,
  listWorkspaceTables,
  writeGridCell,
} from './index';
import { columns, users, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('formula columns', () => {
  it('backfills rows and atomically recomputes a formula dependency chain', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `formula-owner-${crypto.randomUUID()}@example.test`,
            name: 'Formula Owner',
          },
          {
            email: `formula-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Formula Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(outsider).toBeDefined();
      userIds.push(owner!.id, outsider!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const sourceColumns = await db
        .select({ id: columns.id, name: columns.name })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, table!.id),
            eq(columns.workspaceId, workspace.id)
          )
        );
      const company = sourceColumns.find((column) => column.name === 'Company');
      const domain = sourceColumns.find((column) => column.name === 'Domain');
      expect(company).toBeDefined();
      expect(domain).toBeDefined();

      const row = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: domain!.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'ACME.EXAMPLE' },
        workspaceId: workspace.id,
      });

      const label = await createFormulaColumn(db, {
        expression: {
          type: 'call',
          function: 'concat',
          args: [
            { type: 'column', columnId: company!.id },
            { type: 'literal', value: { type: 'text', value: ' · ' } },
            { type: 'column', columnId: domain!.id },
          ],
        },
        name: 'Company label',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const normalized = await createFormulaColumn(db, {
        expression: {
          type: 'call',
          function: 'lower',
          args: [{ type: 'column', columnId: label.id }],
        },
        name: 'Normalized label',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const sourceAuthored = await createFormulaColumn(db, {
        name: 'Source authored',
        source: 'CONCAT(UPPER([Company]), " / ", LOWER([Domain]))',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        createFormulaColumn(db, {
          name: 'Invalid source',
          source: 'LOWER([Missing])',
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(FormulaValidationError);

      let snapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(snapshot.rows[0]?.cells[label.id]?.value).toEqual({
        type: 'text',
        value: 'Acme · ACME.EXAMPLE',
      });
      expect(snapshot.rows[0]?.cells[normalized.id]?.value).toEqual({
        type: 'text',
        value: 'acme · acme.example',
      });
      expect(snapshot.rows[0]?.cells[sourceAuthored.id]?.value).toEqual({
        type: 'text',
        value: 'ACME / acme.example',
      });

      await writeGridCell(db, {
        columnId: domain!.id,
        expectedVersion: snapshot.rows[0]!.cells[domain!.id]!.version,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'NEW.EXAMPLE' },
        workspaceId: workspace.id,
      });
      snapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(snapshot.rows[0]?.cells[label.id]?.value).toEqual({
        type: 'text',
        value: 'Acme · NEW.EXAMPLE',
      });
      expect(snapshot.rows[0]?.cells[normalized.id]?.value).toEqual({
        type: 'text',
        value: 'acme · new.example',
      });
      expect(snapshot.rows[0]?.cells[sourceAuthored.id]?.value).toEqual({
        type: 'text',
        value: 'ACME / new.example',
      });

      await expect(
        createFormulaColumn(db, {
          expression: { type: 'column', columnId: company!.id },
          name: 'Stolen formula',
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(FormulaAccessError);
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      await client.end();
    }
  });
});
