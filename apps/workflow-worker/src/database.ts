import { openSqliteDatabase } from '@byok-grid/db';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { workflowWorkerConfig } from './config';

if (workflowWorkerConfig.SQLITE_DATABASE_URL.startsWith('file:')) {
  mkdirSync(
    dirname(
      resolve(workflowWorkerConfig.SQLITE_DATABASE_URL.slice('file:'.length))
    ),
    { recursive: true }
  );
}

export const workflowDatabase = await openSqliteDatabase({
  ...(workflowWorkerConfig.SQLITE_AUTH_TOKEN
    ? { authToken: workflowWorkerConfig.SQLITE_AUTH_TOKEN }
    : {}),
  url: workflowWorkerConfig.SQLITE_DATABASE_URL,
});

export const workflowDb = workflowDatabase.db;
