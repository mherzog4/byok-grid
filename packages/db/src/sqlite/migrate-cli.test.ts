import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SQLite migration CLI deployment mode', () => {
  it('rejects a local file before creating it in remote mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-remote-mode-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'must-not-exist.sqlite');
    const databaseUrl = `file:${databasePath}`;
    const cliPath = fileURLToPath(new URL('./migrate-cli.ts', import.meta.url));

    const child = spawnSync(process.execPath, ['--import', 'tsx', cliPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BYOK_GRID_DATABASE_MODE: 'remote',
        SQLITE_AUTH_TOKEN: '',
        SQLITE_DATABASE_URL: databaseUrl,
      },
      timeout: 10_000,
    });
    const output = `${child.stdout}${child.stderr}`;

    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(output).toContain('Remote database mode requires a libsql:// URL.');
    expect(output).not.toContain(databaseUrl);
    expect(existsSync(databasePath)).toBe(false);
  }, 15_000);
});
