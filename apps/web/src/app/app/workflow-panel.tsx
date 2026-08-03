'use client';

import type {
  SqliteWorkflowSummary,
  SqliteWorkspaceTableSummary,
} from '@byok-grid/db';
import type { WorkflowDraftGraph, WorkflowGraph } from '@byok-grid/domain';
import { useEffect, useRef, useState } from 'react';
import {
  WorkflowEditor,
  type WorkflowEditorResources,
  type WorkflowEditorSubmission,
} from './workflow-editor';

const emptyGraph: WorkflowDraftGraph = {
  edges: [],
  nodes: [],
  schemaVersion: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
};

interface WorkflowRunView {
  createdAt: string;
  errorMessage: string | null;
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  steps: Array<{
    attempt: number;
    errorMessage: string | null;
    kind: string;
    status: string;
    stepId: string;
  }>;
  workflowVersion: number;
}

export function WorkflowPanel({
  initialWorkflows,
  resources,
  tables,
  workspaceId,
}: {
  initialWorkflows: SqliteWorkflowSummary[];
  resources: WorkflowEditorResources;
  tables: SqliteWorkspaceTableSummary[];
  workspaceId: string;
}) {
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [activeId, setActiveId] = useState(initialWorkflows[0]?.id);
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const active = workflows.find((workflow) => workflow.id === activeId);
  const activeIdRef = useRef(activeId);
  const collectionUrl = `/api/workspaces/${workspaceId}/workflows`;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void requestWorkflowRuns(`${collectionUrl}/${activeId}/runs`)
      .then((loaded) => {
        if (!cancelled) setRuns(loaded);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Run history could not load.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, collectionUrl]);

  function replaceWorkflow(workflow: SqliteWorkflowSummary) {
    if (!workflows.some((item) => item.id === workflow.id)) setRuns([]);
    setWorkflows((current) => {
      const found = current.some((item) => item.id === workflow.id);
      return found
        ? current.map((item) => (item.id === workflow.id ? workflow : item))
        : [workflow, ...current];
    });
    selectWorkflow(workflow.id);
    return workflow;
  }

  function selectWorkflow(workflowId: string | undefined) {
    activeIdRef.current = workflowId;
    setActiveId(workflowId);
  }

  async function save(submission: WorkflowEditorSubmission) {
    setError(undefined);
    if (!active) {
      return replaceWorkflow(
        await requestWorkflow(collectionUrl, {
          body: submission,
          method: 'POST',
        })
      );
    }
    return replaceWorkflow(
      await requestWorkflow(`${collectionUrl}/${active.id}`, {
        body: {
          expectedRevision: active.draftRevision,
          graph: submission.graph,
          name: submission.name,
        },
        method: 'PATCH',
      })
    );
  }

  async function publish(submission: { graph: WorkflowGraph; name: string }) {
    setError(undefined);
    const saved = await save(submission);
    const published = await requestWorkflow(
      `${collectionUrl}/${saved.id}/publish`,
      {
        body: { expectedRevision: saved.draftRevision },
        method: 'POST',
      }
    );
    replaceWorkflow(published);
  }

  async function runWorkflow() {
    if (!active?.publishedVersion) return;
    setRunning(true);
    setError(undefined);
    try {
      const response = await fetch(`${collectionUrl}/${active.id}/runs`, {
        body: JSON.stringify({ input: { source: 'manual' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as WorkflowRunView & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? 'The run could not start.');
      setRuns((current) => [{ ...body, steps: [] }, ...current]);
      await pollRun(active.id, body.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The run could not start.'
      );
    } finally {
      setRunning(false);
    }
  }

  async function pollRun(workflowId: string, runId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (activeIdRef.current !== workflowId) return;
      const latest = await requestWorkflowRuns(
        `${collectionUrl}/${workflowId}/runs`
      );
      if (activeIdRef.current !== workflowId) return;
      setRuns(latest);
      const run = latest.find((candidate) => candidate.id === runId);
      if (
        !run ||
        run.status === 'succeeded' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        return;
      }
    }
  }

  return (
    <section className="workflow-workspace">
      <nav aria-label="Workflows" className="workflow-list">
        <div className="workflow-list-heading">
          <div>
            <p className="eyebrow">WORKFLOWS</p>
            <h2>Automations</h2>
          </div>
          <button
            onClick={() => {
              selectWorkflow(undefined);
              setError(undefined);
              setRuns([]);
            }}
            type="button"
          >
            New workflow
          </button>
        </div>
        <div className="workflow-list-items">
          {workflows.length === 0 ? (
            <p>No workflows yet. Start with a table trigger.</p>
          ) : null}
          {workflows.map((workflow) => (
            <button
              className={workflow.id === activeId ? 'active' : ''}
              key={workflow.id}
              onClick={() => {
                if (workflow.id !== activeId) setRuns([]);
                selectWorkflow(workflow.id);
              }}
              type="button"
            >
              <strong>{workflow.name}</strong>
              <span>
                {workflow.state} · draft {workflow.draftRevision}
                {workflow.publishedVersion
                  ? ` · published ${workflow.publishedVersion}`
                  : ''}
              </span>
            </button>
          ))}
        </div>
        <div className="workflow-context">
          <span>
            {tables.length} table{tables.length === 1 ? '' : 's'} available
          </span>
          <button
            disabled={!active?.publishedVersion || running}
            onClick={() => void runWorkflow()}
            type="button"
          >
            {running ? 'Queuing…' : 'Run published version'}
          </button>
        </div>
        <div className="workflow-runs" aria-live="polite">
          <strong>Recent runs</strong>
          {runs.length === 0 ? <span>No runs yet.</span> : null}
          {runs.slice(0, 5).map((run) => (
            <details key={run.id} open={run.status === 'running'}>
              <summary>
                <span data-status={run.status}>{run.status}</span>
                <small>v{run.workflowVersion}</small>
              </summary>
              <ol>
                {run.steps.map((step) => (
                  <li key={step.stepId}>
                    <span>{step.kind}</span>
                    <small>
                      {step.status} · attempt {step.attempt}
                    </small>
                    {step.errorMessage ? <em>{step.errorMessage}</em> : null}
                  </li>
                ))}
              </ol>
              {run.errorMessage ? <p>{run.errorMessage}</p> : null}
            </details>
          ))}
        </div>
      </nav>

      <div className="workflow-editor-column">
        <WorkflowEditor
          initialGraph={active?.draftGraph ?? emptyGraph}
          initialName={active?.name ?? 'Untitled workflow'}
          key={active ? `${active.id}:${active.draftRevision}` : 'new'}
          onPublish={publish}
          onSave={async (submission) => {
            await save(submission);
          }}
          resources={resources}
        />
        {error ? (
          <p className="grid-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

async function requestWorkflow(
  url: string,
  input: { body: unknown; method: 'PATCH' | 'POST' }
): Promise<SqliteWorkflowSummary> {
  const response = await fetch(url, {
    body: JSON.stringify(input.body),
    headers: { 'content-type': 'application/json' },
    method: input.method,
  });
  const body = (await response.json()) as SqliteWorkflowSummary & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error ?? 'The workflow request failed.');
  }
  return body;
}

async function requestWorkflowRuns(url: string): Promise<WorkflowRunView[]> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = (await response.json()) as
    WorkflowRunView[] | { error?: string };
  if (!response.ok) {
    throw new Error(
      (!Array.isArray(body) ? body.error : undefined) ??
        'Run history could not load.'
    );
  }
  return body as WorkflowRunView[];
}
