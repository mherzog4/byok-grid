import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { SQLITE_BUSY_TIMEOUT_MS } from './client';

const requiredApplicationTables = [
  '__drizzle_migrations',
  'outbox_events',
  'users',
  'workflow_runs',
  'workflows',
  'workspace_purge_receipts',
  'workspaces',
] as const;

export interface SqliteBackupVerification {
  migrationCount: number;
  path: string;
  sha256: string;
  sizeBytes: number;
  verifiedAt: string;
}

export interface SqliteBackupResult extends SqliteBackupVerification {
  sourcePath: string;
}

export class SqliteBackupValidationError extends Error {}

export function resolveLocalSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new SqliteBackupValidationError(
      'This command supports local file: SQLite databases only. Use the remote libSQL provider backup service for libsql:// databases.'
    );
  }
  if (databaseUrl.includes('?') || databaseUrl.includes('#')) {
    throw new SqliteBackupValidationError(
      'SQLite file URLs with query strings or fragments are not supported by the backup CLI.'
    );
  }

  const path = databaseUrl.startsWith('file://')
    ? fileURLToPath(databaseUrl)
    : databaseUrl.slice('file:'.length);
  if (path.length === 0 || path === ':memory:') {
    throw new SqliteBackupValidationError(
      'A persistent SQLite file is required for backup.'
    );
  }
  return resolve(path);
}

export async function verifySqliteBackup(
  inputPath: string
): Promise<SqliteBackupVerification> {
  const path = resolve(inputPath);
  const file = statSync(path, { throwIfNoEntry: false });
  if (!file?.isFile() || file.size === 0) {
    throw new SqliteBackupValidationError(
      'The SQLite backup does not exist or is empty.'
    );
  }

  const client = createClient({
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    url: pathToFileURL(path).href,
  });
  try {
    const quickCheck = await client.execute('PRAGMA quick_check');
    if (quickCheck.rows.length !== 1 || quickCheck.rows[0]?.[0] !== 'ok') {
      throw new SqliteBackupValidationError(
        'SQLite quick_check did not report a healthy database.'
      );
    }

    const foreignKeyFailures = await client.execute('PRAGMA foreign_key_check');
    if (foreignKeyFailures.rows.length > 0) {
      throw new SqliteBackupValidationError(
        `SQLite foreign_key_check reported ${foreignKeyFailures.rows.length} violation(s).`
      );
    }

    const placeholders = requiredApplicationTables.map(() => '?').join(', ');
    const schema = await client.execute({
      args: [...requiredApplicationTables],
      sql: `select name from sqlite_master where type = 'table' and name in (${placeholders})`,
    });
    const presentTables = new Set(schema.rows.map((row) => String(row[0])));
    const missingTables = requiredApplicationTables.filter(
      (table) => !presentTables.has(table)
    );
    if (missingTables.length > 0) {
      throw new SqliteBackupValidationError(
        `The file is not a complete BYOK Grid database; missing table(s): ${missingTables.join(', ')}.`
      );
    }

    const migrations = await client.execute(
      'select count(*) from __drizzle_migrations'
    );
    const migrationCount = Number(migrations.rows[0]?.[0] ?? 0);
    if (!Number.isSafeInteger(migrationCount) || migrationCount < 1) {
      throw new SqliteBackupValidationError(
        'The backup contains no applied SQLite migration history.'
      );
    }

    return {
      migrationCount,
      path,
      sha256: await sha256File(path),
      sizeBytes: file.size,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    client.close();
  }
}

export async function createSqliteBackup(input: {
  databaseUrl: string;
  outputPath: string;
}): Promise<SqliteBackupResult> {
  const configuredSourcePath = resolveLocalSqlitePath(input.databaseUrl);
  const source = statSync(configuredSourcePath, { throwIfNoEntry: false });
  if (!source?.isFile()) {
    throw new SqliteBackupValidationError(
      'The configured SQLite database file does not exist.'
    );
  }
  const sourcePath = realpathSync(configuredSourcePath);
  const outputPath = resolve(input.outputPath);
  assertNewOutputPath(sourcePath, outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });

  const temporaryPath = partialPathFor(outputPath);
  let client: Client | undefined;
  try {
    client = createClient({
      timeout: SQLITE_BUSY_TIMEOUT_MS,
      url: pathToFileURL(sourcePath).href,
    });
    await client.execute({
      args: [temporaryPath],
      sql: 'VACUUM main INTO ?',
    });
    client.close();
    client = undefined;
    chmodSync(temporaryPath, 0o600);

    const verification = await verifySqliteBackup(temporaryPath);
    publishNewFile(temporaryPath, outputPath);
    return {
      ...verification,
      path: outputPath,
      sourcePath,
    };
  } catch (error) {
    client?.close();
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export async function restoreSqliteBackupToNewFile(input: {
  backupPath: string;
  outputPath: string;
}): Promise<SqliteBackupVerification> {
  const backupPath = realpathSync(resolve(input.backupPath));
  const outputPath = resolve(input.outputPath);
  assertNewOutputPath(backupPath, outputPath);
  const backup = await verifySqliteBackup(backupPath);
  mkdirSync(dirname(outputPath), { recursive: true });

  const temporaryPath = partialPathFor(outputPath);
  try {
    copyFileSync(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    chmodSync(temporaryPath, 0o600);
    const restored = await verifySqliteBackup(temporaryPath);
    if (restored.sha256 !== backup.sha256) {
      throw new SqliteBackupValidationError(
        'The restored file digest does not match the verified backup.'
      );
    }
    publishNewFile(temporaryPath, outputPath);
    return { ...restored, path: outputPath };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function assertNewOutputPath(sourcePath: string, outputPath: string): void {
  if (resolve(sourcePath) === outputPath) {
    throw new SqliteBackupValidationError(
      'The output path must differ from the source database.'
    );
  }
  if (existsSync(outputPath)) {
    throw new SqliteBackupValidationError(
      'The output path already exists; refusing to overwrite it.'
    );
  }
}

function partialPathFor(outputPath: string): string {
  return resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.partial-${randomUUID()}`
  );
}

function publishNewFile(temporaryPath: string, outputPath: string): void {
  // Both paths share a directory, so this is an atomic no-clobber publish.
  // Unlike rename(), link() fails if another process created outputPath after
  // the earlier validation check.
  linkSync(temporaryPath, outputPath);
  rmSync(temporaryPath);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
