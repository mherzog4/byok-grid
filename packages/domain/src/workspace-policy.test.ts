import { describe, expect, it } from 'vitest';
import {
  canInviteWorkspaceRole,
  canManageWorkspaceMember,
  hasWorkspacePermission,
  normalizeWorkspaceEmail,
} from './workspace-policy';

describe('workspace authorization policy', () => {
  it('separates data collaboration from credential administration', () => {
    expect(hasWorkspacePermission('member', 'data.read')).toBe(true);
    expect(hasWorkspacePermission('member', 'data.write')).toBe(true);
    expect(hasWorkspacePermission('member', 'credentials.manage')).toBe(false);
    expect(hasWorkspacePermission('admin', 'credentials.manage')).toBe(true);
    expect(hasWorkspacePermission('admin', 'schema.manage')).toBe(true);
    expect(hasWorkspacePermission('member', 'schema.manage')).toBe(false);
  });

  it('lets owners invite admins while admins can only invite members', () => {
    expect(canInviteWorkspaceRole('owner', 'admin')).toBe(true);
    expect(canInviteWorkspaceRole('owner', 'member')).toBe(true);
    expect(canInviteWorkspaceRole('admin', 'member')).toBe(true);
    expect(canInviteWorkspaceRole('admin', 'admin')).toBe(false);
    expect(canInviteWorkspaceRole('member', 'member')).toBe(false);
  });

  it('protects owners and admins from lower-role member management', () => {
    expect(canManageWorkspaceMember('owner', 'admin')).toBe(true);
    expect(canManageWorkspaceMember('owner', 'owner')).toBe(false);
    expect(canManageWorkspaceMember('admin', 'member')).toBe(true);
    expect(canManageWorkspaceMember('admin', 'admin')).toBe(false);
    expect(canManageWorkspaceMember('member', 'member')).toBe(false);
  });

  it('normalizes invitation email identity before persistence', () => {
    expect(normalizeWorkspaceEmail('  Admin@Example.COM  ')).toBe(
      'admin@example.com'
    );
    expect(() => normalizeWorkspaceEmail('not-an-email')).toThrow();
  });
});
