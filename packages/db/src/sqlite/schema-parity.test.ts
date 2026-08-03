import {
  getTableColumns,
  getTableName,
  is,
  Table,
  type AnyColumn,
  type AnyTable,
} from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as postgresSchema from '../schema';
import * as sqliteSchema from './schema';

function collectTables(
  module: Record<string, unknown>
): Map<string, AnyTable<{}>> {
  const tables = new Map<string, AnyTable<{}>>();
  for (const value of Object.values(module)) {
    if (is(value, Table)) tables.set(getTableName(value), value);
  }
  return tables;
}

describe('SQLite schema parity', () => {
  const postgresTables = collectTables(postgresSchema);
  const sqliteTables = collectTables(sqliteSchema);

  it('covers every PostgreSQL application table', () => {
    expect([...sqliteTables.keys()].sort()).toEqual(
      [
        ...postgresTables.keys(),
        'workflow_runs',
        'workflow_step_runs',
        'workflow_versions',
        'workflows',
      ].sort()
    );
  });

  it('preserves every physical PostgreSQL column name', () => {
    const drift: Record<string, { postgres: string[]; sqlite: string[] }> = {};
    for (const [tableName, postgresTable] of postgresTables) {
      const sqliteTable = sqliteTables.get(tableName);
      if (!sqliteTable) continue;
      const postgresColumns = (
        Object.values(getTableColumns(postgresTable)) as AnyColumn[]
      )
        .map((column) => column.name)
        .sort();
      const sqliteColumns = (
        Object.values(getTableColumns(sqliteTable)) as AnyColumn[]
      )
        .map((column) => column.name)
        .sort();
      if (JSON.stringify(postgresColumns) !== JSON.stringify(sqliteColumns)) {
        drift[tableName] = {
          postgres: postgresColumns,
          sqlite: sqliteColumns,
        };
      }
    }

    expect(drift).toEqual({});
  });
});
