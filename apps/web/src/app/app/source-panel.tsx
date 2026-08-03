'use client';

import type {
  SqliteCredentialMetadata,
  SqliteSourceRunSummary,
  SqliteSourceSummary,
} from '@byok-grid/db';
import type { SourceSchedule } from '@byok-grid/domain';
import { type FormEvent, useEffect, useState } from 'react';

const scheduleLabels: Readonly<Record<SourceSchedule, string>> = {
  manual: 'Manual only',
  every_15_minutes: 'Every 15 minutes',
  hourly: 'Hourly',
  every_6_hours: 'Every 6 hours',
  daily: 'Daily',
};

type SourceAdapterId = 'http_json' | 'hubspot_contacts';

export function SourcePanel({
  credentials,
  initial,
  tableId,
  workspaceId,
}: {
  credentials: SqliteCredentialMetadata[];
  initial: SqliteSourceSummary[];
  tableId: string;
  workspaceId: string;
}) {
  const [sources, setSources] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [paginationMode, setPaginationMode] = useState<'cursor' | 'none'>(
    'none'
  );
  const [adapterId, setAdapterId] = useState<SourceAdapterId>('http_json');
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/sources`;
  const activeRunIds = sources
    .flatMap((source) =>
      source.lastRun && ['queued', 'running'].includes(source.lastRun.status)
        ? [source.lastRun.id]
        : []
    )
    .sort()
    .join(',');

  useEffect(() => {
    if (!activeRunIds) return;
    const activeIds = new Set(activeRunIds.split(','));
    async function poll() {
      const response = await fetch(baseUrl);
      if (!response.ok) return;
      const latest = (await response.json()) as SqliteSourceSummary[];
      if (
        latest.some(
          (source) =>
            source.lastRun &&
            activeIds.has(source.lastRun.id) &&
            source.lastRun.status === 'succeeded'
        )
      ) {
        window.location.reload();
        return;
      }
      setSources(latest);
    }
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => window.clearInterval(timer);
  }, [activeRunIds, baseUrl]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const credentialId = String(data.get('credentialId') ?? '');
      const requestBody =
        adapterId === 'hubspot_contacts'
          ? {
              adapterId,
              credentialId,
              initialSyncFrom: new Date(
                String(data.get('initialSyncFrom') ?? '')
              ).toISOString(),
              maxPages: Number(data.get('maxPages')),
              maxRecords: Number(data.get('maxRecords')),
              name: String(data.get('name') ?? ''),
              properties: String(data.get('properties') ?? '')
                .split(/[\s,]+/)
                .map((property) => property.trim())
                .filter(Boolean),
              schedule: String(data.get('schedule') ?? 'manual'),
            }
          : {
              credentialId: credentialId || null,
              maxRecords: Number(data.get('maxRecords')),
              missingRecordMode: String(
                data.get('missingRecordMode') ?? 'preserve'
              ),
              name: String(data.get('name') ?? ''),
              pagination:
                paginationMode === 'cursor'
                  ? {
                      cursorParameter: String(
                        data.get('cursorParameter') ?? ''
                      ),
                      maxPages: Number(data.get('maxPages')),
                      mode: 'cursor' as const,
                      nextCursorPath: String(data.get('nextCursorPath') ?? ''),
                    }
                  : { mode: 'none' as const },
              recordKeyField: String(data.get('recordKeyField') ?? ''),
              recordPath: String(data.get('recordPath') ?? ''),
              schedule: String(data.get('schedule') ?? 'manual'),
              url: String(data.get('url') ?? ''),
            };
      const response = await fetch(baseUrl, {
        body: JSON.stringify(requestBody),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const responseBody = (await response.json()) as SqliteSourceSummary & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          responseBody.error ?? 'The source could not be created.'
        );
      setSources((current) => [responseBody, ...current]);
      form.reset();
      setPaginationMode('none');
      setAdapterId('http_json');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  async function run(source: SqliteSourceSummary) {
    await mutateSource(
      source,
      `${baseUrl}/${source.id}/runs`,
      { method: 'POST' },
      (runSummary) => ({
        ...source,
        lastRun: runSummary as SqliteSourceRunSummary,
      })
    );
  }

  async function toggle(source: SqliteSourceSummary) {
    const status = source.status === 'active' ? 'paused' : 'active';
    await mutateSource(
      source,
      `${baseUrl}/${source.id}`,
      {
        body: JSON.stringify({ status }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      },
      (updated) => ({
        ...(updated as SqliteSourceSummary),
        lastRun: source.lastRun,
      })
    );
  }

  async function mutateSource(
    source: SqliteSourceSummary,
    url: string,
    init: RequestInit,
    merge: (
      body: SqliteSourceSummary | SqliteSourceRunSummary
    ) => SqliteSourceSummary
  ) {
    setError(undefined);
    try {
      const response = await fetch(url, init);
      const body = (await response.json()) as (
        SqliteSourceSummary | SqliteSourceRunSummary
      ) & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? 'The source could not be updated.');
      setSources((current) =>
        current.map((item) => (item.id === source.id ? merge(body) : item))
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    }
  }

  return (
    <section className="source-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">SCHEDULED SOURCES</p>
          <h2>Sync provider data into this table</h2>
        </div>
        <p>
          Use native incremental CRM sync or a provider-neutral HTTPS source.
          Stable record keys always update the same rows.
        </p>
      </div>
      <div className="source-layout">
        <form className="source-form" method="post" onSubmit={create}>
          <label>
            Source adapter
            <select
              onChange={(event) =>
                setAdapterId(event.currentTarget.value as SourceAdapterId)
              }
              value={adapterId}
            >
              <option value="http_json">HTTPS JSON API</option>
              <option value="hubspot_contacts">
                HubSpot contacts (incremental)
              </option>
            </select>
          </label>
          <label>
            Source name
            <input
              name="name"
              placeholder={
                adapterId === 'hubspot_contacts'
                  ? 'HubSpot contacts'
                  : 'CRM companies'
              }
              required
            />
          </label>
          <label>
            Schedule
            <select defaultValue="manual" name="schedule">
              {Object.entries(scheduleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maximum records per run
            <input
              defaultValue="1000"
              max="5000"
              min="1"
              name="maxRecords"
              required
              type="number"
            />
          </label>
          {adapterId === 'hubspot_contacts' ? (
            <>
              <label>
                HubSpot properties
                <input
                  defaultValue="email, firstname, lastname, company, jobtitle, phone"
                  name="properties"
                  required
                />
                <small>
                  Comma-separated internal property names. Contact ID and
                  provider timestamps are added automatically.
                </small>
              </label>
              <label>
                Initial sync starts at
                <input
                  defaultValue={defaultHubSpotInitialSyncFrom()}
                  name="initialSyncFrom"
                  required
                  type="datetime-local"
                />
              </label>
              <label>
                Maximum pages per run
                <input
                  defaultValue="10"
                  max="25"
                  min="2"
                  name="maxPages"
                  required
                  type="number"
                />
              </label>
              <label>
                HubSpot credential
                <select defaultValue="" name="credentialId" required>
                  <option disabled value="">
                    Select a private app token
                  </option>
                  {credentials
                    .filter(
                      (credential) =>
                        credential.connectorId === 'hubspot' &&
                        !credential.revokedAt
                    )
                    .map((credential) => (
                      <option key={credential.id} value={credential.id}>
                        {credential.name}
                      </option>
                    ))}
                </select>
              </label>
              <small className="source-pagination-note">
                Every run freezes an update window and advances its watermark
                only after the last page. Deleted contacts are not inferred from
                an incremental response.
              </small>
            </>
          ) : (
            <>
              <label>
                HTTPS JSON endpoint
                <input
                  name="url"
                  placeholder="https://api.example.com/companies"
                  required
                  type="url"
                />
              </label>
              <label>
                Record array path
                <input
                  name="recordPath"
                  placeholder="data.companies (blank for root)"
                />
              </label>
              <label>
                Unique record key field
                <input name="recordKeyField" placeholder="id" required />
              </label>
              <label>
                Records missing from a completed run
                <select defaultValue="preserve" name="missingRecordMode">
                  <option value="preserve">
                    Keep existing rows (recommended)
                  </option>
                  <option value="archive">
                    Archive rows until the record reappears
                  </option>
                </select>
              </label>
              <label>
                Pagination
                <select
                  name="paginationMode"
                  onChange={(event) =>
                    setPaginationMode(event.target.value as 'cursor' | 'none')
                  }
                  value={paginationMode}
                >
                  <option value="none">Single response</option>
                  <option value="cursor">Cursor from response</option>
                </select>
              </label>
              {paginationMode === 'cursor' ? (
                <>
                  <label>
                    Cursor query parameter
                    <input
                      defaultValue="cursor"
                      name="cursorParameter"
                      placeholder="after"
                      required
                    />
                  </label>
                  <label>
                    Next cursor path
                    <input
                      name="nextCursorPath"
                      placeholder="meta.next_cursor"
                      required
                    />
                  </label>
                  <label>
                    Maximum pages per run
                    <input
                      defaultValue="10"
                      max="25"
                      min="2"
                      name="maxPages"
                      required
                      type="number"
                    />
                  </label>
                  <small className="source-pagination-note">
                    The API must return a string, number, or null at the cursor
                    path. Cursors are encrypted between pages.
                  </small>
                </>
              ) : null}
              <label>
                HTTP credential
                <select defaultValue="" name="credentialId">
                  <option value="">No authentication</option>
                  {credentials
                    .filter(
                      (credential) =>
                        credential.connectorId === 'http' &&
                        !credential.revokedAt
                    )
                    .map((credential) => (
                      <option key={credential.id} value={credential.id}>
                        {credential.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Creating…' : 'Create source'}
          </button>
        </form>

        <div className="source-list">
          {sources.length === 0 ? (
            <p className="credential-empty">No scheduled sources yet.</p>
          ) : (
            sources.map((source) => (
              <article key={source.id}>
                <div className="source-summary">
                  <div>
                    <strong>{source.name}</strong>
                    <span>
                      {sourceAdapterLabel(source)} ·{' '}
                      {sourceScheduleLabel(source.scheduleIntervalMinutes)} ·{' '}
                      {sourcePaginationLabel(source)} ·{' '}
                      {source.adapterId === 'hubspot_contacts'
                        ? source.incrementalWatermark
                          ? `watermark ${new Date(source.incrementalWatermark).toLocaleString()}`
                          : 'initial sync pending'
                        : source.missingRecordMode === 'archive'
                          ? 'archive missing'
                          : 'preserve missing'}
                    </span>
                  </div>
                  <span data-status={source.status}>{source.status}</span>
                </div>
                {source.lastRun ? (
                  <SourceRunStatus run={source.lastRun} />
                ) : (
                  <p>Never run.</p>
                )}
                <div className="source-actions">
                  <button
                    disabled={
                      source.status !== 'active' ||
                      ['queued', 'running'].includes(
                        source.lastRun?.status ?? ''
                      )
                    }
                    onClick={() => void run(source)}
                    type="button"
                  >
                    Run now
                  </button>
                  <button onClick={() => void toggle(source)} type="button">
                    {source.status === 'active' ? 'Pause' : 'Resume'}
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

function SourceRunStatus({ run }: { run: SqliteSourceRunSummary }) {
  return (
    <p>
      <span data-status={run.status}>{run.status}</span> ·{' '}
      {run.receivedRecordCount.toLocaleString()} received ·{' '}
      {run.pageCount.toLocaleString()} pages ·{' '}
      {run.createdRowCount.toLocaleString()} new ·{' '}
      {run.updatedRowCount.toLocaleString()} updated ·{' '}
      {run.archivedRowCount.toLocaleString()} archived ·{' '}
      {run.restoredRowCount.toLocaleString()} restored
      {run.errorMessage ? ` · ${run.errorMessage}` : ''}
    </p>
  );
}

function sourceScheduleLabel(intervalMinutes: number | null): string {
  if (intervalMinutes === null) return scheduleLabels.manual;
  if (intervalMinutes === 15) return scheduleLabels.every_15_minutes;
  if (intervalMinutes === 60) return scheduleLabels.hourly;
  if (intervalMinutes === 360) return scheduleLabels.every_6_hours;
  if (intervalMinutes === 1_440) return scheduleLabels.daily;
  return `Every ${intervalMinutes} minutes`;
}

function sourceHostname(endpointUrl: string): string {
  try {
    return new URL(endpointUrl).hostname;
  } catch {
    return 'Invalid source URL';
  }
}

function sourceAdapterLabel(source: SqliteSourceSummary): string {
  return source.adapterId === 'hubspot_contacts'
    ? 'HubSpot contacts'
    : sourceHostname(source.endpointUrl);
}

function sourcePaginationLabel(source: SqliteSourceSummary): string {
  if (source.adapterId === 'hubspot_contacts') {
    return `incremental · max ${source.pagination.mode === 'cursor' ? source.pagination.maxPages : 1} pages`;
  }
  return source.pagination.mode === 'cursor'
    ? `cursor · max ${source.pagination.maxPages} pages`
    : 'single response';
}

/**
 * CONTRIBUTOR DECISION POINT: this lookback balances a useful first import
 * against rate-limit and row-volume surprises in established CRM portals.
 */
function defaultHubSpotInitialSyncFrom(): string {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  return thirtyDaysAgo.toISOString().slice(0, 16);
}
