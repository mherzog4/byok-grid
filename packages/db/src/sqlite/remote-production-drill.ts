import { createClient, type Client, type InStatement } from '@libsql/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertSqliteMigrationsReady } from './migration-status';

export const REMOTE_DRILL_CONFIRMATION = 'isolated-preproduction-database';
export const REMOTE_DRILL_PROBE_TABLE = 'byok_grid_remote_drill_probe';
export const REMOTE_DRILL_WRITER_MARKER =
  'BYOK_GRID_REMOTE_LIBSQL_WRITER_COMMITTED';
export const REMOTE_DRILL_OBSERVER_MARKER =
  'BYOK_GRID_REMOTE_LIBSQL_OBSERVER_CONFIRMED';

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FTS5_SHADOW_SUFFIXES = [
  'config',
  'content',
  'data',
  'docsize',
  'idx',
] as const;

export interface RemoteDrillDatabaseConfig {
  authToken: string;
  url: string;
}

export interface RemoteDrillFingerprint {
  migrationCount: number;
  migrationSha256: string;
  schemaSha256: string;
  tableCountsSha256: string;
}

export class RemoteProductionDrillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteProductionDrillError';
  }
}

export function parseRemoteDrillDatabaseConfig(input: {
  authToken: string | undefined;
  label: 'live' | 'restored';
  url: string | undefined;
}): RemoteDrillDatabaseConfig {
  if (!input.url) {
    throw new RemoteProductionDrillError(
      `${input.label} remote libSQL URL is required.`
    );
  }
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new RemoteProductionDrillError(
      `${input.label} remote libSQL URL is invalid.`
    );
  }
  if (url.protocol !== 'libsql:') {
    throw new RemoteProductionDrillError(
      `${input.label} database must use libsql://.`
    );
  }
  if (
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new RemoteProductionDrillError(
      `${input.label} database URL must not contain credentials, a path, a query, or a fragment.`
    );
  }
  if (!input.authToken) {
    throw new RemoteProductionDrillError(
      `${input.label} remote libSQL auth token is required.`
    );
  }
  return {
    authToken: input.authToken,
    url: `libsql://${url.host.toLowerCase()}`,
  };
}

export function assertRemoteDrillConfirmation(value: string | undefined): void {
  if (value !== REMOTE_DRILL_CONFIRMATION) {
    throw new RemoteProductionDrillError(
      `Set BYOK_GRID_REMOTE_DRILL_CONFIRM=${REMOTE_DRILL_CONFIRMATION} only for an isolated preproduction database.`
    );
  }
}

export function assertDistinctRemoteDatabases(
  live: RemoteDrillDatabaseConfig,
  restored: RemoteDrillDatabaseConfig
): void {
  if (live.url === restored.url) {
    throw new RemoteProductionDrillError(
      'The restored database URL must differ from the live drill database URL.'
    );
  }
}

export function parseRemoteDrillRunId(value: string | undefined): string {
  if (!value || !UUID_V4_PATTERN.test(value)) {
    throw new RemoteProductionDrillError(
      'The remote libSQL drill run ID must be a UUIDv4.'
    );
  }
  return value;
}

export function parseRemoteDrillChallenge(value: string | undefined): string {
  if (!value || !HEX_SHA256_PATTERN.test(value)) {
    throw new RemoteProductionDrillError(
      'The remote libSQL drill challenge must be a lowercase SHA-256 digest.'
    );
  }
  return value;
}

export function createRemoteDrillIdentity(): Readonly<{
  challengeSha256: string;
  runId: string;
}> {
  return {
    challengeSha256: createHash('sha256').update(randomBytes(32)).digest('hex'),
    runId: randomUUID(),
  };
}

export function openRemoteDrillClient(
  config: RemoteDrillDatabaseConfig
): Client {
  return createClient({
    authToken: config.authToken,
    timeout: 5_000,
    url: config.url,
  });
}

export async function assertRemoteDrillPreconditions(
  client: Client
): Promise<void> {
  await safely('preflight', async () => {
    await assertCurrentMigrations(client);
    if (await probeTableExists(client)) {
      throw new RemoteProductionDrillError(
        'A remote libSQL drill probe already exists; use the saved run identity to clean it up.'
      );
    }
    await assertNoApplicationRows(client);
  });
}

export async function writeRemoteDrillProbe(
  client: Client,
  identity: Readonly<{ challengeSha256: string; runId: string }>
): Promise<void> {
  const runId = parseRemoteDrillRunId(identity.runId);
  const challengeSha256 = parseRemoteDrillChallenge(identity.challengeSha256);
  await safely('writer', async () => {
    await assertCurrentMigrations(client);
    if (await probeTableExists(client)) {
      throw new RemoteProductionDrillError(
        'A remote libSQL drill probe already exists.'
      );
    }
    await assertNoApplicationRows(client);
    const statements: InStatement[] = [
      `create table ${REMOTE_DRILL_PROBE_TABLE} (
        singleton integer primary key check (singleton = 1),
        run_id text not null unique,
        challenge_sha256 text not null,
        created_at integer not null
      )`,
      {
        args: [runId, challengeSha256, Date.now()],
        sql: `insert into ${REMOTE_DRILL_PROBE_TABLE}
          (singleton, run_id, challenge_sha256, created_at)
          values (1, ?, ?, ?)`,
      },
    ];
    await client.batch(statements, 'write');
    await assertRemoteDrillProbe(client, identity);
  });
}

export async function assertRemoteDrillProbe(
  client: Client,
  identity: Readonly<{ challengeSha256: string; runId: string }>
): Promise<void> {
  const runId = parseRemoteDrillRunId(identity.runId);
  const challengeSha256 = parseRemoteDrillChallenge(identity.challengeSha256);
  await safely('observer', async () => {
    const result = await client.execute({
      args: [runId],
      sql: `select run_id, challenge_sha256
        from ${REMOTE_DRILL_PROBE_TABLE}
        where singleton = 1 and run_id = ?`,
    });
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row?.[0] !== runId ||
      row?.[1] !== challengeSha256
    ) {
      throw new RemoteProductionDrillError(
        'The remote libSQL drill probe did not match the saved run identity.'
      );
    }
  });
}

export async function fingerprintRemoteDrillDatabase(
  client: Client
): Promise<RemoteDrillFingerprint> {
  return safely('fingerprint', async () => {
    const migrationStatus = await assertCurrentMigrations(client);
    await assertNoApplicationRows(client, { allowProbe: true });
    const [migrations, schema, tableCounts] = await Promise.all([
      client.execute(
        `select lower(hex(hash)), created_at
          from __drizzle_migrations
          order by created_at asc, hash asc`
      ),
      client.execute(
        `select type, name, tbl_name, coalesce(sql, '')
          from sqlite_schema
          where name not like 'sqlite_%'
          order by type asc, name asc, tbl_name asc`
      ),
      remoteDrillTableCounts(client),
    ]);
    return {
      migrationCount: migrationStatus.appliedCount,
      migrationSha256: digestRows(migrations.rows),
      schemaSha256: digestRows(schema.rows),
      tableCountsSha256: digestRows(tableCounts),
    };
  });
}

export function assertMatchingRemoteDrillFingerprints(
  live: RemoteDrillFingerprint,
  restored: RemoteDrillFingerprint
): void {
  if (
    live.migrationCount !== restored.migrationCount ||
    live.migrationSha256 !== restored.migrationSha256 ||
    live.schemaSha256 !== restored.schemaSha256 ||
    live.tableCountsSha256 !== restored.tableCountsSha256
  ) {
    throw new RemoteProductionDrillError(
      'The restored database schema or migration fingerprint did not match the live drill database.'
    );
  }
}

export async function removeRemoteDrillProbe(
  client: Client,
  identity: Readonly<{ challengeSha256: string; runId: string }>,
  options: Readonly<{ allowAbsent?: boolean }> = {}
): Promise<void> {
  await safely('cleanup', async () => {
    const exists = await probeTableExists(client);
    if (!exists && options.allowAbsent) return;
    if (!exists) {
      throw new RemoteProductionDrillError(
        'The remote libSQL drill probe table is absent.'
      );
    }
    await assertRemoteDrillProbe(client, identity);
    await client.execute(`drop table ${REMOTE_DRILL_PROBE_TABLE}`);
  });
}

async function assertNoApplicationRows(
  client: Client,
  options: Readonly<{ allowProbe?: boolean }> = {}
): Promise<void> {
  const tables = await client.execute(
    `select name, coalesce(sql, '') from sqlite_schema
      where type = 'table' and name not like 'sqlite_%'
      order by name asc`
  );
  const fullTextTables = tables.rows
    .filter(
      (row) =>
        typeof row[0] === 'string' &&
        typeof row[1] === 'string' &&
        /\busing\s+fts5\b/iu.test(row[1])
    )
    .map((row) => row[0] as string);
  const fullTextShadowTables = new Set(
    fullTextTables.flatMap((name) =>
      FTS5_SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`)
    )
  );
  for (const row of tables.rows) {
    const name = row[0];
    if (typeof name !== 'string') {
      throw new RemoteProductionDrillError(
        'The remote libSQL schema returned an invalid table name.'
      );
    }
    if (
      name === '__drizzle_migrations' ||
      (options.allowProbe && name === REMOTE_DRILL_PROBE_TABLE)
    ) {
      continue;
    }
    if (fullTextShadowTables.has(name)) {
      continue;
    }
    const count = await client.execute(
      `select count(*) from ${quoteIdentifier(name)}`
    );
    if (Number(count.rows[0]?.[0] ?? 0) !== 0) {
      throw new RemoteProductionDrillError(
        'The remote libSQL drill requires an isolated database with no application rows.'
      );
    }
  }
}

async function probeTableExists(client: Client): Promise<boolean> {
  const result = await client.execute({
    args: [REMOTE_DRILL_PROBE_TABLE],
    sql: `select count(*) from sqlite_schema
      where type = 'table' and name = ?`,
  });
  return Number(result.rows[0]?.[0] ?? 0) === 1;
}

async function remoteDrillTableCounts(
  client: Client
): Promise<readonly (readonly [string, number])[]> {
  const tables = await client.execute(
    `select name from sqlite_schema
      where type = 'table' and name not like 'sqlite_%'
      order by name asc`
  );
  const counts: Array<readonly [string, number]> = [];
  for (const row of tables.rows) {
    const name = row[0];
    if (typeof name !== 'string') {
      throw new RemoteProductionDrillError(
        'The remote libSQL schema returned an invalid table name.'
      );
    }
    const result = await client.execute(
      `select count(*) from ${quoteIdentifier(name)}`
    );
    counts.push([name, Number(result.rows[0]?.[0] ?? 0)]);
  }
  return counts;
}

async function assertCurrentMigrations(client: Client) {
  const status = await assertSqliteMigrationsReady(client);
  if (status.appliedCount !== status.expectedCount) {
    throw new RemoteProductionDrillError(
      'The remote libSQL database has an unexpected migration count.'
    );
  }
  return status;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function digestRows(rows: readonly ArrayLike<unknown>[]): string {
  const digest = createHash('sha256');
  for (const row of rows) {
    digest.update(JSON.stringify(Array.from(row, normalizeSqlValue)));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function normalizeSqlValue(value: unknown): string | number | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('hex');
  }
  throw new RemoteProductionDrillError(
    'The remote libSQL fingerprint contained an unsupported value.'
  );
}

async function safely<T>(
  phase: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RemoteProductionDrillError) throw error;
    throw new RemoteProductionDrillError(
      `The remote libSQL drill failed during ${phase}.`
    );
  }
}
