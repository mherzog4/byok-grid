'use client';

import type {
  CreatedSqliteIngestionEndpoint,
  SqliteIngestionEndpointSummary,
} from '@byok-grid/db';
import { type FormEvent, useState } from 'react';

export function IngestionPanel({
  initial,
  tableId,
  workspaceId,
}: {
  initial: SqliteIngestionEndpointSummary[];
  tableId: string;
  workspaceId: string;
}) {
  const [endpoints, setEndpoints] = useState(initial);
  const [revealed, setRevealed] = useState<CreatedSqliteIngestionEndpoint>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/ingestion-endpoints`;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(baseUrl, {
        body: JSON.stringify({
          name: String(data.get('name') ?? ''),
          recordKeyField: String(data.get('recordKeyField') ?? ''),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as CreatedSqliteIngestionEndpoint & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The ingestion endpoint could not be created.'
        );
      }
      setRevealed(body);
      setEndpoints((current) => [body, ...current]);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  async function revoke(endpoint: SqliteIngestionEndpointSummary) {
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${endpoint.id}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as SqliteIngestionEndpointSummary & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The ingestion endpoint could not be revoked.'
        );
      }
      setEndpoints((current) =>
        current.map((item) => (item.id === endpoint.id ? body : item))
      );
      if (revealed?.id === endpoint.id) setRevealed(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  const endpointUrl = revealed
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/api/ingest/${revealed.id}`
    : '';
  const example = revealed
    ? `curl -X POST '${endpointUrl}' \\
  -H 'Authorization: Bearer ${revealed.token}' \\
  -H 'Idempotency-Key: airbyte-job-0001' \\
  -H 'Content-Type: application/json' \\
  --data '{"records":[{"${revealed.recordKeyField}":"company-1","name":"Acme"}]}'`
    : '';

  return (
    <section className="source-panel ingestion-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">PUSH INGESTION</p>
          <h2>Receive records from Airbyte or any ELT tool</h2>
        </div>
        <p>Each token is table-scoped, revocable, and shown only once.</p>
      </div>
      <div className="source-layout">
        <form className="source-form" method="post" onSubmit={create}>
          <label>
            Endpoint name
            <input name="name" placeholder="Airbyte companies" required />
          </label>
          <label>
            Unique record key field
            <input name="recordKeyField" placeholder="id" required />
          </label>
          <button disabled={pending} type="submit">
            {pending ? 'Creating…' : 'Create push endpoint'}
          </button>
        </form>
        <div className="source-list">
          {revealed ? (
            <article className="source-card ingestion-secret">
              <strong>Copy this configuration now</strong>
              <p>
                The bearer token cannot be recovered after this page changes.
              </p>
              <label>
                Endpoint URL
                <input readOnly value={endpointUrl} />
              </label>
              <label>
                Bearer token
                <input readOnly type="password" value={revealed.token} />
              </label>
              <pre>{example}</pre>
            </article>
          ) : null}
          {endpoints.length === 0 ? (
            <p className="credential-empty">No push endpoints yet.</p>
          ) : (
            endpoints.map((endpoint) => (
              <article className="source-card" key={endpoint.id}>
                <div>
                  <strong>{endpoint.name}</strong>
                  <span>
                    key: {endpoint.recordKeyField} · token{' '}
                    {endpoint.tokenPrefix}…
                  </span>
                </div>
                <p>
                  {endpoint.revokedAt
                    ? 'Revoked'
                    : endpoint.lastBatch
                      ? `${endpoint.lastBatch.status} · ${endpoint.lastBatch.recordCount} records`
                      : 'Ready for its first batch'}
                </p>
                {!endpoint.revokedAt ? (
                  <button onClick={() => void revoke(endpoint)} type="button">
                    Revoke
                  </button>
                ) : null}
              </article>
            ))
          )}
        </div>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}
