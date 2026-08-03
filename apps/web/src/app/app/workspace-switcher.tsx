'use client';

import type { WorkspaceSummary } from '@byok-grid/db';
import { useRouter } from 'next/navigation';

export function WorkspaceSwitcher({
  currentWorkspaceId,
  workspaces,
}: {
  currentWorkspaceId: string;
  workspaces: WorkspaceSummary[];
}) {
  const router = useRouter();

  if (workspaces.length < 2) return null;

  return (
    <label className="workspace-switcher">
      <span className="sr-only">Current workspace</span>
      <select
        onChange={(event) => {
          router.push(
            `/app?workspace=${encodeURIComponent(event.target.value)}`
          );
          router.refresh();
        }}
        value={currentWorkspaceId}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name} · {workspace.role}
          </option>
        ))}
      </select>
    </label>
  );
}
