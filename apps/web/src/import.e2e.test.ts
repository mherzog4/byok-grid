import {
  createDatabase,
  dataTables,
  importJobs,
  users,
  workspaceMembers,
  workspaces,
} from '@byok-grid/db/postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const runE2e = process.env.RUN_WEB_E2E === '1';
const databaseUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';

describe.skipIf(!runE2e || !databaseUrl)('CSV import HTTP end-to-end', () => {
  it('streams, applies, paginates, and safely exports imported rows', async () => {
    const { client, db } = createDatabase(databaseUrl!);
    const email = `csv-e2e-${crypto.randomUUID()}@example.test`;
    const password = 'correct-horse-battery-staple-e2e';
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const signup = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email, name: 'CSV E2E', password }),
        headers: {
          'content-type': 'application/json',
          origin: appUrl,
        },
        method: 'POST',
      });
      expect(signup.status, await signup.text()).toBe(200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; ');
      expect(cookie).not.toBe('');

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email));
      expect(user).toBeDefined();
      userIds.push(user!.id);
      const [membership] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user!.id));
      expect(membership).toBeDefined();
      workspaceIds.push(membership!.workspaceId);
      const [table] = await db
        .select({ id: dataTables.id })
        .from(dataTables)
        .where(eq(dataTables.workspaceId, membership!.workspaceId));
      expect(table).toBeDefined();

      const csv = [
        'Company,Domain,Country',
        '=EVIL,evil.example,US',
        'Globex,globex.example,GB',
        'Initech,initech.example,CA',
      ].join('\r\n');
      const uploaded = await fetch(
        `${appUrl}/api/workspaces/${membership!.workspaceId}/tables/${table!.id}/imports/csv?filename=e2e.csv`,
        {
          body: csv,
          headers: {
            'content-type': 'text/csv',
            cookie,
            origin: appUrl,
          },
          method: 'POST',
        }
      );
      const uploadBody = (await uploaded.json()) as {
        error?: string;
        id?: string;
        status?: string;
      };
      expect(uploaded.status, uploadBody.error).toBe(202);
      expect(uploadBody).toMatchObject({ status: 'queued' });

      let job: typeof importJobs.$inferSelect | undefined;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        [job] = await db
          .select()
          .from(importJobs)
          .where(
            and(
              eq(importJobs.id, uploadBody.id!),
              eq(importJobs.workspaceId, membership!.workspaceId)
            )
          );
        if (job?.status === 'succeeded' || job?.status === 'failed') break;
        await delay(500);
      }
      expect(
        job,
        job?.errorMessage ?? 'The import did not finish.'
      ).toMatchObject({
        importedRowCount: 3,
        stagedRowCount: 3,
        status: 'succeeded',
      });

      const firstPage = await fetch(
        `${appUrl}/api/workspaces/${membership!.workspaceId}/tables/${table!.id}?limit=2`,
        { headers: { cookie } }
      );
      expect(firstPage.status).toBe(200);
      const first = (await firstPage.json()) as {
        pageInfo: { hasMore: boolean; nextCursor: string };
        rows: unknown[];
      };
      expect(first.rows).toHaveLength(2);
      expect(first.pageInfo.hasMore).toBe(true);
      const secondPage = await fetch(
        `${appUrl}/api/workspaces/${membership!.workspaceId}/tables/${table!.id}?limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`,
        { headers: { cookie } }
      );
      expect(secondPage.status).toBe(200);
      expect(
        ((await secondPage.json()) as { rows: unknown[] }).rows
      ).toHaveLength(1);

      const exported = await fetch(
        `${appUrl}/api/workspaces/${membership!.workspaceId}/tables/${table!.id}/exports/csv`,
        { headers: { cookie } }
      );
      expect(exported.status).toBe(200);
      expect(exported.headers.get('content-type')).toContain('text/csv');
      const exportBody = await exported.text();
      expect(exportBody).toContain('"Country"');
      expect(exportBody).toContain('"\'=EVIL"');
      expect(exportBody).toContain('"initech.example"');
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      await client.end();
    }
  }, 90_000);
});
