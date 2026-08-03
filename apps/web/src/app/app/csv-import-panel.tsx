'use client';

import type { CsvImportSummary } from '@byok-grid/db';
import { type FormEvent, useEffect, useState } from 'react';

export function CsvImportPanel({
  initial,
  tableId,
  workspaceId,
}: {
  initial: CsvImportSummary[];
  tableId: string;
  workspaceId: string;
}) {
  const [imports, setImports] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const baseUrl = `/api/workspaces/${workspaceId}/tables/${tableId}/imports/csv`;
  const activeImportIds = imports
    .filter((job) => ['queued', 'running', 'staging'].includes(job.status))
    .map((job) => job.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!activeImportIds) return;
    const activeIds = new Set(activeImportIds.split(','));
    async function pollImports() {
      const response = await fetch(baseUrl);
      if (!response.ok) return;
      const latest = (await response.json()) as CsvImportSummary[];
      if (
        latest.some(
          (job) => activeIds.has(job.id) && job.status === 'succeeded'
        )
      ) {
        window.location.reload();
        return;
      }
      setImports(latest);
    }
    const timer = window.setInterval(() => {
      void pollImports();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activeImportIds, baseUrl]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Choose a non-empty CSV file.');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `${baseUrl}?filename=${encodeURIComponent(file.name)}`,
        {
          body: file,
          headers: { 'content-type': file.type || 'text/csv' },
          method: 'POST',
        }
      );
      const body = (await response.json()) as CsvImportSummary & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? 'The CSV could not be uploaded.');
      }
      setImports((current) => [
        body,
        ...current.filter((job) => job.id !== body.id),
      ]);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The upload failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="import-panel">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">CSV INGESTION</p>
          <h2>Stream rows into this table</h2>
        </div>
        <p>Up to 50 MiB, 100,000 rows, and 256 columns per import.</p>
      </div>
      <div className="import-layout">
        <form className="import-form" method="post" onSubmit={upload}>
          <label>
            CSV file
            <input accept=".csv,text/csv" name="file" required type="file" />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Streaming…' : 'Import CSV'}
          </button>
        </form>
        <div className="import-list">
          {imports.length === 0 ? (
            <p className="credential-empty">No CSV imports yet.</p>
          ) : (
            imports.map((job) => (
              <article key={job.id}>
                <div>
                  <strong>{job.filename}</strong>
                  <span>
                    {job.importedRowCount.toLocaleString()} /{' '}
                    {job.stagedRowCount.toLocaleString()} rows
                  </span>
                </div>
                <span data-status={job.status}>{job.status}</span>
                {job.errorMessage ? <p>{job.errorMessage}</p> : null}
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
