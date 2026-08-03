'use client';

import type { CredentialMetadata, GridSnapshot } from '@byok-grid/db';
import { type FormEvent, useState } from 'react';

export function WaterfallColumnForm({
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
  const sourceColumns = columns.filter((column) => column.kind !== 'function');
  const activeCredentials = credentials.filter(
    (credential) => !credential.revokedAt && credential.connectorId === 'http'
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      const providers = [1, 2].map((index) => {
        const credentialId = String(data.get(`credentialId${index}`) ?? '');
        return {
          baseUrl: String(data.get(`baseUrl${index}`) ?? ''),
          credentialId: credentialId || null,
          name: String(data.get(`providerName${index}`) ?? ''),
          queryParameter: String(data.get(`queryParameter${index}`) ?? ''),
          resultPath: String(data.get(`resultPath${index}`) ?? ''),
        };
      });
      const response = await fetch(
        `/api/workspaces/${workspaceId}/tables/${tableId}/columns/waterfall`,
        {
          body: JSON.stringify({
            inputColumnId: String(data.get('inputColumnId') ?? ''),
            name: String(data.get('name') ?? ''),
            providers,
            runMode: String(data.get('runMode') ?? 'manual'),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(
          body.error ?? 'The waterfall column could not be created.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  return (
    <section className="waterfall-config">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">PROVIDER WATERFALL</p>
          <h2>Try providers in order</h2>
        </div>
        <p>
          A missing result continues to provider two. Rate limits retry the
          current provider.
        </p>
      </div>
      <form className="waterfall-form" method="post" onSubmit={create}>
        <div className="waterfall-basics">
          <label>
            Column name
            <input name="name" placeholder="Company waterfall" required />
          </label>
          <label>
            Source column
            <select name="inputColumnId" required>
              {sourceColumns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Run behavior
            <select defaultValue="manual" name="runMode">
              <option value="manual">Manual only</option>
              <option value="on_change">
                Automatically when inputs change
              </option>
            </select>
            <span className="field-hint">
              One change may use credits from multiple providers.
            </span>
          </label>
        </div>
        <div className="waterfall-providers">
          {[1, 2].map((index) => (
            <fieldset key={index}>
              <legend>{index}. Provider</legend>
              <label>
                Display name
                <input
                  name={`providerName${index}`}
                  placeholder={
                    index === 1 ? 'Primary data API' : 'Fallback data API'
                  }
                  required
                />
              </label>
              <label>
                HTTPS endpoint
                <input
                  name={`baseUrl${index}`}
                  placeholder="https://api.example.com/company"
                  required
                  type="url"
                />
              </label>
              <label>
                Query parameter
                <input
                  name={`queryParameter${index}`}
                  placeholder="domain"
                  required
                />
              </label>
              <label>
                Result path
                <input
                  name={`resultPath${index}`}
                  placeholder="body.company"
                  required
                />
              </label>
              <label>
                Credential
                <select name={`credentialId${index}`}>
                  <option value="">No authentication</option>
                  {activeCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}
        </div>
        <div className="waterfall-submit">
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="primary-action"
            disabled={pending || sourceColumns.length === 0}
            type="submit"
          >
            {pending ? 'Creating…' : 'Add waterfall column'}
          </button>
        </div>
      </form>
    </section>
  );
}
