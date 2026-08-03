import {
  createDatabase,
  dataTables,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '@byok-grid/db/postgres';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const runE2e = process.env.RUN_WEB_E2E === '1';
const databaseUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';

describe.skipIf(!runE2e || !databaseUrl)(
  'workspace collaboration HTTP end-to-end',
  () => {
    it('creates, accepts, switches to, and authorizes an invited workspace', async () => {
      const { client, db } = createDatabase(databaseUrl!);
      const ownerEmail = `collab-owner-${crypto.randomUUID()}@example.test`;
      const memberEmail = `collab-member-${crypto.randomUUID()}@example.test`;
      const userIds: string[] = [];
      const workspaceIds: string[] = [];

      try {
        const ownerCookie = await signUp(ownerEmail, 'Collaboration Owner');
        const memberCookie = await signUp(memberEmail, 'Collaboration Member');
        const [owner, member] = await Promise.all([
          findUser(ownerEmail),
          findUser(memberEmail),
        ]);
        userIds.push(owner.id, member.id);
        const ownerMemberships = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, owner.id));
        const memberMemberships = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, member.id));
        workspaceIds.push(
          ...ownerMemberships.map((item) => item.workspaceId),
          ...memberMemberships.map((item) => item.workspaceId)
        );
        const ownerWorkspaceId = ownerMemberships[0]!.workspaceId;

        const invited = await fetch(
          `${appUrl}/api/workspaces/${ownerWorkspaceId}/collaboration`,
          {
            body: JSON.stringify({ email: memberEmail, role: 'member' }),
            headers: {
              'content-type': 'application/json',
              cookie: ownerCookie,
              origin: appUrl,
            },
            method: 'POST',
          }
        );
        const invitation = (await invited.json()) as {
          error?: string;
          id?: string;
          token?: string;
        };
        expect(invited.status, invitation.error).toBe(201);
        expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        const [stored] = await db
          .select({ tokenHash: workspaceInvitations.tokenHash })
          .from(workspaceInvitations)
          .where(eq(workspaceInvitations.id, invitation.id!));
        expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(stored?.tokenHash).not.toContain(invitation.token!);

        const accepted = await fetch(`${appUrl}/api/invitations/accept`, {
          body: JSON.stringify({ token: invitation.token }),
          headers: {
            'content-type': 'application/json',
            cookie: memberCookie,
            origin: appUrl,
          },
          method: 'POST',
        });
        const acceptedWorkspace = (await accepted.json()) as {
          error?: string;
          id?: string;
          role?: string;
        };
        expect(accepted.status, acceptedWorkspace.error).toBe(200);
        expect(acceptedWorkspace).toMatchObject({
          id: ownerWorkspaceId,
          role: 'member',
        });

        const collaboration = await fetch(
          `${appUrl}/api/workspaces/${ownerWorkspaceId}/collaboration`,
          { headers: { cookie: ownerCookie } }
        );
        expect(collaboration.status).toBe(200);
        expect(
          (
            (await collaboration.json()) as {
              members: Array<{ email: string; role: string }>;
            }
          ).members
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ email: memberEmail, role: 'member' }),
          ])
        );

        const memberCollaboration = await fetch(
          `${appUrl}/api/workspaces/${ownerWorkspaceId}/collaboration`,
          { headers: { cookie: memberCookie } }
        );
        expect(memberCollaboration.status).toBe(404);

        const [ownerTable] = await db
          .select({ id: dataTables.id })
          .from(dataTables)
          .where(eq(dataTables.workspaceId, ownerWorkspaceId));
        const sharedGrid = await fetch(
          `${appUrl}/api/workspaces/${ownerWorkspaceId}/tables/${ownerTable!.id}`,
          { headers: { cookie: memberCookie } }
        );
        expect(sharedGrid.status).toBe(200);
      } finally {
        if (workspaceIds.length > 0) {
          await db
            .delete(workspaces)
            .where(inArray(workspaces.id, [...new Set(workspaceIds)]));
        }
        if (userIds.length > 0) {
          await db.delete(users).where(inArray(users.id, userIds));
        }
        await client.end();
      }

      async function findUser(email: string) {
        const [user] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email));
        if (!user) throw new Error(`Missing E2E user ${email}.`);
        return user;
      }
    }, 30_000);
  }
);

async function signUp(email: string, name: string): Promise<string> {
  const response = await fetch(`${appUrl}/api/auth/sign-up/email`, {
    body: JSON.stringify({
      email,
      name,
      password: 'correct-horse-battery-staple-collaboration',
    }),
    headers: { 'content-type': 'application/json', origin: appUrl },
    method: 'POST',
  });
  expect(response.status, await response.text()).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  expect(cookie).not.toBe('');
  return cookie;
}
