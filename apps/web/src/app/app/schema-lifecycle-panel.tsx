'use client';

import type {
  ArchivedColumnSummary,
  ArchivedTableSummary,
  ColumnArchivePreview,
  ColumnTypeConversionPreview,
  GridSnapshot,
  TableArchivePreview,
} from '@byok-grid/db';
import type { EditableInputValueType } from '@byok-grid/domain';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type LifecyclePreview =
  | { kind: 'column'; value: ColumnArchivePreview }
  | { kind: 'conversion'; value: ColumnTypeConversionPreview }
  | { kind: 'table'; value: TableArchivePreview };

const EDITABLE_INPUT_TYPES: EditableInputValueType[] = [
  'text',
  'number',
  'boolean',
  'timestamp',
  'json',
];

export function SchemaLifecyclePanel({
  archivedColumns,
  archivedTables,
  columns,
  currentTable,
  workspaceId,
}: {
  archivedColumns: ArchivedColumnSummary[];
  archivedTables: ArchivedTableSummary[];
  columns: GridSnapshot['columns'];
  currentTable: { id: string; name: string };
  workspaceId: string;
}) {
  const router = useRouter();
  const [confirmationName, setConfirmationName] = useState('');
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [preview, setPreview] = useState<LifecyclePreview>();
  const [selectedColumnId, setSelectedColumnId] = useState(
    columns[0]?.id ?? ''
  );
  const inputColumns = columns.filter((column) => column.kind === 'input');
  const [selectedConversionColumnId, setSelectedConversionColumnId] = useState(
    inputColumns[0]?.id ?? ''
  );
  const selectedConversionColumn = inputColumns.find(
    (column) => column.id === selectedConversionColumnId
  );
  const [targetType, setTargetType] = useState<EditableInputValueType>(
    firstDifferentType(inputColumns[0]?.valueType)
  );
  const tableUrl = `/api/workspaces/${workspaceId}/tables/${currentTable.id}`;

  async function loadPreview(kind: 'column' | 'table') {
    setError(undefined);
    setOperation(`preview-${kind}`);
    setConfirmationName('');
    try {
      const url =
        kind === 'table'
          ? `${tableUrl}/archive`
          : `${tableUrl}/columns/${selectedColumnId}/archive`;
      const response = await fetch(url);
      const body = (await response.json()) as
        | (ColumnArchivePreview & { error?: string })
        | (TableArchivePreview & { error?: string });
      if (!response.ok) {
        throw new Error(body.error ?? 'The archive preview could not load.');
      }
      setPreview(
        kind === 'table'
          ? { kind, value: body as TableArchivePreview }
          : { kind, value: body as ColumnArchivePreview }
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function archiveResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || preview.kind === 'conversion') return;
    setError(undefined);
    setOperation(`archive-${preview.kind}`);
    try {
      const url =
        preview.kind === 'table'
          ? `${tableUrl}/archive`
          : `${tableUrl}/columns/${preview.value.column.id}/archive`;
      const response = await fetch(url, {
        body: JSON.stringify({ confirmationName }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The resource could not be archived.');
      }
      setPreview(undefined);
      if (preview.kind === 'table') {
        router.push(`/app?workspace=${encodeURIComponent(workspaceId)}`);
      }
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function loadConversionPreview() {
    if (!selectedConversionColumnId) return;
    setError(undefined);
    setOperation('preview-conversion');
    setConfirmationName('');
    try {
      const response = await fetch(
        `${tableUrl}/columns/${selectedConversionColumnId}/type?targetType=${encodeURIComponent(targetType)}`
      );
      const body = (await response.json()) as ColumnTypeConversionPreview & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? 'The conversion preview could not load.');
      }
      setPreview({ kind: 'conversion', value: body });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function convertColumn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || preview.kind !== 'conversion') return;
    setError(undefined);
    setOperation('convert-column');
    try {
      const response = await fetch(
        `${tableUrl}/columns/${preview.value.column.id}/type`,
        {
          body: JSON.stringify({
            confirmationName,
            previewDigest: preview.value.previewDigest,
            targetType: preview.value.targetType,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'PATCH',
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The column could not be converted.');
      }
      setPreview(undefined);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function restoreResource(kind: 'column' | 'table', id: string) {
    setError(undefined);
    setOperation(`restore-${kind}-${id}`);
    try {
      const url =
        kind === 'table'
          ? `/api/workspaces/${workspaceId}/tables/${id}/archive`
          : `${tableUrl}/columns/${id}/archive`;
      const response = await fetch(url, { method: 'PATCH' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The resource could not be restored.');
      }
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  const expectedName =
    preview?.kind === 'table'
      ? preview.value.table.name
      : preview?.value.column.name;

  return (
    <section
      aria-labelledby="schema-lifecycle-title"
      className="schema-lifecycle-panel"
    >
      <div>
        <p className="eyebrow">SCHEMA LIFECYCLE</p>
        <h2 id="schema-lifecycle-title">Manage schema safely</h2>
        <p>
          Preview dependencies and active work before archiving or converting.
          Archives retain data for restoration; type conversions are atomic and
          audited.
        </p>
      </div>

      <div className="schema-lifecycle-actions">
        <div>
          <h3>Current table</h3>
          <p>{currentTable.name}</p>
          <button
            className="danger-button"
            disabled={operation !== undefined}
            onClick={() => void loadPreview('table')}
            type="button"
          >
            {operation === 'preview-table' ? 'Reviewing…' : 'Review archive'}
          </button>
        </div>
        <div>
          <h3>Column</h3>
          <select
            aria-label="Column to archive"
            onChange={(event) => setSelectedColumnId(event.currentTarget.value)}
            value={selectedColumnId}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
          <button
            className="danger-button"
            disabled={!selectedColumnId || operation !== undefined}
            onClick={() => void loadPreview('column')}
            type="button"
          >
            {operation === 'preview-column' ? 'Reviewing…' : 'Review archive'}
          </button>
        </div>
        <div>
          <h3>Convert input</h3>
          <select
            aria-label="Input column to convert"
            onChange={(event) => {
              const columnId = event.currentTarget.value;
              const column = inputColumns.find((item) => item.id === columnId);
              setSelectedConversionColumnId(columnId);
              setTargetType(firstDifferentType(column?.valueType));
            }}
            value={selectedConversionColumnId}
          >
            {inputColumns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name} · {column.valueType}
              </option>
            ))}
          </select>
          <select
            aria-label="Target column type"
            onChange={(event) =>
              setTargetType(event.currentTarget.value as EditableInputValueType)
            }
            value={targetType}
          >
            {EDITABLE_INPUT_TYPES.filter(
              (valueType) => valueType !== selectedConversionColumn?.valueType
            ).map((valueType) => (
              <option key={valueType} value={valueType}>
                {valueType}
              </option>
            ))}
          </select>
          <button
            disabled={!selectedConversionColumnId || operation !== undefined}
            onClick={() => void loadConversionPreview()}
            type="button"
          >
            {operation === 'preview-conversion' ? 'Reviewing…' : 'Review type'}
          </button>
        </div>
      </div>

      {preview && expectedName ? (
        <div aria-live="polite" className="archive-preview">
          <div>
            <p className="eyebrow">
              {preview.kind === 'conversion'
                ? 'TYPE CONVERSION PREVIEW'
                : 'ARCHIVE PREVIEW'}
            </p>
            <h3>{expectedName}</h3>
            <ImpactSummary preview={preview} />
          </div>
          {preview.value.blockers.length > 0 ? (
            <div className="archive-blockers" role="status">
              <strong>Resolve these blockers first</strong>
              <ul>
                {preview.value.blockers.map((blocker) => (
                  <li key={blocker.code}>
                    {blocker.message} ({blocker.count})
                  </li>
                ))}
              </ul>
            </div>
          ) : preview.kind === 'conversion' ? (
            <form method="post" onSubmit={convertColumn}>
              <label>
                <span>
                  Type <strong>{expectedName}</strong> to confirm this
                  irreversible conversion
                </span>
                <input
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) =>
                    setConfirmationName(event.currentTarget.value)
                  }
                  required
                  value={confirmationName}
                />
              </label>
              <button
                disabled={
                  confirmationName !== expectedName || operation !== undefined
                }
                type="submit"
              >
                {operation === 'convert-column'
                  ? 'Converting…'
                  : `Convert to ${preview.value.targetType}`}
              </button>
            </form>
          ) : (
            <form method="post" onSubmit={archiveResource}>
              <label>
                <span>
                  Type <strong>{expectedName}</strong> to confirm
                </span>
                <input
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) =>
                    setConfirmationName(event.currentTarget.value)
                  }
                  required
                  value={confirmationName}
                />
              </label>
              <button
                className="danger-button"
                disabled={
                  confirmationName !== expectedName || operation !== undefined
                }
                type="submit"
              >
                {operation === `archive-${preview.kind}`
                  ? 'Archiving…'
                  : `Archive ${preview.kind}`}
              </button>
            </form>
          )}
          <button
            disabled={operation !== undefined}
            onClick={() => setPreview(undefined)}
            type="button"
          >
            Close preview
          </button>
        </div>
      ) : null}

      {archivedTables.length > 0 || archivedColumns.length > 0 ? (
        <div className="archived-resources">
          <h3>Archived resources</h3>
          <ul>
            {archivedTables.map((table) => (
              <li key={table.id}>
                <span>
                  Table · {table.name} · {formatArchivedAt(table.archivedAt)}
                </span>
                <button
                  disabled={operation !== undefined}
                  onClick={() => void restoreResource('table', table.id)}
                  type="button"
                >
                  {operation === `restore-table-${table.id}`
                    ? 'Restoring…'
                    : 'Restore'}
                </button>
              </li>
            ))}
            {archivedColumns.map((column) => (
              <li key={column.id}>
                <span>
                  Column · {column.name} · {formatArchivedAt(column.archivedAt)}
                </span>
                <button
                  disabled={operation !== undefined}
                  onClick={() => void restoreResource('column', column.id)}
                  type="button"
                >
                  {operation === `restore-column-${column.id}`
                    ? 'Restoring…'
                    : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p className="grid-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ImpactSummary({ preview }: { preview: LifecyclePreview }) {
  if (preview.kind === 'table') {
    return (
      <p>
        Hides {preview.value.impact.columns} columns and{' '}
        {preview.value.impact.rows} rows while retaining{' '}
        {preview.value.impact.retainedRuns} run records and{' '}
        {preview.value.impact.savedViews} saved views.
      </p>
    );
  }
  if (preview.kind === 'conversion') {
    return (
      <div>
        <p>
          Converts {preview.value.impact.convertibleCells} non-empty cells from{' '}
          {preview.value.column.valueType} to {preview.value.targetType};
          preserves {preview.value.impact.emptyCells} explicit empty cells.{' '}
          {preview.value.impact.failedCells} cells cannot convert safely.
        </p>
        {preview.value.failures.length > 0 ? (
          <ul>
            {preview.value.failures.map((failure) => (
              <li key={failure.rowId}>
                Row {failure.rowPosition}: {failure.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return (
    <p>
      Hides {preview.value.impact.cells} cells. Paused mappings retained:{' '}
      {preview.value.impact.pausedSourceMappings} sources and{' '}
      {preview.value.impact.pausedWritebackMappings} writebacks. Referenced by{' '}
      {preview.value.impact.savedViews} saved views.
    </p>
  );
}

function firstDifferentType(
  valueType: GridSnapshot['columns'][number]['valueType'] | undefined
): EditableInputValueType {
  return EDITABLE_INPUT_TYPES.find((candidate) => candidate !== valueType)!;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed.';
}

function formatArchivedAt(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
