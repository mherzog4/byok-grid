'use client';

import {
  workflowDraftGraphSchema,
  workflowGraphSchema,
  type WorkflowDraftGraph,
  type WorkflowGraph,
  type WorkflowNodeKind,
} from '@byok-grid/domain';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type NodeMouseHandler,
  type Viewport,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useMemo, useState } from 'react';
import {
  canConnectWorkflowNodes,
  createWorkflowCanvasNode,
  workflowCanvasToDraft,
  workflowDraftToCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowCanvasNodeValue,
} from './workflow-editor-model';
import { WorkflowNodeView } from './workflow-node';

const nodeTypes = { workflow: WorkflowNodeView };

export interface WorkflowEditorResources {
  columns: ReadonlyArray<{
    id: string;
    kind: 'connector' | 'formula' | 'function' | 'input';
    name: string;
    tableId: string;
  }>;
  tables: ReadonlyArray<{ id: string; name: string }>;
  webhookDestinations: ReadonlyArray<{ id: string; name: string }>;
}

export interface WorkflowEditorSubmission {
  graph: WorkflowDraftGraph;
  name: string;
}

export function WorkflowEditor({
  initialGraph,
  initialName,
  onPublish,
  onSave,
  resources,
}: {
  initialGraph: WorkflowDraftGraph;
  initialName: string;
  onPublish?: (submission: {
    graph: WorkflowGraph;
    name: string;
  }) => Promise<void> | void;
  onSave: (submission: WorkflowEditorSubmission) => Promise<void> | void;
  resources: WorkflowEditorResources;
}) {
  const initial = useMemo(
    () => workflowDraftToCanvas(initialGraph),
    [initialGraph]
  );
  const [nodes, setNodes, onNodesChangeBase] =
    useNodesState<WorkflowCanvasNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowCanvasEdge>(
    initial.edges
  );
  const [viewport, setViewport] = useState<Viewport>(initial.viewport);
  const [name, setName] = useState(initialName);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [operation, setOperation] = useState<'publish' | 'save'>();
  const [message, setMessage] = useState<{
    kind: 'error' | 'success';
    text: string;
  }>();
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);

  function onNodesChange(changes: Parameters<typeof onNodesChangeBase>[0]) {
    onNodesChangeBase(changes);
    const removedIds = new Set(
      changes
        .filter((change) => change.type === 'remove')
        .map((change) => change.id)
    );
    if (removedIds.size > 0) {
      setEdges((current) =>
        current.filter(
          (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)
        )
      );
      if (selectedNodeId && removedIds.has(selectedNodeId)) {
        setSelectedNodeId(undefined);
      }
    }
  }

  function connect(connection: Connection) {
    if (!canConnectWorkflowNodes(nodes, edges, connection)) {
      setMessage({
        kind: 'error',
        text: 'That connection would create a cycle, reuse an input, or join incompatible ports.',
      });
      return;
    }
    setMessage(undefined);
    setEdges((current) =>
      addEdge<WorkflowCanvasEdge>(
        {
          ...connection,
          data: {},
          id: crypto.randomUUID(),
          label:
            connection.sourceHandle === 'rows'
              ? undefined
              : connection.sourceHandle,
          type: 'smoothstep',
        },
        current
      )
    );
  }

  function addNode(kind: WorkflowNodeKind) {
    const node = defaultNode(kind, resources);
    if (!node) {
      setMessage({
        kind: 'error',
        text: missingResourceMessage(kind),
      });
      return;
    }
    const created = createWorkflowCanvasNode(node, {
      x: 80 + (nodes.length % 4) * 260,
      y: 80 + Math.floor(nodes.length / 4) * 180,
    });
    setNodes((current) => [...current, created]);
    setSelectedNodeId(created.id);
    setMessage(undefined);
  }

  function updateSelectedNode(
    update: (
      node: WorkflowCanvasNode['data']['node']
    ) => WorkflowCanvasNode['data']['node']
  ) {
    if (!selectedNodeId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? { ...node, data: { node: update(node.data.node) } }
          : node
      )
    );
  }

  async function submit(kind: 'publish' | 'save') {
    setOperation(kind);
    setMessage(undefined);
    try {
      const draft = workflowCanvasToDraft(nodes, edges, viewport);
      const normalizedName = name.trim().normalize('NFKC');
      workflowDraftGraphSchema.parse(draft);
      if (kind === 'save') {
        await onSave({ graph: draft, name: normalizedName });
        setMessage({ kind: 'success', text: 'Draft saved.' });
      } else {
        const graph = workflowGraphSchema.parse(draft);
        await onPublish?.({ graph, name: normalizedName });
        setMessage({ kind: 'success', text: 'Workflow published.' });
      }
    } catch (cause) {
      setMessage({ kind: 'error', text: readableError(cause) });
    } finally {
      setOperation(undefined);
    }
  }

  const selectNode: NodeMouseHandler<WorkflowCanvasNode> = (_event, node) => {
    setSelectedNodeId(node.id);
  };

  return (
    <section
      aria-labelledby="workflow-editor-title"
      className="workflow-editor"
    >
      <header className="workflow-editor-heading">
        <div>
          <p className="eyebrow">VISUAL WORKFLOW</p>
          <h2 id="workflow-editor-title">Engineer the row journey</h2>
        </div>
        <label>
          <span>Workflow name</span>
          <input
            maxLength={80}
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
        </label>
        <div className="workflow-editor-actions">
          <button
            disabled={operation !== undefined}
            onClick={() => void submit('save')}
            type="button"
          >
            {operation === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          <button
            className="primary-action"
            disabled={!onPublish || operation !== undefined}
            onClick={() => void submit('publish')}
            type="button"
          >
            {operation === 'publish' ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </header>

      <div className="workflow-editor-shell">
        <aside className="workflow-palette" aria-label="Workflow node palette">
          <p>ADD NODE</p>
          {paletteItems.map((item) => (
            <button
              key={item.kind}
              onClick={() => addNode(item.kind)}
              type="button"
            >
              <span>{item.group}</span>
              {item.label}
            </button>
          ))}
        </aside>

        <div className="workflow-canvas">
          <ReactFlow<WorkflowCanvasNode, WorkflowCanvasEdge>
            defaultViewport={initial.viewport}
            edges={edges}
            fitView={nodes.length > 0 && initial.nodes.length === 0}
            maxZoom={2}
            minZoom={0.2}
            nodeTypes={nodeTypes}
            nodes={nodes}
            onConnect={connect}
            onEdgesChange={onEdgesChange}
            onMoveEnd={(_event, nextViewport) => setViewport(nextViewport)}
            onNodeClick={selectNode}
            onNodesChange={onNodesChange}
            onPaneClick={() => setSelectedNodeId(undefined)}
          >
            <Background
              color="#2a302c"
              gap={22}
              variant={BackgroundVariant.Dots}
            />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <WorkflowNodeInspector
          node={selectedNode}
          onChange={updateSelectedNode}
          resources={resources}
        />
      </div>
      {message ? (
        <p
          className={message.kind === 'error' ? 'grid-error' : 'grid-success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : (
        <p className="workflow-editor-hint">
          Connect the dot handles. Drafts may be incomplete; publishing requires
          every path to run from a table trigger to a destination.
        </p>
      )}
    </section>
  );
}

function WorkflowNodeInspector({
  node,
  onChange,
  resources,
}: {
  node: WorkflowCanvasNode | undefined;
  onChange: (
    update: (
      node: WorkflowCanvasNode['data']['node']
    ) => WorkflowCanvasNode['data']['node']
  ) => void;
  resources: WorkflowEditorResources;
}) {
  if (!node) {
    return (
      <aside className="workflow-inspector">
        <p>NODE SETTINGS</p>
        <span>Select a node to configure it.</span>
      </aside>
    );
  }
  const value = node.data.node;
  return (
    <aside className="workflow-inspector">
      <p>NODE SETTINGS</p>
      <label>
        <span>Name</span>
        <input
          maxLength={80}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              name: event.currentTarget.value,
            }))
          }
          value={value.name}
        />
      </label>
      <NodeConfigurationEditor
        node={value}
        onChange={onChange}
        resources={resources}
      />
    </aside>
  );
}

function NodeConfigurationEditor({
  node,
  onChange,
  resources,
}: {
  node: WorkflowCanvasNode['data']['node'];
  onChange: (
    update: (
      node: WorkflowCanvasNode['data']['node']
    ) => WorkflowCanvasNode['data']['node']
  ) => void;
  resources: WorkflowEditorResources;
}) {
  if (node.kind === 'trigger.table_rows') {
    return (
      <>
        <ResourceSelect
          label="Source table"
          onChange={(tableId) =>
            onChange((current) =>
              current.kind === 'trigger.table_rows'
                ? {
                    ...current,
                    configuration: { ...current.configuration, tableId },
                  }
                : current
            )
          }
          options={resources.tables}
          value={node.configuration.tableId}
        />
        <label>
          <span>Search query (optional)</span>
          <input
            onChange={(event) => {
              const searchQuery = event.currentTarget.value || null;
              onChange((current) =>
                current.kind === 'trigger.table_rows'
                  ? {
                      ...current,
                      configuration: {
                        ...current.configuration,
                        searchQuery,
                      },
                    }
                  : current
              );
            }}
            value={node.configuration.searchQuery ?? ''}
          />
        </label>
      </>
    );
  }
  if (node.kind === 'action.enrich_column') {
    return (
      <>
        <ResourceSelect
          label="Enrichment column"
          onChange={(columnId) =>
            onChange((current) =>
              current.kind === 'action.enrich_column'
                ? {
                    ...current,
                    configuration: { ...current.configuration, columnId },
                  }
                : current
            )
          }
          options={resources.columns.filter(
            (column) => column.kind === 'connector'
          )}
          value={node.configuration.columnId}
        />
        <label>
          <span>Rows to run</span>
          <select
            onChange={(event) => {
              const mode = event.currentTarget.value as 'all' | 'pending';
              onChange((current) =>
                current.kind === 'action.enrich_column'
                  ? {
                      ...current,
                      configuration: { ...current.configuration, mode },
                    }
                  : current
              );
            }}
            value={node.configuration.mode}
          >
            <option value="pending">Pending only</option>
            <option value="all">All selected rows</option>
          </select>
        </label>
      </>
    );
  }
  if (node.kind === 'destination.send_webhook') {
    return (
      <ResourceSelect
        label="Webhook destination"
        onChange={(destinationId) =>
          onChange((current) =>
            current.kind === 'destination.send_webhook'
              ? { ...current, configuration: { destinationId } }
              : current
          )
        }
        options={resources.webhookDestinations}
        value={node.configuration.destinationId}
      />
    );
  }
  if (node.kind === 'destination.write_table') {
    return (
      <ResourceSelect
        label="Target table"
        onChange={(tableId) =>
          onChange((current) =>
            current.kind === 'destination.write_table'
              ? {
                  ...current,
                  configuration: { ...current.configuration, tableId },
                }
              : current
          )
        }
        options={resources.tables}
        value={node.configuration.tableId}
      />
    );
  }
  return (
    <p className="workflow-inspector-note">
      Empty filters match every row. Rule editing uses the same typed filter
      tree as saved table views.
    </p>
  );
}

function ResourceSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ id: string; name: string }>;
  value: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function defaultNode(
  kind: WorkflowNodeKind,
  resources: WorkflowEditorResources
): WorkflowCanvasNodeValue | null {
  const table = resources.tables[0];
  const column = resources.columns.find(
    (candidate) => candidate.kind === 'connector'
  );
  const webhook = resources.webhookDestinations[0];
  if (kind === 'trigger.table_rows') {
    return table
      ? {
          configuration: { searchQuery: null, tableId: table.id, viewId: null },
          kind,
          name: 'Table rows',
        }
      : null;
  }
  if (kind === 'action.enrich_column') {
    return column
      ? {
          configuration: { columnId: column.id, mode: 'pending' },
          kind,
          name: 'Enrich column',
        }
      : null;
  }
  if (kind === 'logic.filter') {
    return {
      configuration: { filterTree: { children: [], combinator: 'and' } },
      kind,
      name: 'Filter rows',
    };
  }
  if (kind === 'destination.send_webhook') {
    return webhook
      ? {
          configuration: { destinationId: webhook.id },
          kind,
          name: 'Send webhook',
        }
      : null;
  }
  return table && column
    ? {
        configuration: {
          columnMappings: [
            { sourceColumnId: column.id, targetColumnId: column.id },
          ],
          tableId: table.id,
        },
        kind,
        name: 'Write table',
      }
    : null;
}

function missingResourceMessage(kind: WorkflowNodeKind): string {
  if (kind === 'trigger.table_rows')
    return 'Create a table before adding a trigger.';
  if (kind === 'action.enrich_column')
    return 'Create an enrichment column first.';
  if (kind === 'destination.send_webhook')
    return 'Create a webhook destination first.';
  if (kind === 'destination.write_table')
    return 'A table and column are required.';
  return 'The node cannot be added yet.';
}

function readableError(cause: unknown): string {
  if (
    cause &&
    typeof cause === 'object' &&
    'issues' in cause &&
    Array.isArray(cause.issues) &&
    typeof cause.issues[0]?.message === 'string'
  ) {
    return cause.issues[0].message;
  }
  return cause instanceof Error
    ? cause.message
    : 'The workflow could not be saved.';
}

const paletteItems: ReadonlyArray<{
  group: string;
  kind: WorkflowNodeKind;
  label: string;
}> = [
  { group: 'Trigger', kind: 'trigger.table_rows', label: 'Table rows' },
  { group: 'Action', kind: 'action.enrich_column', label: 'Enrich column' },
  { group: 'Logic', kind: 'logic.filter', label: 'Filter rows' },
  {
    group: 'Destination',
    kind: 'destination.send_webhook',
    label: 'Send webhook',
  },
  {
    group: 'Destination',
    kind: 'destination.write_table',
    label: 'Write table',
  },
];
