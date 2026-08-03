'use client';

import type { WorkspaceTableSummary } from '@byok-grid/db';
import {
  defaultFirstColumnName,
  type EditableInputValueType,
} from '@byok-grid/domain';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function TableManager({
  currentTable,
  tables,
  workspaceId,
}: {
  currentTable: WorkspaceTableSummary;
  tables: WorkspaceTableSummary[];
  workspaceId: string;
}) {
  const router = useRouter();
  const [operation, setOperation] = useState<'column' | 'create' | 'rename'>();
  const [error, setError] = useState<string>();
  const [newTableName, setNewTableName] = useState('');
  const [firstColumnName, setFirstColumnName] = useState(
    defaultFirstColumnName('')
  );
  const [firstColumnValueType, setFirstColumnValueType] =
    useState<EditableInputValueType>('text');
  const [currentName, setCurrentName] = useState(currentTable.name);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnValueType, setNewColumnValueType] =
    useState<EditableInputValueType>('text');
  const tableBaseUrl = `/api/workspaces/${workspaceId}/tables`;

  function navigateToTable(tableId: string) {
    const query = new URLSearchParams({
      table: tableId,
      workspace: workspaceId,
    });
    router.push(`/app?${query.toString()}`);
  }

  async function createTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOperation('create');
    setError(undefined);
    try {
      const response = await fetch(tableBaseUrl, {
        body: JSON.stringify({
          firstColumnName,
          firstColumnValueType,
          name: newTableName,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? 'The table could not be created.');
      }
      navigateToTable(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setOperation(undefined);
    }
  }

  async function renameTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOperation('rename');
    setError(undefined);
    try {
      const response = await fetch(`${tableBaseUrl}/${currentTable.id}`, {
        body: JSON.stringify({ name: currentName }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The table could not be renamed.');
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setOperation(undefined);
    }
  }

  async function createColumn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOperation('column');
    setError(undefined);
    try {
      const response = await fetch(
        `${tableBaseUrl}/${currentTable.id}/columns/input`,
        {
          body: JSON.stringify({
            name: newColumnName,
            valueType: newColumnValueType,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The column could not be created.');
      }
      setNewColumnName('');
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setOperation(undefined);
    }
  }

  return (
    <section aria-labelledby="table-manager-title" className="table-manager">
      <div className="table-manager-heading">
        <div>
          <p className="eyebrow">TABLES &amp; SCHEMA</p>
          <h2 id="table-manager-title">Shape your workspace</h2>
        </div>
        <label>
          <span>Current table</span>
          <select
            onChange={(event) => navigateToTable(event.currentTarget.value)}
            value={currentTable.id}
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-manager-actions">
        <form method="post" onSubmit={renameTable}>
          <label>
            <span>Rename current table</span>
            <input
              maxLength={120}
              onChange={(event) => setCurrentName(event.currentTarget.value)}
              required
              value={currentName}
            />
          </label>
          <button disabled={operation !== undefined} type="submit">
            {operation === 'rename' ? 'Renaming…' : 'Rename'}
          </button>
        </form>

        <form
          className="typed-column-form"
          method="post"
          onSubmit={createColumn}
        >
          <label>
            <span>Add input column</span>
            <input
              maxLength={120}
              onChange={(event) => setNewColumnName(event.currentTarget.value)}
              placeholder="Industry"
              required
              value={newColumnName}
            />
          </label>
          <label>
            <span>Column type</span>
            <select
              onChange={(event) =>
                setNewColumnValueType(
                  event.currentTarget.value as EditableInputValueType
                )
              }
              value={newColumnValueType}
            >
              <InputTypeOptions />
            </select>
          </label>
          <button disabled={operation !== undefined} type="submit">
            {operation === 'column' ? 'Adding…' : 'Add column'}
          </button>
        </form>

        <form method="post" onSubmit={createTable}>
          <label>
            <span>New table name</span>
            <input
              maxLength={120}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setNewTableName(name);
                if (!firstColumnName || firstColumnName === 'Name') {
                  setFirstColumnName(defaultFirstColumnName(name));
                }
              }}
              placeholder="Prospects"
              required
              value={newTableName}
            />
          </label>
          <label>
            <span>First column</span>
            <input
              maxLength={120}
              onChange={(event) =>
                setFirstColumnName(event.currentTarget.value)
              }
              placeholder="Name"
              required
              value={firstColumnName}
            />
          </label>
          <label>
            <span>First column type</span>
            <select
              onChange={(event) =>
                setFirstColumnValueType(
                  event.currentTarget.value as EditableInputValueType
                )
              }
              value={firstColumnValueType}
            >
              <InputTypeOptions />
            </select>
          </label>
          <button disabled={operation !== undefined} type="submit">
            {operation === 'create' ? 'Creating…' : 'Create table'}
          </button>
        </form>
      </div>

      {error ? (
        <p className="grid-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function InputTypeOptions() {
  return (
    <>
      <option value="text">Text</option>
      <option value="number">Number</option>
      <option value="boolean">True / false</option>
      <option value="timestamp">Date &amp; time</option>
      <option value="json">JSON</option>
    </>
  );
}
