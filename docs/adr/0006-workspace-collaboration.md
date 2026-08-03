# ADR 0006: Hashed invitations and centralized workspace roles

- Status: Accepted
- Date: 2026-07-31

## Context

A collaborative enrichment grid needs more than a workspace-membership row.
Invitations are bearer credentials, shared provider keys are privileged data,
and administrator delegation can accidentally create a privilege-escalation
path. The self-hosted default must work without requiring an email vendor.

## Decision

Workspace authorization uses a shared domain policy with three roles:

- owners can administer credentials, invite administrators or members, change
  non-owner roles, and remove non-owner members;
- administrators can administer credentials, invite and remove members, and
  collaborate on data, but cannot create or manage another administrator; and
- members can read and edit shared data and run configured enrichments, but
  cannot manage credentials, invitations, or membership.

The permission matrix and role-transition rules live in
`packages/domain/src/workspace-policy.ts`. Database services enforce the same
rules regardless of which API or UI invokes them. In particular, credential
creation and revocation now require an owner or administrator.

An invitation contains normalized email identity, an administrator or member
role, inviter, expiry, and lifecycle timestamps. The application generates a
256-bit base64url token, returns it once, and stores only a domain-separated
SHA-256 hash. Tokens expire after seven days. Acceptance locks the invitation
row, verifies the signed-in email, inserts membership without overwriting an
existing role, and marks the invitation accepted in one transaction. Duplicate
active invitations are serialized by an advisory lock and a partial unique
index.

The initial open-source installation does not require SMTP. An owner or
administrator copies the one-time invitation URL and sends it through a
channel they control. A future notification adapter may deliver the same URL
without changing invitation persistence. The invite page uses no-referrer and
no-store response policy through the application's global security headers.

Users may belong to multiple workspaces. The Next.js application accepts an
accessible workspace ID in its query state and renders a workspace switcher;
an inaccessible ID falls back to one of the user's memberships.

## Row-level security boundary

ADR 0007 completes the database enforcement layer with separate migration,
web, and worker roles plus transaction-local identity on every web tenant
query. Invitation acceptance uses an additional transaction-local token hash:
the recipient may see and transition only the matching active invitation, then
insert only the exact membership recorded by that accepted invitation.

## Consequences

- Invitation URLs are credentials. They must not be logged, traced, emailed by
  an untrusted service, or exposed as referrers.
- Revoking an invitation prevents future acceptance but cannot remove a member
  who already accepted; membership must be removed separately.
- Removing a member does not delete shared workspace data or credentials.
- Ownership transfer and owner departure are intentionally unsupported until a
  transactional last-owner invariant is designed.
- Administrators cannot invite administrators by default. This is an explicit
  product-policy seam rather than an accidental implementation detail.
