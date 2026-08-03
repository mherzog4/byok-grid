import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const rootEnvFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.env'
);
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const configSchema = z
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
    BYOK_GRID_ADDITIONAL_MASTER_KEYS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional()
    ),
    CONNECTOR_RUNNER_SHARED_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    CONNECTOR_RUNNER_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url().optional()
    ),
    HATCHET_CLIENT_TOKEN: z.string().min(1),
    SOURCE_SCHEDULER_POLL_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(300)
      .default(15),
    WORKER_DATABASE_URL: z.url().startsWith('postgresql://'),
  })
  .superRefine((value, context) => {
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
  });

export const config = configSchema.parse(process.env);
