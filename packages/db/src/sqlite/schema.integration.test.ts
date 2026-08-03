import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';

describe('SQLite foundational schema', () => {
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    handle = await openSqliteDatabase({ url: ':memory:' });
    await migrateSqliteDatabase(handle.db);

    const fixtures: Array<[string, Array<number | string>]> = [
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        ['user-a', 'a@example.test', 'A'],
      ],
      [
        'insert into workspaces (id, name, slug) values (?, ?, ?)',
        ['workspace-a', 'A', 'a'],
      ],
      [
        'insert into workspaces (id, name, slug) values (?, ?, ?)',
        ['workspace-b', 'B', 'b'],
      ],
      [
        'insert into data_tables (id, workspace_id, name) values (?, ?, ?)',
        ['table-a', 'workspace-a', 'A'],
      ],
      [
        'insert into data_tables (id, workspace_id, name) values (?, ?, ?)',
        ['table-b', 'workspace-b', 'B'],
      ],
      [
        'insert into rows (id, workspace_id, table_id, position) values (?, ?, ?, ?)',
        ['row-a', 'workspace-a', 'table-a', 'a0'],
      ],
      [
        'insert into columns (id, workspace_id, table_id, name, kind, value_type, position) values (?, ?, ?, ?, ?, ?, ?)',
        [
          'column-a',
          'workspace-a',
          'table-a',
          'Company',
          'input',
          'text',
          'a0',
        ],
      ],
      [
        'insert into columns (id, workspace_id, table_id, name, kind, value_type, position) values (?, ?, ?, ?, ?, ?, ?)',
        [
          'column-b',
          'workspace-b',
          'table-b',
          'Company',
          'input',
          'text',
          'a0',
        ],
      ],
    ];
    for (const [sql, args] of fixtures) {
      await handle.client.execute({ args, sql });
    }
  });

  afterEach(() => handle.close());

  it('rejects a cell whose column comes from another workspace', async () => {
    await expect(
      handle.client.execute({
        args: [
          'cell-a',
          'workspace-a',
          'table-a',
          'row-a',
          'column-b',
          'text',
          'Acme',
        ],
        sql: 'insert into cells (id, workspace_id, table_id, row_id, column_id, value_type, value_text) values (?, ?, ?, ?, ?, ?, ?)',
      })
    ).rejects.toThrow(/foreign key/i);
  });

  it('maintains bounded trigram search text across writes', async () => {
    await handle.client.execute({
      args: [
        'cell-a',
        'workspace-a',
        'table-a',
        'row-a',
        'column-a',
        'text',
        '100% ACME_Corp',
      ],
      sql: 'insert into cells (id, workspace_id, table_id, row_id, column_id, value_type, value_text) values (?, ?, ?, ?, ?, ?, ?)',
    });

    const initial = await handle.client.execute({
      args: ['%\\% acme\\_corp%'],
      sql: "select cells.row_id from cells_search_fts join cells on cells.rowid = cells_search_fts.rowid where cells_search_fts.search_text like ? escape '\\'",
    });
    expect(initial.rows.map((row) => row[0])).toEqual(['row-a']);

    await handle.client.execute({
      args: ['Updated Boston'],
      sql: "update cells set value_text = ? where id = 'cell-a'",
    });
    const stale = await handle.client.execute({
      args: ['%acme%'],
      sql: 'select rowid from cells_search_fts where search_text like ?',
    });
    const updated = await handle.client.execute({
      args: ['%boston%'],
      sql: 'select rowid from cells_search_fts where search_text like ?',
    });

    expect(stale.rows).toHaveLength(0);
    expect(updated.rows).toHaveLength(1);
  });

  it('caps canonical cell text at 8,192 characters', async () => {
    await handle.client.execute({
      args: [
        'cell-a',
        'workspace-a',
        'table-a',
        'row-a',
        'column-a',
        'text',
        'x'.repeat(9_000),
      ],
      sql: 'insert into cells (id, workspace_id, table_id, row_id, column_id, value_type, value_text) values (?, ?, ?, ?, ?, ?, ?)',
    });
    const result = await handle.client.execute(
      "select length(search_text) from cells where id = 'cell-a'"
    );

    expect(result.rows[0]?.[0]).toBe(8_192);
  });

  it('accepts the existing function column discriminator', async () => {
    await handle.client.execute({
      args: [
        'function-column',
        'workspace-a',
        'table-a',
        'Lookup',
        'function',
        'json',
        'b0',
      ],
      sql: 'insert into columns (id, workspace_id, table_id, name, kind, value_type, position) values (?, ?, ?, ?, ?, ?, ?)',
    });

    const result = await handle.client.execute(
      "select kind from columns where id = 'function-column'"
    );
    expect(result.rows[0]?.[0]).toBe('function');
  });

  it('enforces active invitation uniqueness but permits replacement', async () => {
    const tokenA = 'a'.repeat(64);
    const tokenB = 'b'.repeat(64);
    await handle.client.execute({
      args: [
        'invitation-a',
        'workspace-a',
        'invitee@example.test',
        'member',
        tokenA,
        Date.now() + 60_000,
      ],
      sql: 'insert into workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) values (?, ?, ?, ?, ?, ?)',
    });
    await expect(
      handle.client.execute({
        args: [
          'invitation-b',
          'workspace-a',
          'invitee@example.test',
          'member',
          tokenB,
          Date.now() + 60_000,
        ],
        sql: 'insert into workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) values (?, ?, ?, ?, ?, ?)',
      })
    ).rejects.toThrow(/unique/i);

    await handle.client.execute(
      "update workspace_invitations set revoked_at = 1 where id = 'invitation-a'"
    );
    await expect(
      handle.client.execute({
        args: [
          'invitation-b',
          'workspace-a',
          'invitee@example.test',
          'member',
          tokenB,
          Date.now() + 60_000,
        ],
        sql: 'insert into workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) values (?, ?, ?, ?, ?, ?)',
      })
    ).resolves.toBeDefined();
  });

  it('retains a purge receipt after deleting its workspace', async () => {
    await handle.client.execute({
      args: [
        'receipt-a',
        'workspace-a',
        'user-a',
        'user_requested',
        'a'.repeat(64),
        JSON.stringify({ rows: 1 }),
      ],
      sql: 'insert into workspace_purge_receipts (id, workspace_id, actor_user_id, reason, preview_digest, impact) values (?, ?, ?, ?, ?, ?)',
    });
    await handle.client.execute(
      "delete from workspaces where id = 'workspace-a'"
    );
    const result = await handle.client.execute(
      "select workspace_id from workspace_purge_receipts where id = 'receipt-a'"
    );

    expect(result.rows[0]?.[0]).toBe('workspace-a');
  });

  it('rejects malformed encrypted credential envelopes at the SQL boundary', async () => {
    await expect(
      handle.client.execute({
        args: ['credential-a', 'workspace-a', 'API key', 'hubspot', 'not-json'],
        sql: 'insert into credentials (id, workspace_id, name, connector_id, encrypted_value) values (?, ?, ?, ?, ?)',
      })
    ).rejects.toThrow(/constraint/i);
  });
});
