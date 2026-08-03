import { z } from 'zod';

const localSqliteUrlSchema = z
  .string()
  .refine(
    (value) => value === ':memory:' || value.startsWith('file:'),
    'SQLite URLs must use file: or :memory:.'
  );

export const sqliteDatabaseConfigSchema = z.strictObject({
  authToken: z.string().min(1).optional(),
  url: z.union([localSqliteUrlSchema, z.url().startsWith('libsql://')]),
});

export type SqliteDatabaseConfig = z.infer<typeof sqliteDatabaseConfigSchema>;

export function defaultSqliteDatabaseUrl(): string {
  return 'file:./data/byok-grid.sqlite';
}
