import { describe, expect, it } from 'vitest';
import { sqliteDatabaseConfigSchema } from './config';

describe('SQLite database deployment mode', () => {
  it('keeps local SQLite available by default', () => {
    expect(
      sqliteDatabaseConfigSchema.parse({ url: 'file:./data/byok-grid.sqlite' })
    ).toMatchObject({
      mode: 'local',
      url: 'file:./data/byok-grid.sqlite',
    });
  });

  it('accepts remote mode only with libSQL transport', () => {
    expect(
      sqliteDatabaseConfigSchema.parse({
        mode: 'remote',
        url: 'libsql://database.example.test',
      })
    ).toMatchObject({
      mode: 'remote',
      url: 'libsql://database.example.test',
    });

    const secretBearingUrl = 'file:./do-not-expose-this-path.sqlite';
    const result = sqliteDatabaseConfigSchema.safeParse({
      mode: 'remote',
      url: secretBearingUrl,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: 'Remote database mode requires a libsql:// URL.',
          path: ['url'],
        })
      );
      expect(result.error.message).not.toContain(secretBearingUrl);
    }
  });
});
