import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  acceptWorkspaceInvitation,
  CollaborationAccessError,
  CollaborationConflictError,
  CollaborationValidationError,
  createWorkspaceInvitation,
  ensurePersonalWorkspace,
  hashWorkspaceInvitationToken,
  listWorkspaceCollaboration,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  updateWorkspaceMemberRole,
} from './index';
import {
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('workspace collaboration', () => {
  it('enforces invitation identity, single use, expiry, and role boundaries', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const now = new Date('2030-01-01T12:00:00.000Z');

    try {
      const [owner, admin, member, outsider, expiredUser] = await db
        .insert(users)
        .values([
          {
            email: `owner-${crypto.randomUUID()}@example.test`,
            name: 'Workspace Owner',
          },
          {
            email: `admin-${crypto.randomUUID()}@example.test`,
            name: 'Workspace Admin',
          },
          {
            email: `member-${crypto.randomUUID()}@example.test`,
            name: 'Workspace Member',
          },
          {
            email: `outsider-${crypto.randomUUID()}@example.test`,
            name: 'Workspace Outsider',
          },
          {
            email: `expired-${crypto.randomUUID()}@example.test`,
            name: 'Expired Invitee',
          },
        ])
        .returning({ email: users.email, id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(admin).toBeDefined();
      expect(member).toBeDefined();
      expect(outsider).toBeDefined();
      expect(expiredUser).toBeDefined();
      userIds.push(
        owner!.id,
        admin!.id,
        member!.id,
        outsider!.id,
        expiredUser!.id
      );

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);

      const adminInvitation = await createWorkspaceInvitation(
        db,
        {
          email: admin!.email.toUpperCase(),
          role: 'admin',
          userId: owner!.id,
          workspaceId: workspace.id,
        },
        now
      );
      const [storedInvitation] = await db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.id, adminInvitation.id));
      expect(storedInvitation).toMatchObject({
        email: admin!.email,
        role: 'admin',
        tokenHash: hashWorkspaceInvitationToken(adminInvitation.token),
      });
      expect(JSON.stringify(storedInvitation)).not.toContain(
        adminInvitation.token
      );

      await expect(
        createWorkspaceInvitation(
          db,
          {
            email: admin!.email,
            role: 'admin',
            userId: owner!.id,
            workspaceId: workspace.id,
          },
          now
        )
      ).rejects.toBeInstanceOf(CollaborationConflictError);

      await expect(
        acceptWorkspaceInvitation(
          db,
          {
            email: outsider!.email,
            token: adminInvitation.token,
            userId: outsider!.id,
          },
          now
        )
      ).rejects.toBeInstanceOf(CollaborationValidationError);

      await expect(
        Promise.allSettled([
          acceptWorkspaceInvitation(
            db,
            {
              email: admin!.email,
              token: adminInvitation.token,
              userId: admin!.id,
            },
            now
          ),
          acceptWorkspaceInvitation(
            db,
            {
              email: admin!.email,
              token: adminInvitation.token,
              userId: admin!.id,
            },
            now
          ),
        ])
      ).resolves.toSatisfy(
        (results: PromiseSettledResult<unknown>[]) =>
          results.filter((result) => result.status === 'fulfilled').length ===
            1 &&
          results.filter((result) => result.status === 'rejected').length === 1
      );

      await expect(
        createWorkspaceInvitation(
          db,
          {
            email: outsider!.email,
            role: 'admin',
            userId: admin!.id,
            workspaceId: workspace.id,
          },
          now
        )
      ).rejects.toBeInstanceOf(CollaborationAccessError);

      const memberInvitation = await createWorkspaceInvitation(
        db,
        {
          email: member!.email,
          role: 'member',
          userId: admin!.id,
          workspaceId: workspace.id,
        },
        now
      );
      await acceptWorkspaceInvitation(
        db,
        {
          email: member!.email,
          token: memberInvitation.token,
          userId: member!.id,
        },
        now
      );

      await expect(
        listWorkspaceCollaboration(db, {
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CollaborationAccessError);
      await expect(
        createWorkspaceInvitation(
          db,
          {
            email: outsider!.email,
            role: 'member',
            userId: member!.id,
            workspaceId: workspace.id,
          },
          now
        )
      ).rejects.toBeInstanceOf(CollaborationAccessError);

      const pendingInvitation = await createWorkspaceInvitation(
        db,
        {
          email: outsider!.email,
          role: 'member',
          userId: admin!.id,
          workspaceId: workspace.id,
        },
        now
      );
      await revokeWorkspaceInvitation(
        db,
        {
          invitationId: pendingInvitation.id,
          userId: admin!.id,
          workspaceId: workspace.id,
        },
        now
      );
      await expect(
        acceptWorkspaceInvitation(
          db,
          {
            email: outsider!.email,
            token: pendingInvitation.token,
            userId: outsider!.id,
          },
          now
        )
      ).rejects.toBeInstanceOf(CollaborationValidationError);

      const expiredInvitation = await createWorkspaceInvitation(
        db,
        {
          email: expiredUser!.email,
          role: 'member',
          userId: owner!.id,
          workspaceId: workspace.id,
        },
        now
      );
      await expect(
        acceptWorkspaceInvitation(
          db,
          {
            email: expiredUser!.email,
            token: expiredInvitation.token,
            userId: expiredUser!.id,
          },
          new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000)
        )
      ).rejects.toBeInstanceOf(CollaborationValidationError);

      const collaboration = await listWorkspaceCollaboration(
        db,
        { userId: owner!.id, workspaceId: workspace.id },
        now
      );
      expect(collaboration.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'owner', userId: owner!.id }),
          expect.objectContaining({ role: 'admin', userId: admin!.id }),
          expect.objectContaining({ role: 'member', userId: member!.id }),
        ])
      );
      expect(JSON.stringify(collaboration)).not.toContain(
        adminInvitation.token
      );

      await expect(
        updateWorkspaceMemberRole(db, {
          role: 'admin',
          targetUserId: member!.id,
          userId: admin!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CollaborationAccessError);
      await updateWorkspaceMemberRole(db, {
        role: 'member',
        targetUserId: admin!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await removeWorkspaceMember(db, {
        targetUserId: member!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const remainingMemberIds = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspace.id));
      expect(remainingMemberIds.map((item) => item.userId)).not.toContain(
        member!.id
      );
      await expect(
        removeWorkspaceMember(db, {
          targetUserId: owner!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CollaborationAccessError);
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
