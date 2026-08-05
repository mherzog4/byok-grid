import { ensureSqliteLocalUser } from '@byok-grid/db';
import { sqliteDb } from './sqlite-database';

export const localOwner = Object.freeze({
  email: 'local-owner@byok-grid.invalid',
  id: 'local-owner',
  name: 'Local owner',
});

let provisionedOwner: Promise<typeof localOwner> | undefined;

export function getLocalOwner(): Promise<typeof localOwner> {
  provisionedOwner ??= ensureSqliteLocalUser(sqliteDb, localOwner)
    .then(() => localOwner)
    .catch((error: unknown) => {
      provisionedOwner = undefined;
      throw error;
    });
  return provisionedOwner;
}
