import { z } from 'zod';

export type WorkspaceRole = 'admin' | 'member' | 'owner';

export type WorkspacePermission =
  | 'connectors.manage'
  | 'credentials.manage'
  | 'data.read'
  | 'data.write'
  | 'members.invite'
  | 'members.manage'
  | 'schema.manage'
  | 'workspace.manage';

export const workspaceInvitationRoleSchema = z.enum(['admin', 'member']);

export const workspaceInvitationRequestSchema = z.strictObject({
  email: z.email().max(320),
  role: workspaceInvitationRoleSchema,
});

export function normalizeWorkspaceEmail(email: string): string {
  return workspaceInvitationRequestSchema.shape.email
    .parse(email.trim().normalize('NFKC'))
    .toLocaleLowerCase('en-US');
}

const rolePermissions: Readonly<
  Record<WorkspaceRole, ReadonlySet<WorkspacePermission>>
> = {
  owner: new Set([
    'connectors.manage',
    'credentials.manage',
    'data.read',
    'data.write',
    'members.invite',
    'members.manage',
    'schema.manage',
    'workspace.manage',
  ]),
  admin: new Set([
    'connectors.manage',
    'credentials.manage',
    'data.read',
    'data.write',
    'members.invite',
    'members.manage',
    'schema.manage',
  ]),
  member: new Set(['data.read', 'data.write']),
};

export function hasWorkspacePermission(
  role: WorkspaceRole,
  permission: WorkspacePermission
): boolean {
  return rolePermissions[role].has(permission);
}

export function canInviteWorkspaceRole(
  actorRole: WorkspaceRole,
  invitedRole: Exclude<WorkspaceRole, 'owner'>
): boolean {
  if (!hasWorkspacePermission(actorRole, 'members.invite')) return false;
  if (actorRole === 'owner') return true;

  // TODO(product owner): decide whether administrators may invite other
  // administrators. The conservative default only lets them invite members.
  return actorRole === 'admin' && invitedRole === 'member';
}

export function canManageWorkspaceMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole
): boolean {
  if (!hasWorkspacePermission(actorRole, 'members.manage')) return false;
  if (actorRole === 'owner') return targetRole !== 'owner';
  return actorRole === 'admin' && targetRole === 'member';
}
