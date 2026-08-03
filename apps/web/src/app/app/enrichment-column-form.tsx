'use client';

import type { CredentialMetadata, GridSnapshot } from '@byok-grid/db';
import { type FormEvent, useState } from 'react';

export function EnrichmentColumnForm({
  columns,
  credentials,
  tableId,
  workspaceId,
}: {
  columns: GridSnapshot['columns'];
  credentials: CredentialMetadata[];
  tableId: string;
  workspaceId: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inputColumns = columns.filter((column) => column.kind !== 'function');
  const activeCredentials = credentials.filter(
    (credential) => !credential.revokedAt && credential.connectorId === 'http'
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credentialId = String(data.get('credentialId') ?? '');
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/tables/${tableId}/columns/http`,
        {
          body: JSON.stringify({
            baseUrl: String(data.get('baseUrl') ?? ''),
            credentialId: credentialId || null,
            inputColumnId: String(data.get('inputColumnId') ?? ''),
            name: String(data.get('name') ?? ''),
            queryParameter: String(data.get('queryParameter') ?? ''),
            runMode: String(data.get('runMode') ?? 'manual'),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(
          body.error ?? 'The enrichment column could not be created.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  return (
    <section className="enrichment-config">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">ENRICHMENT COLUMN</p>
          <h2>Connect an HTTPS lookup</h2>
        </div>
        <p>The source value is appended as one query parameter per run.</p>
      </div>
      <form className="enrichment-form" method="post" onSubmit={create}>
        <label>
          Column name
          <input name="name" placeholder="Firmographics" required />
        </label>
        <label>
          HTTPS endpoint
          <input
            name="baseUrl"
            placeholder="https://api.example.com/company"
            required
            type="url"
          />
        </label>
        <label>
          Source column
          <select name="inputColumnId" required>
            {inputColumns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Query parameter
          <input name="queryParameter" placeholder="domain" required />
        </label>
        <label>
          Credential
          <select name="credentialId">
            <option value="">No authentication</option>
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
            Automatic runs can use provider credits whenever this source
            changes.
          </span>
        </label>
        <div className="enrichment-submit">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Creating…' : 'Add enrichment column'}
          </button>
        </div>
      </form>
    </section>
  );
}
