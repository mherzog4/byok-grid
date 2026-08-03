import { createDatabase } from '@byok-grid/db/postgres';
import { config } from './config';

export const { db } = createDatabase(config.WORKER_DATABASE_URL);
