import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseMasterKey } from '@byok-grid/security';
import { z } from 'zod';

const rootEnvFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.env'
);
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional()
);

export const workflowWorkerConfig = z
  .object({
    AUTOMATIC_RUN_MAX_PER_ROW_CHANGE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5),
    BULK_RUN_EXPANSION_CHUNK_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50),
    BYOK_GRID_MASTER_KEY: z.string().min(1),
    BYOK_GRID_MASTER_KEY_ID: z.string().min(1),
    CONNECTOR_RUNNER_SHARED_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    CONNECTOR_RUNNER_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url().optional()
    ),
    HATCHET_CLIENT_API_URL: z.url(),
    HATCHET_CLIENT_HOST_PORT: z.string().min(1),
    HATCHET_CLIENT_TLS_STRATEGY: z.enum(['none', 'tls']).default('none'),
    HATCHET_CLIENT_TOKEN: z.string().min(1),
    HATCHET_CLIENT_WORKER_HEALTHCHECK_ENABLED: z
      .enum(['true', 'false'])
      .default('true'),
    HATCHET_CLIENT_WORKER_HEALTHCHECK_PORT: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65_535)
      .default(8001),
    SQLITE_AUTH_TOKEN: optionalSecret,
    SQLITE_DATABASE_URL: z
      .string()
      .refine(
        (value) => value.startsWith('file:') || value.startsWith('libsql://'),
        'The workflow worker requires a file: or libsql:// SQLite URL.'
      ),
    SOURCE_SCHEDULER_POLL_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(300)
      .default(30),
    WORKFLOW_DISPATCH_POLL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(1_000),
  })
  .superRefine((value, context) => {
    try {
      parseMasterKey(value.BYOK_GRID_MASTER_KEY_ID, value.BYOK_GRID_MASTER_KEY);
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'The master key must be exactly 32 bytes of canonical base64 and its ID must not be empty.',
        path: ['BYOK_GRID_MASTER_KEY'],
      });
    }

    if (
      Boolean(value.CONNECTOR_RUNNER_SHARED_SECRET) !==
      Boolean(value.CONNECTOR_RUNNER_URL)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Connector runner URL and shared secret must be configured together.',
        path: ['CONNECTOR_RUNNER_URL'],
      });
    }
  })
  .parse(process.env);
