import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema';

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    onnotice: () => undefined,
    prepare: false,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * Pins authenticated identity to the same pooled connection and transaction as
 * every query in the callback. PostgreSQL RLS policies read this local setting;
 * it is automatically cleared on commit or rollback.
 */
export async function withAuthenticatedDatabase<T>(
  db: Database,
  userId: string,
  callback: (scopedDb: Database) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('byok_grid.user_id', ${userId}, true)`
    );
    // PgTransaction intentionally omits top-level client metadata, but its
    // query and nested-transaction surface is compatible with our services.
    return callback(tx as unknown as Database);
  });
}

/**
 * Pins a one-way ingestion token digest to a single transaction. Forced RLS
 * can then reveal and write only the matching active endpoint and its batch.
 */
export async function withIngestionDatabase<T>(
  db: Database,
  tokenHash: string,
  callback: (scopedDb: Database) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('byok_grid.ingestion_token_hash', ${tokenHash}, true)`
    );
    return callback(tx as unknown as Database);
  });
}

export async function pingDatabase(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await client`select 1`;
  } finally {
    await client.end();
  }
}
