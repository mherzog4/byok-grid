import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptSqliteWorkspaceInvitation,
  createSqliteWorkspaceInvitation,
  hashSqliteWorkspaceInvitationToken,
  listSqliteWorkspaceCollaboration,
  removeSqliteWorkspaceMember,
  revokeSqliteWorkspaceInvitation,
  SqliteCollaborationAccessError,
  SqliteCollaborationConflictError,
  SqliteCollaborationValidationError,
  updateSqliteWorkspaceMemberRole,
} from './collaboration';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';

const ownerId = 'user-owner';
const adminId = 'user-admin';
const memberId = 'user-member';
const outsiderId = 'user-outsider';
const expiredUserId = 'user-expired';
const workspaceId = 'workspace-a';
const now = new Date('2030-01-01T12:00:00.000Z');

describe('SQLite workspace collaboration', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-collaboration-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);

    for (const [sql, args] of [
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [ownerId, 'owner@example.test', 'Workspace Owner'],
      ],
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [adminId, 'admin@example.test', 'Workspace Admin'],
      ],
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [memberId, 'member@example.test', 'Workspace Member'],
      ],
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [outsiderId, 'outsider@example.test', 'Workspace Outsider'],
      ],
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [expiredUserId, 'expired@example.test', 'Expired Invitee'],
      ],
      [
        'insert into workspaces (id, name, slug) values (?, ?, ?)',
        [workspaceId, 'Workspace A', 'workspace-a'],
      ],
      [
        'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
        [workspaceId, ownerId, 'owner'],
      ],
    ] as Array<[string, string[]]>) {
      await handle.client.execute({ args, sql });
    }
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('normalizes identity and persists only a digest of the bearer token', async () => {
    const invitation = await createSqliteWorkspaceInvitation(
      handle.db,
      {
        email: '  ADMIN@EXAMPLE.TEST ',
        role: 'admin',
        userId: ownerId,
        workspaceId,
      },
      now
    );

    const stored = await handle.client.execute({
      args: [invitation.id],
      sql: 'select email, role, token_hash from workspace_invitations where id = ?',
    });
    expect(stored.rows[0]).toMatchObject({
      email: 'admin@example.test',
      role: 'admin',
      token_hash: hashSqliteWorkspaceInvitationToken(invitation.token),
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(invitation.token);

    await expect(
      createSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'admin@example.test',
          role: 'admin',
          userId: ownerId,
          workspaceId,
        },
        now
      )
    ).rejects.toBeInstanceOf(SqliteCollaborationConflictError);

    await expect(
      acceptSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'outsider@example.test',
          token: invitation.token,
          userId: outsiderId,
        },
        now
      )
    ).rejects.toBeInstanceOf(SqliteCollaborationValidationError);
  });

  it('allows exactly one concurrent acceptance through a shared application handle', async () => {
    const invitation = await createSqliteWorkspaceInvitation(
      handle.db,
      {
        email: 'admin@example.test',
        role: 'admin',
        userId: ownerId,
        workspaceId,
      },
      now
    );
    const results = await Promise.allSettled([
      acceptSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'admin@example.test',
          token: invitation.token,
          userId: adminId,
        },
        now
      ),
      acceptSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'admin@example.test',
          token: invitation.token,
          userId: adminId,
        },
        now
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    const memberships = await handle.client.execute({
      args: [workspaceId, adminId],
      sql: 'select role from workspace_members where workspace_id = ? and user_id = ?',
    });
    expect(memberships.rows).toEqual([
      expect.objectContaining({ role: 'admin' }),
    ]);
  });

  it('replaces expired invitations while invalidating the old token', async () => {
    const expired = await createSqliteWorkspaceInvitation(
      handle.db,
      {
        email: 'expired@example.test',
        role: 'member',
        userId: ownerId,
        workspaceId,
      },
      now
    );
    const eightDaysLater = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    const replacement = await createSqliteWorkspaceInvitation(
      handle.db,
      {
        email: 'expired@example.test',
        role: 'member',
        userId: ownerId,
        workspaceId,
      },
      eightDaysLater
    );

    expect(replacement.id).not.toBe(expired.id);
    await expect(
      acceptSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'expired@example.test',
          token: expired.token,
          userId: expiredUserId,
        },
        eightDaysLater
      )
    ).rejects.toBeInstanceOf(SqliteCollaborationValidationError);
    await expect(
      acceptSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'expired@example.test',
          token: replacement.token,
          userId: expiredUserId,
        },
        eightDaysLater
      )
    ).resolves.toMatchObject({ role: 'member', id: workspaceId });
  });

  it('enforces role boundaries for listing, invitations, changes, and removal', async () => {
    await handle.client.execute({
      args: [workspaceId, adminId, 'admin'],
      sql: 'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
    });
    await handle.client.execute({
      args: [workspaceId, memberId, 'member'],
      sql: 'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
    });

    await expect(
      createSqliteWorkspaceInvitation(
        handle.db,
        {
          email: 'outsider@example.test',
          role: 'admin',
          userId: adminId,
          workspaceId,
        },
        now
      )
    ).rejects.toBeInstanceOf(SqliteCollaborationAccessError);

    const pending = await createSqliteWorkspaceInvitation(
      handle.db,
      {
        email: 'outsider@example.test',
        role: 'member',
        userId: adminId,
        workspaceId,
      },
      now
    );
    await expect(
      listSqliteWorkspaceCollaboration(handle.db, {
        userId: memberId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCollaborationAccessError);
    await expect(
      revokeSqliteWorkspaceInvitation(
        handle.db,
        {
          invitationId: pending.id,
          userId: memberId,
          workspaceId,
        },
        now
      )
    ).rejects.toBeInstanceOf(SqliteCollaborationAccessError);

    await expect(
      updateSqliteWorkspaceMemberRole(handle.db, {
        role: 'admin',
        targetUserId: memberId,
        userId: adminId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCollaborationAccessError);
    await expect(
      removeSqliteWorkspaceMember(handle.db, {
        targetUserId: ownerId,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCollaborationAccessError);

    await updateSqliteWorkspaceMemberRole(handle.db, {
      role: 'member',
      targetUserId: adminId,
      userId: ownerId,
      workspaceId,
    });
    await removeSqliteWorkspaceMember(handle.db, {
      targetUserId: memberId,
      userId: ownerId,
      workspaceId,
    });
    const collaboration = await listSqliteWorkspaceCollaboration(handle.db, {
      userId: ownerId,
      workspaceId,
    });
    expect(collaboration.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'owner', userId: ownerId }),
        expect.objectContaining({ role: 'member', userId: adminId }),
      ])
    );
    expect(collaboration.members).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: memberId })])
    );
    expect(collaboration.invitations).toEqual([
      expect.objectContaining({ id: pending.id, status: 'pending' }),
    ]);
  });
});
