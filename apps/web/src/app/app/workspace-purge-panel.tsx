'use client';

import type { WorkspacePurgePreview } from '@byok-grid/db';
import type { WorkspacePurgeReason } from '@byok-grid/domain';
import { useState } from 'react';

const impactLabels: Readonly<
  Record<keyof WorkspacePurgePreview['impact'], string>
> = {
  auditRecords: 'Audit records',
  cells: 'Cells',
  columns: 'Columns',
  credentials: 'Encrypted credentials',
  executionRecords: 'Execution records',
  integrations: 'Integration definitions',
  invitations: 'Invitations',
  members: 'Memberships',
  rows: 'Rows',
  tables: 'Tables',
};

export function WorkspacePurgePanel({
  initial,
  workspaceId,
}: {
  initial: WorkspacePurgePreview;
  workspaceId: string;
}) {
  const [preview, setPreview] = useState(initial);
  const [confirmationName, setConfirmationName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState<WorkspacePurgeReason>('user_requested');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const endpoint = `/api/workspaces/${workspaceId}/purge`;

  async function refreshPreview(): Promise<WorkspacePurgePreview> {
    const response = await fetch(endpoint, { cache: 'no-store' });
    const body = (await response.json()) as WorkspacePurgePreview & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.error ?? 'The deletion preview could not be loaded.'
      );
    }
    setPreview(body);
    return body;
  }

  async function permanentlyDelete() {
    setPending(true);
    setError(undefined);
    try {
      const current = await refreshPreview();
      if (!current.canPurge) {
        throw new Error(current.blockers[0]?.message ?? 'Deletion is blocked.');
      }
      if (!acknowledged) {
        throw new Error('Acknowledge that deletion cannot be undone.');
      }
      if (confirmationName !== current.workspace.name) {
        throw new Error('Type the exact workspace name shown in the preview.');
      }
      if (
        !window.confirm(
          `Permanently delete “${current.workspace.name}” and all of its data?`
        )
      ) {
        return;
      }

      const response = await fetch(endpoint, {
        body: JSON.stringify({
          acknowledgeIrreversible: true,
          confirmationName,
          previewDigest: current.previewDigest,
          reason,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? 'The workspace could not be deleted.');
      }
      window.location.assign('/app');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="workspace-purge-panel">
      <div>
        <p className="eyebrow">DANGER ZONE</p>
        <h2>Permanently delete workspace</h2>
        <p>
          This erases all workspace content, credentials, integrations, run
          history, and tenant audit records. It cannot be restored from the app.
          Optional ClickHouse projections are erased asynchronously.
        </p>
      </div>

      <dl className="purge-impact-grid">
        {Object.entries(preview.impact).map(([key, count]) => (
          <div key={key}>
            <dt>{impactLabels[key as keyof typeof impactLabels]}</dt>
            <dd>{count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>

      {preview.blockers.length > 0 ? (
        <div className="archive-blockers" role="status">
          <strong>Deletion is currently blocked</strong>
          <ul>
            {preview.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="purge-confirmation">
        <label>
          Reason
          <select
            onChange={(event) =>
              setReason(event.target.value as WorkspacePurgeReason)
            }
            value={reason}
          >
            <option value="user_requested">No longer needed</option>
            <option value="duplicate_workspace">Duplicate workspace</option>
            <option value="test_data">Test data</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Type “{preview.workspace.name}” to confirm
          <input
            autoComplete="off"
            onChange={(event) => setConfirmationName(event.target.value)}
            value={confirmationName}
          />
        </label>
        <label className="purge-acknowledgement">
          <input
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          I understand that this permanently erases the workspace.
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="danger-button"
          disabled={
            pending ||
            !preview.canPurge ||
            !acknowledged ||
            confirmationName !== preview.workspace.name
          }
          onClick={() => void permanentlyDelete()}
          type="button"
        >
          {pending ? 'Rechecking…' : 'Permanently delete workspace'}
        </button>
      </div>

      <p className="purge-receipt-note">
        The deployment retains only an opaque deletion receipt containing the
        workspace and actor IDs, reason code, aggregate counts, confirmation
        digest, timestamp, and analytics-erasure status. It contains no
        workspace name or cell content.
      </p>
    </section>
  );
}
