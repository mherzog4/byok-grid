import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { sqliteDatabaseModeSchema } from '@byok-grid/db';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional()
);

const schema = z
  .object({
    BYOK_GRID_DATABASE_MODE: sqliteDatabaseModeSchema,
    SQLITE_AUTH_TOKEN: optionalSecret,
    SQLITE_DATABASE_URL: z
      .string()
      .refine(
        (value) => value.startsWith('file:') || value.startsWith('libsql://'),
        'The analytics projector requires a file: or libsql:// SQLite URL.'
      ),
    ANALYTICS_PROJECTION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
    ANALYTICS_PROJECTION_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(300),
    ANALYTICS_PROJECTION_POLL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(2),
    CLICKHOUSE_ALLOW_INSECURE_HTTP: booleanString,
    CLICKHOUSE_DATABASE: identifier.default('byok_grid_analytics'),
    CLICKHOUSE_PASSWORD: z.string().min(1).max(1_024),
    CLICKHOUSE_TABLE: identifier.default('events'),
    CLICKHOUSE_URL: z.url(),
    CLICKHOUSE_USERNAME: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.@-]+$/),
  })
  .superRefine((value, context) => {
    if (
      value.BYOK_GRID_DATABASE_MODE === 'remote' &&
      !value.SQLITE_DATABASE_URL.startsWith('libsql://')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Remote database mode requires a libsql:// URL.',
        path: ['SQLITE_DATABASE_URL'],
      });
    }

    const url = new URL(value.CLICKHOUSE_URL);
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: 'custom',
        message:
          'CLICKHOUSE_URL cannot contain credentials, a query, or a fragment.',
        path: ['CLICKHOUSE_URL'],
      });
    }
    if (
      url.protocol !== 'https:' &&
      !(value.CLICKHOUSE_ALLOW_INSECURE_HTTP && url.protocol === 'http:')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'ClickHouse requires HTTPS unless insecure HTTP is explicitly enabled.',
        path: ['CLICKHOUSE_URL'],
      });
    }
  });

export type AnalyticsProjectorConfig = z.infer<typeof schema>;

export function parseAnalyticsProjectorConfig(
  environment: NodeJS.ProcessEnv
): AnalyticsProjectorConfig {
  return schema.parse(environment);
}

export function loadAnalyticsProjectorConfig(): AnalyticsProjectorConfig {
  const rootEnvFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../.env'
  );
  if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);
  return parseAnalyticsProjectorConfig(process.env);
}
