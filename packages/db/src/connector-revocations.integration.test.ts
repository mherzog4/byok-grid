import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  ConnectorRevocationAccessError,
  ConnectorRevocationConflictError,
  ConnectorRevokedError,
  ConnectorRevocationValidationError,
  createConnectorActionColumn,
  createGridRow,
  createWorkspaceConnectorRevocation,
  createWorkspaceTable,
  ensurePersonalWorkspace,
  liftWorkspaceConnectorRevocation,
  listWorkspaceConnectorRevocations,
  queueEnrichmentCellRun,
  writeGridCell,
} from './index';
import {
  cellRuns,
  connectorRevocations,
  users,
  workspaceMembers,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;
const artifactSha256 = 'a'.repeat(64);
const registrySha256 = 'b'.repeat(64);

describe.skipIf(!testDatabaseUrl)('connector trust revocations', () => {
  it('pins run provenance and enforces revocation before queueing', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, member] = await db
        .insert(users)
        .values([
          {
            email: `trust-owner-${crypto.randomUUID()}@example.test`,
            name: 'Trust Owner',
          },
          {
            email: `trust-member-${crypto.randomUUID()}@example.test`,
            name: 'Trust Member',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(member).toBeDefined();
      userIds.push(owner!.id, member!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      await db.insert(workspaceMembers).values({
        role: 'member',
        userId: member!.id,
        workspaceId: workspace.id,
      });
      const table = await createWorkspaceTable(db, {
        firstColumnName: 'Domain',
        firstColumnValueType: 'text',
        name: 'Connector trust',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const connectorColumn = await createConnectorActionColumn(db, {
        actionId: 'lookup',
        artifactSha256,
        connectorId: 'community_lookup',
        connectorVersion: '1.2.3',
        credentialId: null,
        inputBindings: {
          domain: { columnId: table.firstColumn.id, kind: 'column' },
        },
        name: 'Community result',
        outputValueType: 'text',
        protocolVersion: '1.1',
        publisherKeyIds: ['publisher_old', 'publisher_new'],
        registrySha256,
        tableId: table.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const firstRow = await createGridRow(db, {
        tableId: table.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: table.firstColumn.id,
        expectedVersion: 0,
        rowId: firstRow.id,
        tableId: table.id,
        userId: owner!.id,
        value: { type: 'text', value: 'example.com' },
        workspaceId: workspace.id,
      });
      const queued = await queueEnrichmentCellRun(db, {
        columnId: connectorColumn.id,
        rowId: firstRow.id,
        tableId: table.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const [storedRun] = await db
        .select({
          artifactSha256: cellRuns.artifactSha256,
          publisherKeyIds: cellRuns.publisherKeyIds,
          registrySha256: cellRuns.registrySha256,
        })
        .from(cellRuns)
        .where(eq(cellRuns.id, queued.runId));
      expect(storedRun).toEqual({
        artifactSha256,
        publisherKeyIds: ['publisher_old', 'publisher_new'],
        registrySha256,
      });

      await expect(
        createWorkspaceConnectorRevocation(db, {
          reason: 'Member should not control connector trust.',
          target: { artifactSha256, kind: 'artifact' },
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(ConnectorRevocationAccessError);
      const revocation = await createWorkspaceConnectorRevocation(db, {
        reason: 'Artifact is under incident investigation.',
        target: { artifactSha256, kind: 'artifact' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        createWorkspaceConnectorRevocation(db, {
          reason: 'Duplicate incident record should not be created.',
          target: { artifactSha256, kind: 'artifact' },
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(ConnectorRevocationConflictError);

      const secondRow = await createGridRow(db, {
        tableId: table.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: table.firstColumn.id,
        expectedVersion: 0,
        rowId: secondRow.id,
        tableId: table.id,
        userId: owner!.id,
        value: { type: 'text', value: 'example.org' },
        workspaceId: workspace.id,
      });
      await expect(
        queueEnrichmentCellRun(db, {
          columnId: connectorColumn.id,
          rowId: secondRow.id,
          tableId: table.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(ConnectorRevokedError);
      expect(
        await listWorkspaceConnectorRevocations(db, {
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).toEqual([
        expect.objectContaining({ id: revocation.id, liftedAt: null }),
      ]);

      await expect(
        liftWorkspaceConnectorRevocation(db, {
          confirmationTargetKey: 'artifact:wrong',
          revocationId: revocation.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(ConnectorRevocationValidationError);
      await liftWorkspaceConnectorRevocation(db, {
        confirmationTargetKey: revocation.targetKey,
        revocationId: revocation.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        queueEnrichmentCellRun(db, {
          columnId: connectorColumn.id,
          rowId: secondRow.id,
          tableId: table.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).resolves.toMatchObject({ status: 'queued' });

      await db.delete(users).where(eq(users.id, owner!.id));
      userIds.splice(userIds.indexOf(owner!.id), 1);
      const [retainedIncident] = await db
        .select({
          createdByUserId: connectorRevocations.createdByUserId,
          liftedAt: connectorRevocations.liftedAt,
          liftedByUserId: connectorRevocations.liftedByUserId,
        })
        .from(connectorRevocations)
        .where(eq(connectorRevocations.id, revocation.id));
      expect(retainedIncident).toMatchObject({
        createdByUserId: null,
        liftedByUserId: null,
      });
      expect(retainedIncident?.liftedAt).toBeInstanceOf(Date);
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

describe.skipIf(!testDatabaseUrl || !rlsDatabaseUrl)(
  'connector trust row-level security',
  () => {
    it('isolates revocations through the forced-RLS web role', async () => {
      const admin = createDatabase(testDatabaseUrl!);
      const web = createDatabase(rlsDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];

      try {
        const [ownerA, ownerB] = await admin.db
          .insert(users)
          .values([
            {
              email: `trust-rls-a-${crypto.randomUUID()}@example.test`,
              name: 'Trust RLS A',
            },
            {
              email: `trust-rls-b-${crypto.randomUUID()}@example.test`,
              name: 'Trust RLS B',
            },
          ])
          .returning({ id: users.id, name: users.name });
        userIds.push(ownerA!.id, ownerB!.id);
        const workspaceA = await ensurePersonalWorkspace(admin.db, ownerA!);
        const workspaceB = await ensurePersonalWorkspace(admin.db, ownerB!);
        workspaceIds.push(workspaceA.id, workspaceB.id);

        await withAuthenticatedDatabase(web.db, ownerA!.id, (scopedDb) =>
          createWorkspaceConnectorRevocation(scopedDb, {
            reason: 'Workspace A emergency connector block.',
            target: { connectorId: 'community_lookup', kind: 'connector' },
            userId: ownerA!.id,
            workspaceId: workspaceA.id,
          })
        );
        const visibleToA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            listWorkspaceConnectorRevocations(scopedDb, {
              userId: ownerA!.id,
              workspaceId: workspaceA.id,
            })
        );
        expect(visibleToA).toHaveLength(1);
        const visibleToB = await withAuthenticatedDatabase(
          web.db,
          ownerB!.id,
          (scopedDb) =>
            listWorkspaceConnectorRevocations(scopedDb, {
              userId: ownerB!.id,
              workspaceId: workspaceB.id,
            })
        );
        expect(visibleToB).toEqual([]);
      } finally {
        if (workspaceIds.length > 0) {
          await admin.db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await admin.db.delete(users).where(inArray(users.id, userIds));
        }
        await Promise.all([admin.client.end(), web.client.end()]);
      }
    });
  }
);
