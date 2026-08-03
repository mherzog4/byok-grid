'use client';

import type {
  WorkspaceInvitationSummary,
  WorkspaceMemberSummary,
} from '@byok-grid/db';
import type { WorkspaceRole } from '@byok-grid/domain';
import { type FormEvent, useState } from 'react';

interface CollaborationState {
  invitations: WorkspaceInvitationSummary[];
  members: WorkspaceMemberSummary[];
}

export function CollaborationPanel({
  actorRole,
  actorUserId,
  initial,
  workspaceId,
}: {
  actorRole: Extract<WorkspaceRole, 'admin' | 'owner'>;
  actorUserId: string;
  initial: CollaborationState;
  workspaceId: string;
}) {
  const [state, setState] = useState(initial);
  const [inviteLink, setInviteLink] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}`;

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    setInviteLink(undefined);
    try {
      const response = await fetch(`${baseUrl}/collaboration`, {
        body: JSON.stringify({
          email: String(data.get('email') ?? ''),
          role: String(data.get('role') ?? 'member'),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as WorkspaceInvitationSummary & {
        error?: string;
        token?: string;
      };
      if (!response.ok || !body.token) {
        throw new Error(body.error ?? 'The invitation could not be created.');
      }
      setState((current) => ({
        ...current,
        invitations: [
          ...current.invitations.filter((item) => item.id !== body.id),
          {
            createdAt: new Date(body.createdAt),
            email: body.email,
            expiresAt: new Date(body.expiresAt),
            id: body.id,
            invitedByUserId: body.invitedByUserId,
            role: body.role,
            status: body.status,
          },
        ],
      }));
      setInviteLink(`${window.location.origin}/invite/${body.token}`);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  async function revoke(invitation: WorkspaceInvitationSummary) {
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/invitations/${invitation.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('The invitation could not be revoked.');
      setState((current) => ({
        ...current,
        invitations: current.invitations.filter(
          (item) => item.id !== invitation.id
        ),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  async function changeRole(
    member: WorkspaceMemberSummary,
    role: 'admin' | 'member'
  ) {
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/members/${member.userId}`, {
        body: JSON.stringify({ role }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      if (!response.ok)
        throw new Error('The member role could not be changed.');
      const updated = (await response.json()) as WorkspaceMemberSummary;
      setState((current) => ({
        ...current,
        members: current.members.map((item) =>
          item.userId === updated.userId
            ? { ...updated, joinedAt: new Date(updated.joinedAt) }
            : item
        ),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  async function remove(member: WorkspaceMemberSummary) {
    if (!window.confirm(`Remove ${member.email} from this workspace?`)) return;
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/members/${member.userId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('The member could not be removed.');
      setState((current) => ({
        ...current,
        members: current.members.filter(
          (item) => item.userId !== member.userId
        ),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  return (
    <section className="credential-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">COLLABORATION</p>
          <h2>Workspace members</h2>
        </div>
        <p>
          Invitation tokens are stored as hashes and shown only when created.
        </p>
      </div>

      <div className="credential-layout">
        <form className="credential-form" method="post" onSubmit={invite}>
          <label>
            Email address
            <input autoComplete="email" name="email" required type="email" />
          </label>
          <label>
            Workspace role
            <select name="role">
              <option value="member">Member</option>
              {actorRole === 'owner' ? (
                <option value="admin">Administrator</option>
              ) : null}
            </select>
          </label>
          {inviteLink ? (
            <div className="invite-link-result">
              <label>
                One-time invitation link
                <input readOnly value={inviteLink} />
              </label>
              <button
                onClick={() => void navigator.clipboard.writeText(inviteLink)}
                type="button"
              >
                Copy link
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Creating…' : 'Create invitation'}
          </button>
        </form>

        <div className="credential-list collaboration-list">
          {state.members.map((member) => {
            const canManage =
              member.userId !== actorUserId &&
              member.role !== 'owner' &&
              (actorRole === 'owner' || member.role === 'member');
            return (
              <article key={member.userId}>
                <div>
                  <strong>{member.name}</strong>
                  <span>
                    {member.email} · {member.role}
                  </span>
                </div>
                {canManage ? (
                  <div className="member-actions">
                    {actorRole === 'owner' ? (
                      <select
                        aria-label={`Role for ${member.email}`}
                        onChange={(event) =>
                          void changeRole(
                            member,
                            event.target.value as 'admin' | 'member'
                          )
                        }
                        value={member.role}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : null}
                    <button onClick={() => void remove(member)} type="button">
                      Remove
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
          {state.invitations.map((invitation) => {
            const canRevoke =
              actorRole === 'owner' || invitation.role === 'member';
            return (
              <article key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <span>
                    pending {invitation.role} · {invitation.status}
                  </span>
                </div>
                {canRevoke ? (
                  <button onClick={() => void revoke(invitation)} type="button">
                    Revoke
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
