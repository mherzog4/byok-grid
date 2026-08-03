import { z } from 'zod';

const localSqliteUrlSchema = z
  .string()
  .refine(
    (value) => value === ':memory:' || value.startsWith('file:'),
    'SQLite URLs must use file: or :memory:.'
  );

export const sqliteDatabaseModeSchema = z
  .enum(['local', 'remote'])
  .default('local');

export const sqliteDatabaseConfigSchema = z
  .strictObject({
    authToken: z.string().min(1).optional(),
    mode: sqliteDatabaseModeSchema,
    url: z.union([localSqliteUrlSchema, z.url().startsWith('libsql://')]),
  })
  .superRefine((value, context) => {
    if (value.mode === 'remote' && !value.url.startsWith('libsql://')) {
      context.addIssue({
        code: 'custom',
        message: 'Remote database mode requires a libsql:// URL.',
        path: ['url'],
      });
    }
  });

export type SqliteDatabaseConfig = z.input<typeof sqliteDatabaseConfigSchema>;
export type ResolvedSqliteDatabaseConfig = z.output<
  typeof sqliteDatabaseConfigSchema
>;

export function defaultSqliteDatabaseUrl(): string {
  return 'file:./data/byok-grid.sqlite';
}
