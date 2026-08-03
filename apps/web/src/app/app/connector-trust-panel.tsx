'use client';

import type { InstalledSandboxConnectorSummary } from '@byok-grid/connectors';
import type { SqliteConnectorRevocationSummary } from '@byok-grid/db';
import {
  connectorRevocationTargetKey,
  type ConnectorRevocationTarget,
} from '@byok-grid/domain';
import { type FormEvent, useState } from 'react';

interface TargetOption {
  key: string;
  label: string;
  target: ConnectorRevocationTarget;
}

export function ConnectorTrustPanel({
  initialRevocations,
  installed,
  workspaceId,
}: {
  initialRevocations: SqliteConnectorRevocationSummary[];
  installed: readonly InstalledSandboxConnectorSummary[];
  workspaceId: string;
}) {
  const targetOptions = buildTargetOptions(installed);
  const [revocations, setRevocations] = useState(initialRevocations);
  const [targetKey, setTargetKey] = useState(targetOptions[0]?.key ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/connector-revocations`;

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const selected = targetOptions.find((option) => option.key === targetKey);
    if (!selected) return;
    setPending(true);
    setError(undefined);
    try {
      const data = new FormData(form);
      const response = await fetch(baseUrl, {
        body: JSON.stringify({
          reason: String(data.get('reason') ?? ''),
          target: selected.target,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body =
        (await response.json()) as SqliteConnectorRevocationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(body.error ?? 'The connector could not be revoked.');
      }
      setRevocations((current) => [body, ...current]);
      form.reset();
      setTargetKey(targetOptions[0]?.key ?? '');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function lift(revocation: SqliteConnectorRevocationSummary) {
    const confirmationTargetKey = window.prompt(
      `Type ${revocation.targetKey} exactly to lift this emergency block.`
    );
    if (confirmationTargetKey === null) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${revocation.id}`, {
        body: JSON.stringify({ confirmationTargetKey }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body =
        (await response.json()) as SqliteConnectorRevocationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(body.error ?? 'The revocation could not be lifted.');
      }
      setRevocations((current) =>
        current.map((item) => (item.id === body.id ? body : item))
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="source-panel connector-trust-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">EXTENSION TRUST</p>
          <h2>Community connector transparency</h2>
        </div>
        <p>
          Inspect signed executable identity and stop compromised publishers,
          connectors, versions, or exact artifacts before execution. Dual-signed
          registries remain approved until every verified signer is blocked; use
          an artifact block for an immediate exact-code stop.
        </p>
      </div>

      <div className="connector-trust-layout">
        <div className="connector-inventory">
          {installed.length === 0 ? (
            <p className="credential-empty">
              No community connector registry is installed. Built-in connectors
              remain part of the reviewed application release.
            </p>
          ) : (
            installed.map((connector) => (
              <article key={`${connector.id}@${connector.version}`}>
                <div className="source-summary">
                  <div>
                    <strong>{connector.displayName}</strong>
                    <span>
                      {connector.id}@{connector.version} ·{' '}
                      {connector.catalog ? 'catalog' : 'retained version'}
                    </span>
                  </div>
                  <span data-status="active">installed</span>
                </div>
                <p>{connector.description}</p>
                <dl>
                  <div>
                    <dt>Artifact SHA-256</dt>
                    <dd>{connector.artifactSha256}</dd>
                  </div>
                  <div>
                    <dt>Registry SHA-256</dt>
                    <dd>
                      {connector.registrySha256 ??
                        'unsigned development registry'}
                    </dd>
                  </div>
                  <div>
                    <dt>Verified publishers</dt>
                    <dd>
                      {connector.publisherKeyIds.join(', ') ||
                        'none (unsigned development mode)'}
                    </dd>
                  </div>
                  <div>
                    <dt>Fixed egress</dt>
                    <dd>
                      {[
                        ...new Set(
                          connector.actions.flatMap((action) => action.hosts)
                        ),
                      ].join(', ') || 'none'}
                    </dd>
                  </div>
                </dl>
              </article>
            ))
          )}
        </div>

        <div className="connector-revocation-controls">
          <form method="post" onSubmit={revoke}>
            <h3>Create an emergency block</h3>
            {targetOptions.length > 0 ? (
              <>
                <label>
                  Block scope
                  <select
                    onChange={(event) =>
                      setTargetKey(event.currentTarget.value)
                    }
                    value={targetKey}
                  >
                    {targetOptions.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Incident reason
                  <textarea
                    maxLength={500}
                    minLength={8}
                    name="reason"
                    placeholder="Security advisory, compromised key, or operator investigation"
                    required
                    rows={3}
                  />
                </label>
                <button
                  className="danger-button"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? 'Applying…' : 'Apply emergency block'}
                </button>
              </>
            ) : (
              <p>No installed community target is available to block.</p>
            )}
          </form>

          <div className="connector-revocation-history">
            <h3>Revocation history</h3>
            {revocations.length === 0 ? (
              <p>No workspace connector blocks.</p>
            ) : (
              revocations.map((revocation) => (
                <article key={revocation.id}>
                  <div>
                    <strong>{revocation.targetKey}</strong>
                    <span>
                      {revocation.liftedAt ? 'lifted' : 'active'} ·{' '}
                      {formatDate(revocation.createdAt)}
                    </span>
                  </div>
                  <p>{revocation.reason}</p>
                  {!revocation.liftedAt ? (
                    <button
                      disabled={pending}
                      onClick={() => void lift(revocation)}
                      type="button"
                    >
                      Lift block
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </div>
      </div>
      {error ? (
        <p className="grid-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function buildTargetOptions(
  connectors: readonly InstalledSandboxConnectorSummary[]
): TargetOption[] {
  const options = new Map<string, TargetOption>();
  function add(label: string, target: ConnectorRevocationTarget) {
    const key = connectorRevocationTargetKey(target);
    if (!options.has(key)) options.set(key, { key, label, target });
  }
  for (const connector of connectors) {
    add(
      `Exact artifact · ${connector.displayName} ${shortDigest(connector.artifactSha256)}`,
      {
        artifactSha256: connector.artifactSha256,
        kind: 'artifact',
      }
    );
    add(`Version · ${connector.id}@${connector.version}`, {
      connectorId: connector.id,
      connectorVersion: connector.version,
      kind: 'version',
    });
    add(`All versions · ${connector.id}`, {
      connectorId: connector.id,
      kind: 'connector',
    });
    for (const publisherKeyId of connector.publisherKeyIds) {
      add(`Publisher · ${publisherKeyId}`, {
        kind: 'publisher',
        publisherKeyId,
      });
    }
  }
  return [...options.values()];
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…`;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed.';
}
