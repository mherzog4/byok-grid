import { parseMasterKeyRing } from '@byok-grid/security';
import { openSqliteDatabase } from './client';
import { defaultSqliteDatabaseUrl } from './config';
import {
  inspectSqliteMasterKeyRotation,
  rotateSqliteMasterKeysBatch,
} from './master-key-rotation';

const [command, expectedCurrentKeyId, ...unexpected] = process.argv.slice(2);
let handle: Awaited<ReturnType<typeof openSqliteDatabase>> | undefined;

try {
  if (unexpected.length > 0) usage();
  const currentKeyId = requiredEnvironment('BYOK_GRID_MASTER_KEY_ID');
  const masterKeys = parseMasterKeyRing(
    currentKeyId,
    requiredEnvironment('BYOK_GRID_MASTER_KEY'),
    process.env.BYOK_GRID_ADDITIONAL_MASTER_KEYS
  );
  const databaseUrl =
    process.env.SQLITE_DATABASE_URL ?? defaultSqliteDatabaseUrl();
  handle = await openSqliteDatabase({
    ...(process.env.SQLITE_AUTH_TOKEN
      ? { authToken: process.env.SQLITE_AUTH_TOKEN }
      : {}),
    url: databaseUrl,
  });

  const before = await inspectSqliteMasterKeyRotation(handle.db, masterKeys);
  if (command === 'plan' && expectedCurrentKeyId === undefined) {
    printResult({
      currentKeyId,
      marker: 'BYOK_GRID_MASTER_KEY_ROTATION_PLAN_VALID',
      ...before,
    });
  } else if (command === 'apply' && expectedCurrentKeyId) {
    if (expectedCurrentKeyId !== currentKeyId) {
      throw new Error(
        'The confirmed current master-key ID does not match the configured current key.'
      );
    }
    let remaining = before.pending;
    let rotated = 0;
    while (remaining > 0) {
      const batch = await rotateSqliteMasterKeysBatch(handle.db, masterKeys);
      if (batch.rotated === 0) {
        throw new Error('Master-key rotation stopped without making progress.');
      }
      remaining = batch.remaining;
      rotated += batch.rotated;
    }
    const after = await inspectSqliteMasterKeyRotation(handle.db, masterKeys);
    if (after.pending !== 0) {
      throw new Error('Master-key rotation verification found pending rows.');
    }
    printResult({
      currentKeyId,
      marker: 'BYOK_GRID_MASTER_KEY_ROTATION_APPLIED',
      remaining: after.pending,
      rotated,
      total: after.total,
    });
  } else {
    usage();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Master-key rotation failed.'}\n`
  );
  process.exitCode = 1;
} finally {
  handle?.close();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function printResult(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(): never {
  throw new Error(
    'Usage: master-key-rotation-cli.ts plan | apply <expected-current-key-id>'
  );
}
