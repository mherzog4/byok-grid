'use client';

import type {
  SqliteCredentialMetadata,
  SqliteWebhookDestinationSummary,
} from '@byok-grid/db';
import { type FormEvent, useEffect, useState } from 'react';

export function WebhookPanel({
  credentials,
  initial,
  tableId,
  workspaceId,
}: {
  credentials: SqliteCredentialMetadata[];
  initial: SqliteWebhookDestinationSummary[];
  tableId: string;
  workspaceId: string;
}) {
  const [destinations, setDestinations] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/webhooks`;
  const activeDeliveryIds = destinations
    .flatMap((destination) =>
      destination.lastDelivery &&
      ['queued', 'running'].includes(destination.lastDelivery.status)
        ? [destination.lastDelivery.id]
        : []
    )
    .sort()
    .join(',');

  useEffect(() => {
    if (!activeDeliveryIds) return;
    async function poll() {
      const response = await fetch(baseUrl);
      if (!response.ok) return;
      setDestinations(
        (await response.json()) as SqliteWebhookDestinationSummary[]
      );
    }
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => window.clearInterval(timer);
  }, [activeDeliveryIds, baseUrl]);

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
          signingCredentialId: String(data.get('signingCredentialId') ?? ''),
          triggerMode: String(data.get('triggerMode') ?? 'manual'),
          url: String(data.get('url') ?? ''),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body =
        (await response.json()) as SqliteWebhookDestinationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The webhook destination could not be created.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  async function update(
    destination: SqliteWebhookDestinationSummary,
    patch: Partial<
      Pick<SqliteWebhookDestinationSummary, 'status' | 'triggerMode'>
    >
  ) {
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${destination.id}`, {
        body: JSON.stringify(patch),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body =
        (await response.json()) as SqliteWebhookDestinationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The webhook destination could not be updated.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  const signingCredentials = credentials.filter(
    (credential) =>
      credential.connectorId === 'webhook' && !credential.revokedAt
  );

  return (
    <section className="source-panel webhook-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">OUTBOUND WEBHOOKS</p>
          <h2>Deliver enriched rows downstream</h2>
        </div>
        <p>
          Each queued row is frozen, signed, retried, and identified by one
          delivery ID.
        </p>
      </div>
      <div className="source-layout">
        <form className="source-form" method="post" onSubmit={create}>
          <label>
            Destination name
            <input name="name" placeholder="CRM intake" required />
          </label>
          <label>
            HTTPS endpoint
            <input
              name="url"
              placeholder="https://hooks.example.com/enriched-rows"
              required
              type="url"
            />
          </label>
          <label>
            Signing credential
            <select
              defaultValue={signingCredentials[0]?.id ?? ''}
              name="signingCredentialId"
              required
            >
              {signingCredentials.length === 0 ? (
                <option disabled value="">
                  Create a webhook signing credential below
                </option>
              ) : null}
              {signingCredentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delivery trigger
            <select defaultValue="manual" name="triggerMode">
              <option value="manual">Manual only</option>
              <option value="row_settled">
                Whenever a changed row settles
              </option>
            </select>
          </label>
          <small>
            Verify `X-BYOK-Grid-Signature` with the shared secret and
            deduplicate using `Idempotency-Key`.
          </small>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="primary-action"
            disabled={pending || signingCredentials.length === 0}
            type="submit"
          >
            {pending ? 'Creating…' : 'Create destination'}
          </button>
        </form>

        <div className="source-list">
          {destinations.length === 0 ? (
            <p className="credential-empty">No webhook destinations yet.</p>
          ) : (
            destinations.map((destination) => (
              <article key={destination.id}>
                <div className="source-summary">
                  <div>
                    <strong>{destination.name}</strong>
                    <span>{destinationHostname(destination.endpointUrl)}</span>
                  </div>
                  <span data-status={destination.status}>
                    {destination.status}
                  </span>
                </div>
                <p>
                  Trigger:{' '}
                  {destination.triggerMode === 'row_settled'
                    ? 'whenever a changed row settles'
                    : 'manual only'}
                </p>
                {destination.lastDelivery ? (
                  <p>
                    <span data-status={destination.lastDelivery.status}>
                      {destination.lastDelivery.status}
                    </span>{' '}
                    · row {destination.lastDelivery.rowId.slice(0, 8)} · attempt{' '}
                    {destination.lastDelivery.attempt}
                    {' · '}
                    {destination.lastDelivery.triggerMode === 'row_settled'
                      ? 'automatic'
                      : 'manual'}
                    {destination.lastDelivery.responseStatus
                      ? ` · HTTP ${destination.lastDelivery.responseStatus}`
                      : ''}
                    {destination.lastDelivery.errorMessage
                      ? ` · ${destination.lastDelivery.errorMessage}`
                      : ''}
                  </p>
                ) : (
                  <p>No rows delivered yet.</p>
                )}
                <div className="source-actions">
                  <button
                    onClick={() =>
                      void update(destination, {
                        status:
                          destination.status === 'active' ? 'paused' : 'active',
                      })
                    }
                    type="button"
                  >
                    {destination.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    onClick={() =>
                      void update(destination, {
                        triggerMode:
                          destination.triggerMode === 'manual'
                            ? 'row_settled'
                            : 'manual',
                      })
                    }
                    type="button"
                  >
                    {destination.triggerMode === 'manual'
                      ? 'Enable automatic delivery'
                      : 'Use manual delivery'}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function destinationHostname(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).hostname;
  } catch {
    return 'Invalid webhook URL';
  }
}
