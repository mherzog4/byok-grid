import {
  canInviteWorkspaceRole,
  canManageWorkspaceMember,
  hasWorkspacePermission,
  normalizeWorkspaceEmail,
  type WorkspaceRole,
} from '@byok-grid/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './client';
import {
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from './schema';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CollaborationAccessError extends Error {}
export class CollaborationConflictError extends Error {}
export class CollaborationValidationError extends Error {}

export interface WorkspaceMemberSummary {
  email: string;
  joinedAt: Date;
  name: string;
  role: WorkspaceRole;
  userId: string;
}

export interface WorkspaceInvitationSummary {
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

export async function listWorkspaceCollaboration(
  db: Database,
  scope: CollaborationScope,
  now = new Date()
): Promise<{
  invitations: WorkspaceInvitationSummary[];
  members: WorkspaceMemberSummary[];
}> {
  const actorRole = await requireMembershipRole(db, scope);
  if (!hasWorkspacePermission(actorRole, 'members.manage')) {
    throw new CollaborationAccessError(
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

export async function createWorkspaceInvitation(
  db: Database,
  input: CollaborationScope & {
    email: string;
    role: Exclude<WorkspaceRole, 'owner'>;
  },
  now = new Date()
): Promise<WorkspaceInvitationSummary & { token: string }> {
  const email = normalizeWorkspaceEmail(input.email);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashWorkspaceInvitationToken(token);
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

  return db.transaction(async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    if (!canInviteWorkspaceRole(actorRole, input.role)) {
      throw new CollaborationAccessError(
        `You cannot invite a ${input.role} to this workspace.`
      );
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${email}`}, 0))`
    );

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
      throw new CollaborationConflictError(
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
    if (existingInvitation?.expiresAt && existingInvitation.expiresAt > now) {
      throw new CollaborationConflictError(
        'A pending invitation already exists for that email.'
      );
    }
    if (existingInvitation) {
      await tx
        .update(workspaceInvitations)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(workspaceInvitations.id, existingInvitation.id));
    }

    const [created] = await tx
      .insert(workspaceInvitations)
      .values({
        email,
        expiresAt,
        invitedByUserId: input.userId,
        role: input.role,
        tokenHash,
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

export async function acceptWorkspaceInvitation(
  db: Database,
  input: { email: string; token: string; userId: string },
  now = new Date()
): Promise<{
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}> {
  if (!input.token || input.token.length > 256) {
    throw new CollaborationValidationError('The invitation token is invalid.');
  }
  const email = normalizeWorkspaceEmail(input.email);
  const tokenHash = hashWorkspaceInvitationToken(input.token);

  return db.transaction(async (tx) => {
    // The token hash is scoped to this transaction so PostgreSQL can authorize
    // the one operation whose actor is not a workspace member yet.
    await tx.execute(
      sql`select set_config('byok_grid.invitation_token_hash', ${tokenHash}, true)`
    );

    const [invitation] = await tx
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash))
      .for('update')
      .limit(1);
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= now
    ) {
      throw new CollaborationValidationError(
        'The invitation is invalid or expired.'
      );
    }
    if (invitation.email !== email) {
      throw new CollaborationValidationError(
        'Sign in with the email address that was invited.'
      );
    }

    await tx
      .update(workspaceInvitations)
      .set({
        acceptedAt: now,
        acceptedByUserId: input.userId,
        updatedAt: now,
      })
      .where(eq(workspaceInvitations.id, invitation.id));
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

export async function revokeWorkspaceInvitation(
  db: Database,
  input: CollaborationScope & { invitationId: string },
  now = new Date()
): Promise<WorkspaceInvitationSummary> {
  return db.transaction(async (tx) => {
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
      throw new CollaborationAccessError('The invitation was not found.');
    }
    const invitationRole = assertInvitableRole(invitation.role);
    if (!canInviteWorkspaceRole(actorRole, invitationRole)) {
      throw new CollaborationAccessError('You cannot revoke this invitation.');
    }

    const [revoked] = await tx
      .update(workspaceInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(workspaceInvitations.id, invitation.id))
      .returning({
        createdAt: workspaceInvitations.createdAt,
        email: workspaceInvitations.email,
        expiresAt: workspaceInvitations.expiresAt,
        id: workspaceInvitations.id,
        invitedByUserId: workspaceInvitations.invitedByUserId,
        role: workspaceInvitations.role,
      });
    if (!revoked) throw new Error('The invitation could not be revoked.');
    return {
      ...revoked,
      role: assertInvitableRole(revoked.role),
      status: revoked.expiresAt > now ? 'pending' : 'expired',
    };
  });
}

export async function updateWorkspaceMemberRole(
  db: Database,
  input: CollaborationScope & {
    role: Exclude<WorkspaceRole, 'owner'>;
    targetUserId: string;
  }
): Promise<WorkspaceMemberSummary> {
  return db.transaction(async (tx) => {
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
      throw new CollaborationAccessError('You cannot change this member role.');
    }

    await tx
      .update(workspaceMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.targetUserId)
        )
      );
    return { ...target, role: input.role };
  });
}

export async function removeWorkspaceMember(
  db: Database,
  input: CollaborationScope & { targetUserId: string }
): Promise<{ removedUserId: string }> {
  return db.transaction(async (tx) => {
    const actorRole = await requireMembershipRole(tx, input);
    const target = await requireMember(
      tx,
      input.workspaceId,
      input.targetUserId
    );
    if (!canManageWorkspaceMember(actorRole, target.role)) {
      throw new CollaborationAccessError('You cannot remove this member.');
    }
    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.targetUserId)
        )
      );
    return { removedUserId: input.targetUserId };
  });
}

export function hashWorkspaceInvitationToken(token: string): string {
  return createHash('sha256')
    .update('byok-grid:workspace-invitation:v1:')
    .update(token)
    .digest('hex');
}

type MembershipReader = Pick<Database, 'select'>;

async function requireMembershipRole(
  db: MembershipReader,
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
    throw new CollaborationAccessError('The workspace was not found.');
  }
  return membership.role;
}

async function requireMember(
  db: MembershipReader,
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberSummary> {
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
    throw new CollaborationAccessError('The member was not found.');
  }
  return member;
}

function assertInvitableRole(
  role: WorkspaceRole
): Exclude<WorkspaceRole, 'owner'> {
  if (role === 'owner') {
    throw new CollaborationValidationError(
      'Workspace ownership cannot be granted by invitation.'
    );
  }
  return role;
}
