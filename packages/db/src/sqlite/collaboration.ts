import {
  canInviteWorkspaceRole,
  canManageWorkspaceMember,
  hasWorkspacePermission,
  normalizeWorkspaceEmail,
  type WorkspaceRole,
} from '@byok-grid/domain';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from './schema';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class SqliteCollaborationAccessError extends Error {}
export class SqliteCollaborationConflictError extends Error {}
export class SqliteCollaborationValidationError extends Error {}

export interface SqliteWorkspaceMemberSummary {
  email: string;
  joinedAt: Date;
  name: string;
  role: WorkspaceRole;
  userId: string;
}

export interface SqliteWorkspaceInvitationSummary {
  createdAt: Date;
  email: string;
  expiresAt: Date;
  id: string;
  invitedByUserId: string | null;
  role: Exclude<WorkspaceRole, 'owner'>;
  status: 'expired' | 'pending';
}

interface CollaborationScope {
  userId: string;
  workspaceId: string;
}

export async function listSqliteWorkspaceCollaboration(
  db: SqliteDatabase,
  scope: CollaborationScope,
  now = new Date()
): Promise<{
  invitations: SqliteWorkspaceInvitationSummary[];
  members: SqliteWorkspaceMemberSummary[];
}> {
  const actorRole = await requireMembershipRole(db, scope);
  if (!hasWorkspacePermission(actorRole, 'members.manage')) {
    throw new SqliteCollaborationAccessError(
      'You cannot manage members in this workspace.'
    );
  }

  const [memberRows, invitationRows] = await Promise.all([
    db
      .select({
        email: users.email,
        joinedAt: workspaceMembers.createdAt,
        name: users.name,
        role: workspaceMembers.role,
        userId: users.id,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, scope.workspaceId))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        createdAt: workspaceInvitations.createdAt,
        email: workspaceInvitations.email,
        expiresAt: workspaceInvitations.expiresAt,
        id: workspaceInvitations.id,
        invitedByUserId: workspaceInvitations.invitedByUserId,
        role: workspaceInvitations.role,
      })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, scope.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt)
        )
      )
      .orderBy(asc(workspaceInvitations.createdAt)),
  ]);

  return {
    invitations: invitationRows.map((invitation) => ({
      ...invitation,
      role: assertInvitableRole(invitation.role),
      status: invitation.expiresAt > now ? 'pending' : 'expired',
    })),
    members: memberRows,
  };
}

export async function createSqliteWorkspaceInvitation(
  db: SqliteDatabase,
  input: CollaborationScope & {
    email: string;
    role: Exclude<WorkspaceRole, 'owner'>;
  },
  now = new Date()
): Promise<SqliteWorkspaceInvitationSummary & { token: string }> {
  const email = normalizeWorkspaceEmail(input.email);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSqliteWorkspaceInvitationToken(token);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

  return withSqliteWriteTransaction(db, async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    if (!canInviteWorkspaceRole(actorRole, input.role)) {
      throw new SqliteCollaborationAccessError(
        `You cannot invite a ${input.role} to this workspace.`
      );
    }

    const [existingMember] = await tx
      .select({ userId: users.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          sql`lower(${users.email}) = ${email}`
        )
      )
      .limit(1);
    if (existingMember) {
      throw new SqliteCollaborationConflictError(
        'That email already belongs to a workspace member.'
      );
    }

    const [existingInvitation] = await tx
      .select({
        expiresAt: workspaceInvitations.expiresAt,
        id: workspaceInvitations.id,
      })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, input.workspaceId),
          eq(workspaceInvitations.email, email),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt)
        )
      )
      .limit(1);
    if (existingInvitation && existingInvitation.expiresAt > now) {
      throw new SqliteCollaborationConflictError(
        'A pending invitation already exists for that email.'
      );
    }
    if (existingInvitation) {
      await tx
        .update(workspaceInvitations)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(workspaceInvitations.id, existingInvitation.id),
            isNull(workspaceInvitations.acceptedAt),
            isNull(workspaceInvitations.revokedAt)
          )
        );
    }

    const [created] = await tx
      .insert(workspaceInvitations)
      .values({
        createdAt: now,
        email,
        expiresAt,
        invitedByUserId: input.userId,
        role: input.role,
        tokenHash,
        updatedAt: now,
        workspaceId: input.workspaceId,
      })
      .returning({
        createdAt: workspaceInvitations.createdAt,
        email: workspaceInvitations.email,
        expiresAt: workspaceInvitations.expiresAt,
        id: workspaceInvitations.id,
        invitedByUserId: workspaceInvitations.invitedByUserId,
        role: workspaceInvitations.role,
      });
    if (!created) throw new Error('The invitation could not be created.');

    return {
      ...created,
      role: assertInvitableRole(created.role),
      status: 'pending',
      token,
    };
  });
}

export async function acceptSqliteWorkspaceInvitation(
  db: SqliteDatabase,
  input: { email: string; token: string; userId: string },
  now = new Date()
): Promise<{
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}> {
  if (!input.token || input.token.length > 256) {
    throw new SqliteCollaborationValidationError(
      'The invitation token is invalid.'
    );
  }
  const email = normalizeWorkspaceEmail(input.email);
  const tokenHash = hashSqliteWorkspaceInvitationToken(input.token);

  return withSqliteWriteTransaction(db, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash))
      .limit(1);
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= now
    ) {
      throw new SqliteCollaborationValidationError(
        'The invitation is invalid or expired.'
      );
    }
    if (invitation.email !== email) {
      throw new SqliteCollaborationValidationError(
        'Sign in with the email address that was invited.'
      );
    }

    const [accepted] = await tx
      .update(workspaceInvitations)
      .set({
        acceptedAt: now,
        acceptedByUserId: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceInvitations.id, invitation.id),
          eq(workspaceInvitations.email, email),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, now)
        )
      )
      .returning({ id: workspaceInvitations.id });
    if (!accepted) {
      throw new SqliteCollaborationValidationError(
        'The invitation is invalid or expired.'
      );
    }

    await tx
      .insert(workspaceMembers)
      .values({
        role: assertInvitableRole(invitation.role),
        userId: input.userId,
        workspaceId: invitation.workspaceId,
      })
      .onConflictDoNothing({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      });

    const [membership] = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        slug: workspaces.slug,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, invitation.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .limit(1);
    if (!membership) throw new Error('The membership could not be created.');
    return membership;
  });
}

export async function revokeSqliteWorkspaceInvitation(
  db: SqliteDatabase,
  input: CollaborationScope & { invitationId: string },
  now = new Date()
): Promise<SqliteWorkspaceInvitationSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    const [invitation] = await tx
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.id, input.invitationId),
          eq(workspaceInvitations.workspaceId, input.workspaceId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt)
        )
      )
      .limit(1);
    if (!invitation) {
      throw new SqliteCollaborationAccessError('The invitation was not found.');
    }
    const invitationRole = assertInvitableRole(invitation.role);
    if (!canInviteWorkspaceRole(actorRole, invitationRole)) {
      throw new SqliteCollaborationAccessError(
        'You cannot revoke this invitation.'
      );
    }

    const [revoked] = await tx
      .update(workspaceInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(workspaceInvitations.id, invitation.id),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt)
        )
      )
      .returning({
        createdAt: workspaceInvitations.createdAt,
        email: workspaceInvitations.email,
        expiresAt: workspaceInvitations.expiresAt,
        id: workspaceInvitations.id,
        invitedByUserId: workspaceInvitations.invitedByUserId,
        role: workspaceInvitations.role,
      });
    if (!revoked) {
      throw new SqliteCollaborationAccessError('The invitation was not found.');
    }
    return {
      ...revoked,
      role: assertInvitableRole(revoked.role),
      status: revoked.expiresAt > now ? 'pending' : 'expired',
    };
  });
}

export async function updateSqliteWorkspaceMemberRole(
  db: SqliteDatabase,
  input: CollaborationScope & {
    role: Exclude<WorkspaceRole, 'owner'>;
    targetUserId: string;
  }
): Promise<SqliteWorkspaceMemberSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    const target = await requireMember(
      tx,
      input.workspaceId,
      input.targetUserId
    );
    if (
      !canManageWorkspaceMember(actorRole, target.role) ||
      !canInviteWorkspaceRole(actorRole, input.role)
    ) {
      throw new SqliteCollaborationAccessError(
        'You cannot change this member role.'
      );
    }

    const [updated] = await tx
      .update(workspaceMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.targetUserId),
          eq(workspaceMembers.role, target.role)
        )
      )
      .returning({ userId: workspaceMembers.userId });
    if (!updated) {
      throw new SqliteCollaborationAccessError(
        'You cannot change this member role.'
      );
    }
    return { ...target, role: input.role };
  });
}

export async function removeSqliteWorkspaceMember(
  db: SqliteDatabase,
  input: CollaborationScope & { targetUserId: string }
): Promise<{ removedUserId: string }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    const target = await requireMember(
      tx,
      input.workspaceId,
      input.targetUserId
    );
    if (!canManageWorkspaceMember(actorRole, target.role)) {
      throw new SqliteCollaborationAccessError(
        'You cannot remove this member.'
      );
    }

    const [removed] = await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.targetUserId),
          eq(workspaceMembers.role, target.role)
        )
      )
      .returning({ userId: workspaceMembers.userId });
    if (!removed) {
      throw new SqliteCollaborationAccessError(
        'You cannot remove this member.'
      );
    }
    return { removedUserId: removed.userId };
  });
}

export function hashSqliteWorkspaceInvitationToken(token: string): string {
  return createHash('sha256')
    .update('byok-grid:workspace-invitation:v1:')
    .update(token)
    .digest('hex');
}

async function requireMembershipRole(
  db: Pick<SqliteDatabase, 'select'>,
  scope: CollaborationScope
): Promise<WorkspaceRole> {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, scope.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .limit(1);
  if (!membership) {
    throw new SqliteCollaborationAccessError('The workspace was not found.');
  }
  return membership.role;
}

async function requireMember(
  db: Pick<SqliteDatabase, 'select'>,
  workspaceId: string,
  userId: string
): Promise<SqliteWorkspaceMemberSummary> {
  const [member] = await db
    .select({
      email: users.email,
      joinedAt: workspaceMembers.createdAt,
      name: users.name,
      role: workspaceMembers.role,
      userId: users.id,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);
  if (!member) {
    throw new SqliteCollaborationAccessError('The member was not found.');
  }
  return member;
}

function assertInvitableRole(
  role: WorkspaceRole
): Exclude<WorkspaceRole, 'owner'> {
  if (role === 'owner') {
    throw new SqliteCollaborationValidationError(
      'Workspace ownership cannot be granted by invitation.'
    );
  }
  return role;
}
