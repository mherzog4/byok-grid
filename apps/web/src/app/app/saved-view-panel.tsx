'use client';

import type { GridSnapshot, SavedGridViewSummary } from '@byok-grid/db';
import { savedGridViewRequestSchema } from '@byok-grid/domain';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  createFilterGroupDraft,
  filterTreeDraftToValue,
  filterTreeValueToDraft,
  FilterTreeEditor,
  type FilterGroupDraft,
} from './filter-tree-editor';

export function SavedViewPanel({
  activeViewId,
  columns,
  tableId,
  views,
  workspaceId,
}: {
  activeViewId: string | null;
  columns: GridSnapshot['columns'];
  tableId: string;
  views: SavedGridViewSummary[];
  workspaceId: string;
}) {
  const router = useRouter();
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const [editingViewId, setEditingViewId] = useState<string | null>();
  const [name, setName] = useState('');
  const [filterTree, setFilterTree] = useState<FilterGroupDraft>(
    createFilterGroupDraft
  );
  const [sortColumnId, setSortColumnId] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/views`;

  function navigateToView(viewId: string | null) {
    const query = new URLSearchParams({
      table: tableId,
      workspace: workspaceId,
    });
    if (viewId) query.set('view', viewId);
    router.push(`/app?${query.toString()}`);
  }

  function startNewView() {
    setEditingViewId(null);
    setName('');
    setFilterTree(createFilterGroupDraft(columns[0]));
    setSortColumnId('');
    setSortDirection('asc');
    setError(undefined);
  }

  function startEditingView(view: SavedGridViewSummary) {
    setEditingViewId(view.id);
    setName(view.name);
    setFilterTree(filterTreeValueToDraft(view.filterTree));
    setSortColumnId(view.sort?.columnId ?? '');
    setSortDirection(view.sort?.direction ?? 'asc');
    setError(undefined);
  }

  function closeEditor() {
    setEditingViewId(undefined);
    setError(undefined);
  }

  async function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const request = savedGridViewRequestSchema.parse({
        filterTree: filterTreeDraftToValue(filterTree),
        name,
        sort: sortColumnId
          ? { columnId: sortColumnId, direction: sortDirection }
          : null,
      });
      const response = await fetch(
        editingViewId ? `${baseUrl}/${editingViewId}` : baseUrl,
        {
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
          method: editingViewId ? 'PATCH' : 'POST',
        }
      );
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? 'The saved view could not be saved.');
      }
      const updatedExistingView = Boolean(editingViewId);
      setEditingViewId(undefined);
      if (updatedExistingView) router.refresh();
      else navigateToView(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  async function deleteActiveView() {
    if (!activeView) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`${baseUrl}/${activeView.id}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? 'The saved view could not be deleted.');
      }
      navigateToView(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  const editorOpen = editingViewId !== undefined;
  return (
    <section aria-labelledby="saved-view-title" className="saved-view-panel">
      <div className="saved-view-heading">
        <div>
          <p className="eyebrow">SAVED VIEWS</p>
          <h2 id="saved-view-title">Focus the grid</h2>
          <p>
            Build bounded AND/OR groups with up to twelve typed filters. Sorting
            and pagination stay on the server, and views are shared with
            workspace members.
          </p>
        </div>
        <div className="saved-view-picker">
          <label>
            <span>Current view</span>
            <select
              aria-label="Current saved view"
              onChange={(event) =>
                navigateToView(event.currentTarget.value || null)
              }
              value={activeViewId ?? ''}
            >
              <option value="">All rows</option>
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={pending} onClick={startNewView} type="button">
            New view
          </button>
          {activeView ? (
            <>
              <button
                disabled={pending}
                onClick={() => startEditingView(activeView)}
                type="button"
              >
                Edit
              </button>
              <button
                className="danger-button"
                disabled={pending}
                onClick={deleteActiveView}
                type="button"
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      </div>

      {editorOpen ? (
        <form className="saved-view-editor" method="post" onSubmit={saveView}>
          <div className="saved-view-editor-topline">
            <label>
              <span>View name</span>
              <input
                maxLength={80}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Failed enrichments"
                required
                value={name}
              />
            </label>
            <div>
              <button disabled={pending} type="submit">
                {pending
                  ? 'Saving…'
                  : editingViewId
                    ? 'Update view'
                    : 'Save view'}
              </button>
              <button disabled={pending} onClick={closeEditor} type="button">
                Cancel
              </button>
            </div>
          </div>

          <FilterTreeEditor
            columns={columns}
            emptyMessage="No filters. This view will only apply its sort."
            onChange={setFilterTree}
            value={filterTree}
          />

          <fieldset className="saved-view-sort">
            <legend>Sort</legend>
            <label>
              <span>Column</span>
              <select
                aria-label="Sort column"
                onChange={(event) => setSortColumnId(event.currentTarget.value)}
                value={sortColumnId}
              >
                <option value="">Manual row order</option>
                {columns
                  .filter((column) => column.valueType !== 'json')
                  .map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Direction</span>
              <select
                aria-label="Sort direction"
                disabled={!sortColumnId}
                onChange={(event) =>
                  setSortDirection(event.currentTarget.value as 'asc' | 'desc')
                }
                value={sortDirection}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          </fieldset>
        </form>
      ) : null}

      {error ? (
        <p className="grid-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
