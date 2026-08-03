import type { Client } from '@libsql/client';
import journal from '../../sqlite-migrations/meta/_journal.json' with { type: 'json' };

const expectedMigrationTimes = journal.entries.map((entry) => entry.when);

export type SqliteMigrationStatus = Readonly<{
  appliedCount: number;
  expectedCount: number;
}>;

export class SqliteMigrationStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteMigrationStatusError';
  }
}

export async function assertSqliteMigrationsReady(
  client: Client
): Promise<SqliteMigrationStatus> {
  let result;
  try {
    result = await client.execute(
      'select created_at from __drizzle_migrations order by created_at asc'
    );
  } catch {
    throw new SqliteMigrationStatusError(
      'The SQLite migration ledger is missing or unreadable.'
    );
  }

  const appliedTimes = result.rows.map((row) => Number(row[0]));
  const missingOrDivergent = expectedMigrationTimes.findIndex(
    (expected, index) => appliedTimes[index] !== expected
  );
  if (missingOrDivergent !== -1) {
    throw new SqliteMigrationStatusError(
      `SQLite migration ${missingOrDivergent} is missing or divergent.`
    );
  }

  return {
    appliedCount: appliedTimes.length,
    expectedCount: expectedMigrationTimes.length,
  };
}
