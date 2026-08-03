'use client';

import type {
  GridSnapshot,
  SqliteBulkRunPreview,
  SqliteWebhookDestinationSummary,
  SqliteWritebackDestinationSummary,
} from '@byok-grid/db';
import {
  editableInputValueTypeSchema,
  formatEditableCellDraft,
  gridSearchQuerySchema,
  MAXIMUM_EDITABLE_CELL_BYTES,
  parseEditableCellDraft,
  type BulkRunMode,
  type BulkRunSelectionSnapshot,
  type CellValue,
  type EditableInputValueType,
} from '@byok-grid/domain';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';

export function GridEditor({
  initial,
  webhookDestinations,
  writebackDestinations,
}: {
  initial: GridSnapshot;
  webhookDestinations: SqliteWebhookDestinationSummary[];
  writebackDestinations: SqliteWritebackDestinationSummary[];
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState<string>();
  const [addingRow, setAddingRow] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchDraft, setSearchDraft] = useState(initial.searchQuery ?? '');
  const [searching, setSearching] = useState(false);
  const [runningCell, setRunningCell] = useState<string>();
  const [savingCell, setSavingCell] = useState<string>();
  const activeWebhookDestinations = webhookDestinations.filter(
    (destination) => destination.status === 'active'
  );
  const [webhookDestinationId, setWebhookDestinationId] = useState(
    activeWebhookDestinations[0]?.id ?? ''
  );
  const activeWritebackDestinations = writebackDestinations.filter(
    (destination) => destination.status === 'active'
  );
  const [writebackDestinationId, setWritebackDestinationId] = useState(
    activeWritebackDestinations[0]?.id ?? ''
  );
  const [deliveringRow, setDeliveringRow] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const firstConnectorColumn = initial.columns.find(
    (column) => column.kind === 'connector'
  );
  const [bulkColumnId, setBulkColumnId] = useState(
    firstConnectorColumn?.id ?? ''
  );
  const [bulkMode, setBulkMode] = useState<BulkRunMode>('pending');
  const [bulkRowLimit, setBulkRowLimit] = useState(100);
  const [bulkPreview, setBulkPreview] = useState<SqliteBulkRunPreview>();
  const [bulkBatch, setBulkBatch] = useState<BulkRunProgress>();
  const [previewingBulk, setPreviewingBulk] = useState(false);
  const [startingBulk, setStartingBulk] = useState(false);
  const [cancellingBulk, setCancellingBulk] = useState(false);
  const gridScrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSnapshot(initial);
    setSearchDraft(initial.searchQuery ?? '');
    setBulkPreview(undefined);
  }, [initial]);

  const baseUrl = `/api/workspaces/${snapshot.workspaceId}/tables/${snapshot.table.id}`;
  const hasOutboundActions =
    activeWebhookDestinations.length > 0 ||
    activeWritebackDestinations.length > 0;
  const outboundActionWidth = hasOutboundActions ? 170 : 0;
  const minimumGridWidth =
    52 + snapshot.columns.length * 190 + outboundActionWidth;
  const gridTemplateColumns = `52px repeat(${snapshot.columns.length}, minmax(190px, 1fr))${outboundActionWidth ? ' 170px' : ''}`;
  // TanStack Virtual owns mutable scroll measurements; this component does not
  // pass its returned functions into compiler-memoized children.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: snapshot.rows.length,
    estimateSize: () => 47,
    getItemKey: (index) => snapshot.rows[index]?.id ?? index,
    getScrollElement: () => gridScrollRef.current,
    overscan: 10,
  });

  async function addRow() {
    setAddingRow(true);
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/rows`, { method: 'POST' });
      if (!response.ok) throw new Error('The row could not be added.');
      const row = (await response.json()) as GridSnapshot['rows'][number];
      if (snapshot.activeView || snapshot.searchQuery) router.refresh();
      else
        setSnapshot((current) => ({
          ...current,
          rows: [...current.rows, row],
        }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setAddingRow(false);
    }
  }

  async function saveInputCell(args: {
    columnId: string;
    draft: string;
    expectedVersion: number;
    rowId: string;
    valueType: EditableInputValueType;
  }) {
    const cellKey = `${args.rowId}:${args.columnId}`;
    setSavingCell(cellKey);
    setError(undefined);

    try {
      const value = parseEditableCellDraft(args.valueType, args.draft);
      const response = await fetch(
        `${baseUrl}/rows/${args.rowId}/cells/${args.columnId}`,
        {
          body: JSON.stringify({
            expectedVersion: args.expectedVersion,
            value,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'PUT',
        }
      );

      if (response.status === 409) {
        await refreshRow(args.rowId);
        throw new Error('Another edit won. The latest value has been loaded.');
      }
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'The cell could not be saved.');
      }

      if (snapshot.activeView || snapshot.searchQuery) router.refresh();
      else await refreshRow(args.rowId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setSavingCell(undefined);
    }
  }

  async function runCell(rowId: string, columnId: string) {
    const cellKey = `${rowId}:${columnId}`;
    setRunningCell(cellKey);
    setError(undefined);
    try {
      const response = await fetch(
        `${baseUrl}/rows/${rowId}/columns/${columnId}/run`,
        { method: 'POST' }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'The enrichment could not be queued.');
      }
      const queued = (await response.json()) as {
        cellId: string;
        status: 'queued';
      };
      setSnapshot((current) => ({
        ...current,
        rows: current.rows.map((row) => {
          if (row.id !== rowId) return row;
          const existing = row.cells[columnId];
          return {
            ...row,
            cells: {
              ...row.cells,
              [columnId]: {
                id: queued.cellId,
                status: 'queued',
                value: existing?.value ?? { type: 'empty', value: null },
                version: existing?.version ?? 1,
              },
            },
          };
        }),
      }));
      await pollCell(rowId, columnId);
      if (snapshot.activeView || snapshot.searchQuery) router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setRunningCell(undefined);
    }
  }

  async function previewBulkRun() {
    if (!bulkColumnId) return;
    setPreviewingBulk(true);
    setBulkPreview(undefined);
    setBulkBatch(undefined);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        mode: bulkMode,
        rowLimit: String(bulkRowLimit),
      });
      if (snapshot.activeView) query.set('view', snapshot.activeView.id);
      if (snapshot.searchQuery) query.set('search', snapshot.searchQuery);
      const response = await fetch(
        `${baseUrl}/columns/${bulkColumnId}/bulk-runs?${query}`
      );
      const body = (await response.json()) as SqliteBulkRunPreview & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? 'The bulk run could not be previewed.');
      }
      setBulkPreview(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPreviewingBulk(false);
    }
  }

  async function startBulkRun() {
    if (!bulkPreview) return;
    setStartingBulk(true);
    setError(undefined);
    try {
      const response = await fetch(
        `${baseUrl}/columns/${bulkPreview.column.id}/bulk-runs`,
        {
          body: JSON.stringify({
            expectedSelectedRows: bulkPreview.selectedRows,
            expectedSelectionDigest: bulkPreview.selectionDigest,
            mode: bulkPreview.mode,
            rowLimit: bulkPreview.requestedRowLimit,
            searchQuery: bulkPreview.selection.searchQuery,
            viewId:
              bulkPreview.selection.kind === 'saved_view'
                ? bulkPreview.selection.viewId
                : undefined,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const body = (await response.json()) as BulkRunProgress & {
        error?: string;
      };
      if (!response.ok) {
        if (response.status === 409) setBulkPreview(undefined);
        throw new Error(body.error ?? 'The bulk run could not be queued.');
      }
      setBulkBatch(body);
      setBulkPreview(undefined);
      await pollBulkRun(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setStartingBulk(false);
    }
  }

  async function pollBulkRun(batchId: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const response = await fetch(`${baseUrl}/bulk-runs/${batchId}`);
      if (!response.ok) {
        throw new Error('Bulk-run progress could not be refreshed.');
      }
      const latest = (await response.json()) as BulkRunProgress;
      setBulkBatch(latest);
      const terminalRuns = latest.runs
        ? latest.runs.succeeded + latest.runs.failed + latest.runs.cancelled
        : 0;
      if (latest.status === 'failed' || latest.status === 'cancelled') return;
      if (
        latest.status === 'completed' &&
        latest.items &&
        terminalRuns === latest.items.queued
      ) {
        await refreshFirstPage();
        return;
      }
    }
    throw new Error(
      'The bulk run is still processing. Its progress remains visible below.'
    );
  }

  async function cancelBulkRun() {
    if (
      !bulkBatch ||
      !['queued', 'running'].includes(bulkBatch.status) ||
      !window.confirm(
        'Cancel all remaining work in this bulk run? Provider requests already in flight may still complete and be billed, but their results will be discarded.'
      )
    ) {
      return;
    }
    setCancellingBulk(true);
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/bulk-runs/${bulkBatch.id}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as BulkRunProgress & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? 'The bulk run could not be cancelled.');
      }
      setBulkBatch(body);
      await refreshFirstPage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setCancellingBulk(false);
    }
  }

  async function refreshFirstPage() {
    const query = new URLSearchParams({ limit: '100' });
    if (snapshot.activeView) query.set('view', snapshot.activeView.id);
    if (snapshot.searchQuery) query.set('search', snapshot.searchQuery);
    const response = await fetch(`${baseUrl}?${query}`);
    if (!response.ok) throw new Error('The grid could not be refreshed.');
    setSnapshot((await response.json()) as GridSnapshot);
  }

  async function pollCell(rowId: string, columnId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const latest = await refreshRow(rowId);
      const status = latest.cells[columnId]?.status;
      if (
        status === 'succeeded' ||
        status === 'failed' ||
        status === 'cancelled'
      ) {
        return;
      }
    }
    throw new Error('The run is still queued. Refresh to check its status.');
  }

  async function refreshRow(
    rowId: string
  ): Promise<GridSnapshot['rows'][number]> {
    const response = await fetch(`${baseUrl}/rows/${rowId}`);
    if (!response.ok) throw new Error('The row could not be refreshed.');
    const latest = (await response.json()) as GridSnapshot['rows'][number];
    setSnapshot((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.id === rowId ? latest : row)),
    }));
    return latest;
  }

  async function loadMoreRows() {
    if (!snapshot.pageInfo.nextCursor) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        cursor: snapshot.pageInfo.nextCursor,
        limit: '100',
      });
      if (snapshot.activeView) query.set('view', snapshot.activeView.id);
      if (snapshot.searchQuery) query.set('search', snapshot.searchQuery);
      const response = await fetch(`${baseUrl}?${query.toString()}`);
      if (!response.ok) throw new Error('More rows could not be loaded.');
      const nextPage = (await response.json()) as GridSnapshot;
      setSnapshot((current) => {
        const existingIds = new Set(current.rows.map((row) => row.id));
        return {
          ...current,
          columns: nextPage.columns,
          pageInfo: nextPage.pageInfo,
          rows: [
            ...current.rows,
            ...nextPage.rows.filter((row) => !existingIds.has(row.id)),
          ],
        };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedDraft = searchDraft.trim();
    if (!trimmedDraft) {
      await loadSearch(null);
      return;
    }

    const parsed = gridSearchQuerySchema.safeParse(trimmedDraft);
    if (!parsed.success) {
      setError('Search must contain 3 to 120 normalized characters.');
      return;
    }
    await loadSearch(parsed.data);
  }

  async function loadSearch(searchQuery: string | null) {
    setSearching(true);
    setError(undefined);
    setBulkPreview(undefined);
    try {
      const query = new URLSearchParams({ limit: '100' });
      if (snapshot.activeView) query.set('view', snapshot.activeView.id);
      if (searchQuery) query.set('search', searchQuery);
      const response = await fetch(`${baseUrl}?${query}`);
      const body = (await response.json()) as GridSnapshot & { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The table could not be searched.');
      }

      setSnapshot(body);
      setSearchDraft(body.searchQuery ?? '');
      const pageUrl = new URL(window.location.href);
      if (body.searchQuery)
        pageUrl.searchParams.set('search', body.searchQuery);
      else pageUrl.searchParams.delete('search');
      window.history.replaceState(null, '', pageUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setSearching(false);
    }
  }

  function exportUrl(): string {
    const query = new URLSearchParams();
    if (snapshot.activeView) query.set('view', snapshot.activeView.id);
    if (snapshot.searchQuery) query.set('search', snapshot.searchQuery);
    const suffix = query.size > 0 ? `?${query}` : '';
    return `${baseUrl}/exports/csv${suffix}`;
  }

  async function deliverRow(rowId: string) {
    if (!webhookDestinationId) return;
    setDeliveringRow(rowId);
    setDeliveryNotice(undefined);
    setError(undefined);
    try {
      const response = await fetch(
        `${baseUrl}/webhooks/${webhookDestinationId}/deliveries`,
        {
          body: JSON.stringify({
            deliveryId: crypto.randomUUID(),
            rowId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The row could not be delivered.');
      }
      setDeliveryNotice(
        `Row queued for delivery ${body.id?.slice(0, 8) ?? ''}.`
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setDeliveringRow(undefined);
    }
  }

  async function writebackRow(rowId: string) {
    if (!writebackDestinationId) return;
    setDeliveringRow(rowId);
    setDeliveryNotice(undefined);
    setError(undefined);
    try {
      const response = await fetch(
        `${baseUrl}/writebacks/${writebackDestinationId}/deliveries`,
        {
          body: JSON.stringify({
            deliveryId: crypto.randomUUID(),
            rowId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) {
        throw new Error(
          body.error ?? 'The contact update could not be queued.'
        );
      }
      setDeliveryNotice(`HubSpot update queued ${body.id?.slice(0, 8) ?? ''}.`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setDeliveringRow(undefined);
    }
  }

  return (
    <>
      <section className="grid-toolbar">
        <div className="grid-heading">
          <p className="eyebrow">TABLE</p>
          <h2>{snapshot.table.name}</h2>
          <form
            className="grid-search"
            method="post"
            onSubmit={applySearch}
            role="search"
          >
            <label htmlFor="table-search">Search every column</label>
            <div>
              <input
                id="table-search"
                maxLength={120}
                onChange={(event) => {
                  setSearchDraft(event.currentTarget.value);
                  setBulkPreview(undefined);
                }}
                placeholder="Company, domain, city…"
                type="search"
                value={searchDraft}
              />
              <button disabled={searching} type="submit">
                {searching ? 'Searching…' : 'Search'}
              </button>
              {snapshot.searchQuery ? (
                <button
                  disabled={searching}
                  onClick={() => {
                    setSearchDraft('');
                    void loadSearch(null);
                  }}
                  type="button"
                >
                  Clear
                </button>
              ) : null}
            </div>
            <small>
              Literal, case-insensitive search · 3 character minimum
            </small>
          </form>
        </div>
        <div className="toolbar-actions">
          <a className="button-link" href={exportUrl()}>
            Export CSV
          </a>
          {snapshot.columns.some((column) => column.kind === 'connector') ? (
            <div className="bulk-run-controls">
              <label>
                <span>Enrichment column</span>
                <select
                  onChange={(event) => {
                    setBulkColumnId(event.currentTarget.value);
                    setBulkPreview(undefined);
                  }}
                  value={bulkColumnId}
                >
                  {snapshot.columns
                    .filter((column) => column.kind === 'connector')
                    .map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Rows</span>
                <input
                  max={10_000}
                  min={1}
                  onChange={(event) => {
                    setBulkRowLimit(Number(event.currentTarget.value));
                    setBulkPreview(undefined);
                  }}
                  type="number"
                  value={bulkRowLimit}
                />
              </label>
              <label>
                <span>Mode</span>
                <select
                  onChange={(event) => {
                    setBulkMode(event.currentTarget.value as BulkRunMode);
                    setBulkPreview(undefined);
                  }}
                  value={bulkMode}
                >
                  <option value="pending">Pending only</option>
                  <option value="all">Rerun completed</option>
                </select>
              </label>
              <button
                disabled={previewingBulk || startingBulk}
                onClick={() => void previewBulkRun()}
                type="button"
              >
                {previewingBulk ? 'Checking…' : 'Preview run'}
              </button>
            </div>
          ) : null}
          {activeWebhookDestinations.length > 0 ? (
            <label className="webhook-toolbar-control">
              <span>Row destination</span>
              <select
                onChange={(event) =>
                  setWebhookDestinationId(event.currentTarget.value)
                }
                value={webhookDestinationId}
              >
                {activeWebhookDestinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {activeWritebackDestinations.length > 0 ? (
            <label className="webhook-toolbar-control">
              <span>HubSpot writeback</span>
              <select
                onChange={(event) =>
                  setWritebackDestinationId(event.currentTarget.value)
                }
                value={writebackDestinationId}
              >
                {activeWritebackDestinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className="primary-action"
            disabled={addingRow}
            onClick={addRow}
            type="button"
          >
            {addingRow ? 'Adding…' : 'Add row'}
          </button>
        </div>
      </section>

      {error ? (
        <p className="grid-error" role="alert">
          {error}
        </p>
      ) : null}
      {deliveryNotice ? (
        <p className="grid-notice" role="status">
          {deliveryNotice}
        </p>
      ) : null}

      {bulkPreview ? (
        <section className="bulk-run-panel" aria-label="Bulk run confirmation">
          <div>
            <p className="eyebrow">CONFIRM BULK RUN</p>
            <h3>{bulkPreview.column.name}</h3>
            <p>
              {bulkPreview.selectedRows.toLocaleString()} rows · up to{' '}
              {bulkPreview.estimatedProviderRequests.toLocaleString()} provider
              requests including retries
              {bulkPreview.estimatedMaxOutputTokens === null
                ? ''
                : ` · ${bulkPreview.estimatedMaxOutputTokens.toLocaleString()} maximum output tokens`}
            </p>
            {bulkPreview.selection.kind === 'saved_view' ? (
              <small>
                Saved view “{bulkPreview.selection.name}” contains{' '}
                {bulkPreview.scopedRows.toLocaleString()} of{' '}
                {bulkPreview.totalRows.toLocaleString()} table rows. The exact
                ordered selection will be frozen at confirmation.
              </small>
            ) : (
              <small>
                All {bulkPreview.totalRows.toLocaleString()} table rows are in
                scope. The exact ordered selection will be frozen at
                confirmation.
              </small>
            )}
            {bulkPreview.selection.searchQuery ? (
              <small>
                Search “{bulkPreview.selection.searchQuery}” is frozen into this
                selection.
              </small>
            ) : null}
            <small>
              {(
                bulkPreview.scopedRows - bulkPreview.inputReadyRows
              ).toLocaleString()}{' '}
              in-scope rows lack required inputs;{' '}
              {bulkPreview.excludedByModeRows.toLocaleString()} are excluded by
              the selected mode.
            </small>
            {bulkPreview.limitViolations.map((violation) => (
              <p className="form-error" key={violation}>
                {violation}
              </p>
            ))}
          </div>
          <div className="bulk-run-actions">
            <button onClick={() => setBulkPreview(undefined)} type="button">
              Cancel
            </button>
            <button
              className="primary-action"
              disabled={
                startingBulk ||
                bulkPreview.selectedRows === 0 ||
                bulkPreview.limitViolations.length > 0
              }
              onClick={() => void startBulkRun()}
              type="button"
            >
              {startingBulk ? 'Starting…' : 'Confirm and run'}
            </button>
          </div>
        </section>
      ) : null}

      {bulkBatch ? (
        <section className="bulk-run-progress" aria-live="polite">
          <strong>Bulk run: {bulkBatch.status}</strong>
          <span>
            {bulkBatch.selection.kind === 'saved_view'
              ? `Frozen from “${bulkBatch.selection.name}”`
              : 'Frozen from all rows'}
          </span>
          <span>
            {bulkBatch.items
              ? `${bulkBatch.items.queued} queued, ${bulkBatch.items.skipped} skipped, ${bulkBatch.items.pending} pending expansion`
              : `${bulkBatch.selectedRowCount} rows selected`}
          </span>
          {bulkBatch.runs ? (
            <span>
              {bulkBatch.runs.succeeded} succeeded, {bulkBatch.runs.running}{' '}
              running, {bulkBatch.runs.queued} waiting, {bulkBatch.runs.failed}{' '}
              failed
            </span>
          ) : null}
          {bulkBatch.usage && bulkBatch.usage.totalTokens > 0 ? (
            <span>
              {bulkBatch.usage.inputTokens.toLocaleString()} input tokens,{' '}
              {bulkBatch.usage.outputTokens.toLocaleString()} output tokens
            </span>
          ) : null}
          {bulkBatch.status === 'queued' || bulkBatch.status === 'running' ? (
            <button
              className="danger-button"
              disabled={cancellingBulk}
              onClick={() => void cancelBulkRun()}
              type="button"
            >
              {cancellingBulk ? 'Cancelling…' : 'Cancel remaining work'}
            </button>
          ) : null}
        </section>
      ) : null}

      <section
        className="editable-grid"
        aria-label={snapshot.table.name}
        ref={gridScrollRef}
      >
        <div
          className="editable-grid-row editable-grid-header"
          style={{
            gridTemplateColumns,
            minWidth: minimumGridWidth,
          }}
        >
          <span>#</span>
          {snapshot.columns.map((column) => (
            <span className="grid-column-heading" key={column.id}>
              {column.name}
              {column.kind === 'input' ? (
                <small>{formatColumnType(column.valueType)}</small>
              ) : null}
              {column.runMode === 'on_change' ? <small>Auto</small> : null}
            </span>
          ))}
          {hasOutboundActions ? <span>Outbound</span> : null}
        </div>

        {snapshot.rows.length === 0 ? (
          <div className="empty-state">
            <strong>
              {snapshot.searchQuery
                ? `No rows contain “${snapshot.searchQuery}”.`
                : snapshot.activeView
                  ? `No rows match “${snapshot.activeView.name}”.`
                  : 'Your first table is ready.'}
            </strong>
            <p>
              {snapshot.searchQuery
                ? 'Try a broader term or clear the table search.'
                : snapshot.activeView
                  ? 'Edit the saved view or switch to All rows.'
                  : 'Add a row, then fill the typed input columns.'}
            </p>
          </div>
        ) : (
          <div
            className="virtual-grid-body"
            style={{
              height: rowVirtualizer.getTotalSize(),
              minWidth: minimumGridWidth,
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = snapshot.rows[virtualRow.index]!;
              const rowIndex = virtualRow.index;
              return (
                <div
                  className="editable-grid-row virtual-grid-row"
                  data-index={virtualRow.index}
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    gridTemplateColumns,
                    minWidth: minimumGridWidth,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <span className="row-number">{rowIndex + 1}</span>
                  {snapshot.columns.map((column) => {
                    const cell = row.cells[column.id];
                    if (column.kind === 'connector') {
                      const connectorValue = formatCellValue(cell?.value);
                      const cellKey = `${row.id}:${column.id}`;
                      return (
                        <div className="connector-cell" key={column.id}>
                          <span data-status={cell?.status ?? 'idle'}>
                            {cell?.status ?? 'idle'}
                          </span>
                          {connectorValue ? (
                            <code title={connectorValue}>{connectorValue}</code>
                          ) : null}
                          <button
                            disabled={
                              runningCell === cellKey ||
                              cell?.status === 'queued' ||
                              cell?.status === 'running'
                            }
                            onClick={() => void runCell(row.id, column.id)}
                            type="button"
                          >
                            {runningCell === cellKey ? 'Waiting…' : 'Run'}
                          </button>
                        </div>
                      );
                    }
                    if (column.kind === 'formula') {
                      return (
                        <div className="formula-cell" key={column.id}>
                          <span aria-hidden="true">ƒ</span>
                          <output>{formatCellValue(cell?.value)}</output>
                        </div>
                      );
                    }
                    const cellKey = `${row.id}:${column.id}`;
                    if (column.kind !== 'input') {
                      return (
                        <div className="formula-cell" key={column.id}>
                          <output>{formatCellValue(cell?.value)}</output>
                        </div>
                      );
                    }
                    const inputValueType =
                      editableInputValueTypeSchema.safeParse(column.valueType);
                    if (!inputValueType.success) {
                      return (
                        <div className="formula-cell" key={column.id}>
                          <output>Unsupported input type</output>
                        </div>
                      );
                    }
                    return (
                      <InputCellEditor
                        cell={cell}
                        column={{
                          ...column,
                          kind: 'input',
                          valueType: inputValueType.data,
                        }}
                        disabled={savingCell === cellKey}
                        key={column.id}
                        onCommit={(draft) =>
                          saveInputCell({
                            columnId: column.id,
                            draft,
                            expectedVersion: cell?.version ?? 0,
                            rowId: row.id,
                            valueType: inputValueType.data,
                          })
                        }
                      />
                    );
                  })}
                  {hasOutboundActions ? (
                    <div className="webhook-row-action">
                      {activeWebhookDestinations.length > 0 ? (
                        <button
                          disabled={deliveringRow === row.id}
                          onClick={() => void deliverRow(row.id)}
                          type="button"
                        >
                          {deliveringRow === row.id ? 'Queueing…' : 'Webhook'}
                        </button>
                      ) : null}
                      {activeWritebackDestinations.length > 0 ? (
                        <button
                          disabled={deliveringRow === row.id}
                          onClick={() => void writebackRow(row.id)}
                          type="button"
                        >
                          {deliveringRow === row.id ? 'Queueing…' : 'HubSpot'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {snapshot.pageInfo.hasMore ? (
        <div className="grid-pagination">
          <span>{snapshot.rows.length.toLocaleString()} rows loaded</span>
          <button disabled={loadingMore} onClick={loadMoreRows} type="button">
            {loadingMore ? 'Loading…' : 'Load 100 more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function InputCellEditor({
  cell,
  column,
  disabled,
  onCommit,
}: {
  cell: GridSnapshot['rows'][number]['cells'][string] | undefined;
  column: GridSnapshot['columns'][number] & {
    kind: 'input';
    valueType: EditableInputValueType;
  };
  disabled: boolean;
  onCommit: (draft: string) => Promise<void>;
}) {
  const canonicalDraft =
    column.valueType === 'timestamp' && cell?.value.type === 'timestamp'
      ? toLocalDateTimeDraft(cell.value.value)
      : formatEditableCellDraft(cell?.value);
  const editorKey = `${cell?.id ?? column.id}:${cell?.version ?? 0}`;
  const commitIfChanged = (draft: string) => {
    if (draft !== canonicalDraft) void onCommit(draft);
  };

  return (
    <label className="grid-cell typed-grid-cell">
      <span className="sr-only">{column.name}</span>
      {column.valueType === 'boolean' ? (
        <select
          aria-label={column.name}
          defaultValue={canonicalDraft}
          disabled={disabled}
          key={editorKey}
          onChange={(event) => commitIfChanged(event.currentTarget.value)}
        >
          <option value="">Empty</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : (
        <input
          aria-label={column.name}
          defaultValue={canonicalDraft}
          disabled={disabled}
          inputMode={column.valueType === 'number' ? 'decimal' : undefined}
          key={editorKey}
          maxLength={
            column.valueType === 'text' || column.valueType === 'json'
              ? MAXIMUM_EDITABLE_CELL_BYTES
              : undefined
          }
          onBlur={(event) => commitIfChanged(event.currentTarget.value)}
          placeholder={
            column.valueType === 'json' ? '{"key":"value"}' : undefined
          }
          spellCheck={column.valueType === 'json' ? false : undefined}
          step={column.valueType === 'number' ? 'any' : undefined}
          type={
            column.valueType === 'number'
              ? 'number'
              : column.valueType === 'timestamp'
                ? 'datetime-local'
                : 'text'
          }
        />
      )}
    </label>
  );
}

function toLocalDateTimeDraft(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatColumnType(valueType: CellValue['type']): string {
  switch (valueType) {
    case 'boolean':
      return 'True / false';
    case 'timestamp':
      return 'Date & time';
    case 'json':
      return 'JSON';
    case 'empty':
      return 'Empty';
    case 'number':
      return 'Number';
    case 'text':
      return 'Text';
  }
}

interface BulkRunProgress {
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  errorMessage: string | null;
  estimatedMaxOutputTokens: number | null;
  estimatedProviderRequests: number;
  id: string;
  items?: { pending: number; queued: number; skipped: number };
  queuedRowCount: number;
  runs?: {
    cancelled: number;
    failed: number;
    queued: number;
    running: number;
    succeeded: number;
  };
  selectedRowCount: number;
  selection: BulkRunSelectionSnapshot;
  selectionDigest: string;
  skippedRowCount: number;
  status: 'cancelled' | 'completed' | 'failed' | 'queued' | 'running';
  usage?: {
    estimatedCostMicros: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function formatCellValue(value: CellValue | undefined): string {
  if (!value || value.type === 'empty') return '';
  if (value.type === 'json') return JSON.stringify(value.value);
  if (value.type === 'boolean') return value.value ? 'TRUE' : 'FALSE';
  return String(value.value);
}
