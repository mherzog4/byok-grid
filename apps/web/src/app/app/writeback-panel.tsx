'use client';

import type {
  GridSnapshot,
  SqliteCredentialMetadata,
  SqliteWritebackDestinationSummary,
} from '@byok-grid/db';
import type { WritebackTriggerMode } from '@byok-grid/domain';
import { type FormEvent, useEffect, useState } from 'react';
import {
  createFilterGroupDraft,
  filterTreeDraftToValue,
  FilterTreeEditor,
  type FilterGroupDraft,
} from './filter-tree-editor';

interface MappingDraft {
  columnId: string;
  id: string;
  propertyName: string;
}

export function WritebackPanel({
  columns,
  credentials,
  initial,
  tableId,
  workspaceId,
}: {
  columns: GridSnapshot['columns'];
  credentials: SqliteCredentialMetadata[];
  initial: SqliteWritebackDestinationSummary[];
  tableId: string;
  workspaceId: string;
}) {
  const writableColumns = columns.filter(
    (column) => column.valueType !== 'json'
  );
  const recordIdColumns = writableColumns.filter((column) =>
    ['number', 'text'].includes(column.valueType)
  );
  const [destinations, setDestinations] = useState(initial);
  const [mappings, setMappings] = useState<MappingDraft[]>([
    newMapping(writableColumns[0]?.id ?? ''),
  ]);
  const [filterTree, setFilterTree] = useState<FilterGroupDraft>(() =>
    createFilterGroupDraft(columns[0])
  );
  const [triggerMode, setTriggerMode] =
    useState<WritebackTriggerMode>('manual');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/writebacks`;
  const hubSpotCredentials = credentials.filter(
    (credential) =>
      credential.connectorId === 'hubspot' && !credential.revokedAt
  );
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
        (await response.json()) as SqliteWritebackDestinationSummary[]
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
          credentialId: String(data.get('credentialId') ?? ''),
          fieldMappings: mappings.map(({ columnId, propertyName }) => ({
            columnId,
            propertyName,
          })),
          filterTree:
            triggerMode === 'row_settled'
              ? filterTreeDraftToValue(filterTree)
              : { children: [], combinator: 'and' },
          name: String(data.get('name') ?? ''),
          recordIdColumnId: String(data.get('recordIdColumnId') ?? ''),
          triggerMode,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body =
        (await response.json()) as SqliteWritebackDestinationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The HubSpot writeback could not be created.'
        );
      }
      setDestinations((current) => [body, ...current]);
      form.reset();
      setMappings([newMapping(writableColumns[0]?.id ?? '')]);
      setFilterTree(createFilterGroupDraft(columns[0]));
      setTriggerMode('manual');
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  async function toggle(destination: SqliteWritebackDestinationSummary) {
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${destination.id}`, {
        body: JSON.stringify({
          status: destination.status === 'active' ? 'paused' : 'active',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      });
      const body =
        (await response.json()) as SqliteWritebackDestinationSummary & {
          error?: string;
        };
      if (!response.ok) {
        throw new Error(body.error ?? 'The writeback could not be updated.');
      }
      setDestinations((current) =>
        current.map((item) => (item.id === body.id ? body : item))
      );
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  function updateMapping(id: string, patch: Partial<MappingDraft>) {
    setMappings((current) =>
      current.map((mapping) =>
        mapping.id === id ? { ...mapping, ...patch } : mapping
      )
    );
  }

  return (
    <section className="source-panel writeback-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">CRM WRITEBACK</p>
          <h2>Update HubSpot contacts</h2>
        </div>
        <p>
          Map frozen grid values to contact properties using your private app
          token.
        </p>
      </div>
      <div className="source-layout">
        <form className="source-form" method="post" onSubmit={create}>
          <label>
            Destination name
            <input
              name="name"
              placeholder="Enriched HubSpot contacts"
              required
            />
          </label>
          <label>
            HubSpot record ID column
            <select
              defaultValue={recordIdColumns[0]?.id ?? ''}
              name="recordIdColumnId"
              required
            >
              {recordIdColumns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            HubSpot credential
            <select
              defaultValue={hubSpotCredentials[0]?.id ?? ''}
              name="credentialId"
              required
            >
              {hubSpotCredentials.length === 0 ? (
                <option disabled value="">
                  Save a HubSpot token below
                </option>
              ) : null}
              {hubSpotCredentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delivery trigger
            <select
              name="triggerMode"
              onChange={(event) =>
                setTriggerMode(
                  event.currentTarget.value as WritebackTriggerMode
                )
              }
              value={triggerMode}
            >
              <option value="manual">Manual only</option>
              <option value="row_settled">
                Automatically when a matching row settles
              </option>
            </select>
          </label>
          <fieldset className="writeback-mappings">
            <legend>Contact property mappings</legend>
            {mappings.map((mapping, index) => (
              <div className="writeback-mapping" key={mapping.id}>
                <label>
                  Grid column {index + 1}
                  <select
                    onChange={(event) =>
                      updateMapping(mapping.id, {
                        columnId: event.currentTarget.value,
                      })
                    }
                    value={mapping.columnId}
                  >
                    {writableColumns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  HubSpot property
                  <input
                    onChange={(event) =>
                      updateMapping(mapping.id, {
                        propertyName: event.currentTarget.value,
                      })
                    }
                    placeholder="company"
                    required
                    value={mapping.propertyName}
                  />
                </label>
                {mappings.length > 1 ? (
                  <button
                    onClick={() =>
                      setMappings((current) =>
                        current.filter((item) => item.id !== mapping.id)
                      )
                    }
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <button
              disabled={mappings.length >= 50}
              onClick={() =>
                setMappings((current) => [
                  ...current,
                  newMapping(writableColumns[0]?.id ?? ''),
                ])
              }
              type="button"
            >
              Add property mapping
            </button>
          </fieldset>
          {triggerMode === 'row_settled' ? (
            <div className="writeback-condition">
              <FilterTreeEditor
                columns={columns}
                emptyMessage="Add at least one condition before enabling automatic writeback."
                onChange={setFilterTree}
                value={filterTree}
              />
            </div>
          ) : null}
          <small>
            Empty cells clear the mapped HubSpot property. JSON cells are not
            eligible for writeback. Automatic delivery runs only after the row
            settles, only after a relevant column changes, and suppresses an
            identical payload already sent for that destination and row.
          </small>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="primary-action"
            disabled={
              pending ||
              hubSpotCredentials.length === 0 ||
              recordIdColumns.length === 0
            }
            type="submit"
          >
            {pending ? 'Creating…' : 'Create HubSpot writeback'}
          </button>
        </form>

        <div className="source-list">
          {destinations.length === 0 ? (
            <p className="credential-empty">No HubSpot writebacks yet.</p>
          ) : (
            destinations.map((destination) => (
              <article key={destination.id}>
                <div className="source-summary">
                  <div>
                    <strong>{destination.name}</strong>
                    <span>
                      HubSpot contacts · {destination.fieldMappings.length}{' '}
                      properties
                    </span>
                  </div>
                  <span data-status={destination.status}>
                    {destination.status}
                  </span>
                </div>
                <p>
                  Trigger:{' '}
                  {destination.triggerMode === 'row_settled'
                    ? 'automatic when its row condition matches'
                    : 'manual only'}
                </p>
                {destination.lastDelivery ? (
                  <p>
                    <span data-status={destination.lastDelivery.status}>
                      {destination.lastDelivery.status}
                    </span>{' '}
                    · row {destination.lastDelivery.rowId.slice(0, 8)} · attempt{' '}
                    {destination.lastDelivery.attempt}
                    {destination.lastDelivery.responseStatus
                      ? ` · HTTP ${destination.lastDelivery.responseStatus}`
                      : ''}
                    {destination.lastDelivery.errorMessage
                      ? ` · ${destination.lastDelivery.errorMessage}`
                      : ''}
                    {' · '}
                    {destination.lastDelivery.triggerMode === 'row_settled'
                      ? 'automatic'
                      : 'manual'}
                  </p>
                ) : (
                  <p>No contacts updated yet.</p>
                )}
                <div className="source-actions">
                  <button
                    onClick={() => void toggle(destination)}
                    type="button"
                  >
                    {destination.status === 'active' ? 'Pause' : 'Resume'}
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

function newMapping(columnId: string): MappingDraft {
  return { columnId, id: crypto.randomUUID(), propertyName: '' };
}
