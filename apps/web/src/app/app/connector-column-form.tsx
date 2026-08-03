'use client';

import type {
  ConnectorLiteralInputField,
  ConnectorManifest,
} from '@byok-grid/connectors';
import type {
  SqliteCredentialMetadata,
  SqliteGridSnapshot,
} from '@byok-grid/db';
import { type FormEvent, useState } from 'react';

export function ConnectorColumnForm({
  columns,
  connectors,
  credentials,
  tableId,
  workspaceId,
}: {
  columns: SqliteGridSnapshot['columns'];
  connectors: readonly ConnectorManifest[];
  credentials: SqliteCredentialMetadata[];
  tableId: string;
  workspaceId: string;
}) {
  const actions = connectors
    .filter((connector) => connector.id !== 'http')
    .flatMap((connector) =>
      connector.actions.map((action) => ({ action, connector }))
    );
  const [selection, setSelection] = useState(
    actions[0] ? `${actions[0].connector.id}:${actions[0].action.id}` : ''
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const selected =
    actions.find(
      ({ action, connector }) => `${connector.id}:${action.id}` === selection
    ) ?? actions[0];
  const sourceColumns = columns.filter((column) => column.kind !== 'function');
  const activeCredentials = selected
    ? credentials.filter(
        (credential) =>
          !credential.revokedAt &&
          credential.connectorId === selected.connector.id
      )
    : [];

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const credentialId = String(data.get('credentialId') ?? '');

    setPending(true);
    setError(undefined);
    try {
      const inputBindings = Object.fromEntries(
        selected.action.inputFields.flatMap((field) => {
          const rawValue = String(data.get(`binding:${field.key}`) ?? '');
          if (!field.required && rawValue === '') return [];
          return [
            [
              field.key,
              field.source === 'column'
                ? { columnId: rawValue, kind: 'column' as const }
                : {
                    kind: 'literal' as const,
                    value: parseLiteralValue(field, rawValue),
                  },
            ] as const,
          ];
        })
      );
      const response = await fetch(
        `/api/workspaces/${workspaceId}/tables/${tableId}/columns/connector`,
        {
          body: JSON.stringify({
            actionId: selected.action.id,
            connectorId: selected.connector.id,
            credentialId: credentialId || null,
            inputBindings,
            name: String(data.get('name') ?? ''),
            runMode: String(data.get('runMode') ?? 'manual'),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(
          body.error ?? 'The connector column could not be created.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  if (!selected) return null;

  return (
    <section className="enrichment-config">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">CONNECTOR CATALOG</p>
          <h2>Add a provider action</h2>
        </div>
        <p>{selected.connector.description}</p>
      </div>
      <form className="enrichment-form" method="post" onSubmit={create}>
        <label>
          Provider action
          <select
            onChange={(event) => setSelection(event.target.value)}
            value={selection}
          >
            {actions.map(({ action, connector }) => (
              <option
                key={`${connector.id}:${action.id}`}
                value={`${connector.id}:${action.id}`}
              >
                {connector.displayName} · {action.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Result column name
          <input
            defaultValue={`${selected.connector.displayName} ${selected.action.name}`}
            key={selection}
            name="name"
            required
          />
        </label>
        {selected.action.inputFields.map((field) => {
          const fieldName = `binding:${field.key}`;
          return (
            <label key={field.key} title={field.description}>
              {field.label}
              {field.source === 'column' ? (
                <select name={fieldName} required={field.required}>
                  <option value="">Select a column</option>
                  {sourceColumns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
              ) : field.options?.length ? (
                <select
                  defaultValue={stringifyLiteralDefault(field)}
                  name={fieldName}
                  required={field.required}
                >
                  {!field.required ? <option value="">Not set</option> : null}
                  {field.options.map((option) => (
                    <option
                      key={String(option.value)}
                      value={String(option.value)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.multiline || field.valueType === 'json' ? (
                <textarea
                  defaultValue={stringifyLiteralDefault(field)}
                  name={fieldName}
                  required={field.required}
                  rows={field.multiline ? 4 : 2}
                />
              ) : (
                <input
                  defaultValue={stringifyLiteralDefault(field)}
                  name={fieldName}
                  required={field.required}
                  type={field.valueType === 'number' ? 'number' : 'text'}
                />
              )}
            </label>
          );
        })}
        <label>
          {selected.connector.credentialName}
          <select
            name="credentialId"
            required={selected.connector.credentialRequired}
          >
            {!selected.connector.credentialRequired ? (
              <option value="">No credential</option>
            ) : null}
            {activeCredentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run behavior
          <select defaultValue="manual" name="runMode">
            <option value="manual">Manual only</option>
            <option value="on_change">Automatically when inputs change</option>
          </select>
          <span className="field-hint">
            Automatic runs may consume provider credits on every input change.
          </span>
        </label>
        <div className="enrichment-submit">
          {activeCredentials.length === 0 &&
          selected.connector.credentialRequired ? (
            <p className="form-error">
              Save a {selected.connector.displayName} credential first.
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="primary-action"
            disabled={
              pending ||
              (selected.connector.credentialRequired &&
                activeCredentials.length === 0)
            }
            type="submit"
          >
            {pending ? 'Creating…' : 'Add provider column'}
          </button>
        </div>
      </form>
    </section>
  );
}

function parseLiteralValue(
  field: ConnectorLiteralInputField,
  rawValue: string
) {
  if (field.valueType === 'boolean') return rawValue === 'true';
  if (field.valueType === 'number') {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`${field.label} must be a finite number.`);
    }
    return value;
  }
  if (field.valueType === 'json') {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      throw new Error(`${field.label} must contain valid JSON.`);
    }
  }
  return rawValue;
}

function stringifyLiteralDefault(field: ConnectorLiteralInputField): string {
  if (field.defaultValue === undefined) return '';
  return field.valueType === 'json'
    ? JSON.stringify(field.defaultValue)
    : String(field.defaultValue);
}
