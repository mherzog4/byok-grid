'use client';

import type { SqliteCredentialMetadata } from '@byok-grid/db';
import { type FormEvent, useState } from 'react';
import {
  readDeclarativeCredential,
  type DeclarativeCredentialField,
} from './credential-form';

type CredentialMode = 'apiKeyHeader' | 'bearer';

interface CredentialOption {
  credentialFields?: readonly DeclarativeCredentialField[];
  credentialName: string;
  displayName: string;
  id: string;
}

export function CredentialPanel({
  connectors,
  initial,
  workspaceId,
}: {
  connectors: readonly CredentialOption[];
  initial: SqliteCredentialMetadata[];
  workspaceId: string;
}) {
  const [credentials, setCredentials] = useState(initial);
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? 'hunter');
  const [mode, setMode] = useState<CredentialMode>('bearer');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [secretValue, setSecretValue] = useState('');
  const baseUrl = `/api/workspaces/${workspaceId}/credentials`;
  const selectedConnector = connectors.find(
    (connector) => connector.id === connectorId
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = String(data.get('value') ?? '');
    const secret = selectedConnector?.credentialFields
      ? readDeclarativeCredential(selectedConnector.credentialFields, data)
      : connectorId === 'hunter' || connectorId === 'openai'
        ? { apiKey: value }
        : connectorId === 'hubspot'
          ? { accessToken: value }
          : connectorId === 'webhook'
            ? { secret: value }
            : connectorId === 'http' && mode === 'bearer'
              ? { token: value, type: 'bearer' as const }
              : connectorId === 'http'
                ? {
                    headerName: String(data.get('headerName') ?? ''),
                    type: 'apiKeyHeader' as const,
                    value,
                  }
                : { secret: value };

    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(baseUrl, {
        body: JSON.stringify({
          connectorId,
          name: String(data.get('name') ?? ''),
          secret,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'The credential could not be saved.');
      }
      const created = (await response.json()) as SqliteCredentialMetadata;
      setCredentials((current) => [created, ...current]);
      form.reset();
      setSecretValue('');
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  function generateWebhookSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
      ''
    );
    setSecretValue(
      window
        .btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
    );
  }

  async function revoke(credential: SqliteCredentialMetadata) {
    if (
      !window.confirm(`Revoke “${credential.name}”? This cannot be undone.`)
    ) {
      return;
    }
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${credential.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('The credential could not be revoked.');
      const revoked = (await response.json()) as SqliteCredentialMetadata;
      setCredentials((current) =>
        current.map((item) => (item.id === revoked.id ? revoked : item))
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  return (
    <section className="credential-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">BYOK VAULT</p>
          <h2>Provider credentials</h2>
        </div>
        <p>
          Secrets are encrypted before storage and are never displayed again.
        </p>
      </div>

      <div className="credential-layout">
        <form className="credential-form" method="post" onSubmit={save}>
          <label>
            Connector
            <select
              onChange={(event) => {
                setConnectorId(event.target.value);
                setSecretValue('');
              }}
              value={connectorId}
            >
              {connectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {connector.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Display name
            <input
              name="name"
              placeholder="Production enrichment API"
              required
            />
          </label>

          {connectorId === 'http' ? (
            <label>
              Authentication type
              <select
                onChange={(event) =>
                  setMode(event.target.value as CredentialMode)
                }
                value={mode}
              >
                <option value="bearer">Bearer token</option>
                <option value="apiKeyHeader">API key header</option>
              </select>
            </label>
          ) : null}

          {connectorId === 'http' && mode === 'apiKeyHeader' ? (
            <label>
              Header name
              <input name="headerName" placeholder="X-API-Key" required />
            </label>
          ) : null}

          {selectedConnector?.credentialFields ? (
            selectedConnector.credentialFields.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  autoComplete="off"
                  name={`credential:${field.key}`}
                  placeholder={field.placeholder}
                  required={field.required}
                  type={field.secret ? 'password' : 'text'}
                />
                <small>{field.description}</small>
              </label>
            ))
          ) : (
            <label>
              {selectedConnector?.credentialName ?? 'Secret value'}
              <input
                autoComplete="off"
                name="value"
                onChange={(event) => setSecretValue(event.currentTarget.value)}
                required
                type="password"
                value={secretValue}
              />
            </label>
          )}
          {connectorId === 'webhook' ? (
            <button onClick={generateWebhookSecret} type="button">
              Generate 256-bit secret
            </button>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Encrypting…' : 'Save credential'}
          </button>
        </form>

        <div className="credential-list">
          {credentials.length === 0 ? (
            <p className="credential-empty">No stored credentials.</p>
          ) : (
            credentials.map((credential) => (
              <article key={credential.id}>
                <div>
                  <strong>{credential.name}</strong>
                  <span>
                    {credential.connectorId} ·{' '}
                    {credential.revokedAt ? 'revoked' : 'active'}
                  </span>
                </div>
                <button
                  disabled={Boolean(credential.revokedAt)}
                  onClick={() => void revoke(credential)}
                  type="button"
                >
                  {credential.revokedAt ? 'Revoked' : 'Revoke'}
                </button>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
