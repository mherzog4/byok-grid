import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteBackup,
  restoreSqliteBackupToNewFile,
  SqliteBackupValidationError,
  verifySqliteBackup,
} from './backup';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import { users } from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';

describe('SQLite backup and restore drill', () => {
  let directory: string;
  let sourcePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    directory = join(tmpdir(), `byok-grid-backup-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    sourcePath = join(directory, 'source.sqlite');
    handle = await openSqliteDatabase({ url: `file:${sourcePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'backup-owner@example.test',
      id: 'backup-owner',
      name: 'Backup Owner',
    });
    await ensureSqlitePersonalWorkspace(handle.db, {
      id: 'backup-owner',
      name: 'Backup Owner',
    });
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('creates a consistent verified snapshot and restores it to a new file', async () => {
    const backupPath = join(directory, 'backups', 'snapshot.sqlite');
    const backup = await createSqliteBackup({
      databaseUrl: `file:${sourcePath}`,
      outputPath: backupPath,
    });
    expect(backup).toMatchObject({
      path: backupPath,
      sourcePath: realpathSync(sourcePath),
    });
    expect(backup.migrationCount).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);

    await handle.db.insert(users).values({
      email: 'after-backup@example.test',
      id: 'after-backup',
      name: 'After Backup',
    });

    const restoredPath = join(directory, 'restored', 'database.sqlite');
    const restored = await restoreSqliteBackupToNewFile({
      backupPath,
      outputPath: restoredPath,
    });
    expect(restored.sha256).toBe(backup.sha256);

    const restoredHandle = await openSqliteDatabase({
      url: `file:${restoredPath}`,
    });
    try {
      const restoredUsers = await restoredHandle.db.select().from(users);
      expect(restoredUsers.map((user) => user.id)).toContain('backup-owner');
      expect(restoredUsers.map((user) => user.id)).not.toContain(
        'after-backup'
      );
    } finally {
      restoredHandle.close();
    }
  });

  it('refuses overwrite and rejects corrupt or incomplete files', async () => {
    const backupPath = join(directory, 'snapshot.sqlite');
    await createSqliteBackup({
      databaseUrl: `file:${sourcePath}`,
      outputPath: backupPath,
    });

    await expect(
      createSqliteBackup({
        databaseUrl: `file:${sourcePath}`,
        outputPath: backupPath,
      })
    ).rejects.toBeInstanceOf(SqliteBackupValidationError);

    const corruptPath = join(directory, 'corrupt.sqlite');
    writeFileSync(corruptPath, 'not a sqlite database', { mode: 0o600 });
    await expect(verifySqliteBackup(corruptPath)).rejects.toThrow();
  });
});
