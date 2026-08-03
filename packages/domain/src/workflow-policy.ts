import { z } from 'zod';
import { bulkRunModeSchema } from './bulk-run-policy';
import { entityIdSchema } from './identifiers';
import { gridSearchQuerySchema } from './grid-search-policy';
import { gridViewFilterTreeSchema } from './grid-view-policy';

export const MAXIMUM_WORKFLOW_NODES = 100;
export const MAXIMUM_WORKFLOW_EDGES = 200;

export const workflowNameSchema = z
  .string()
  .transform((value) => value.trim().normalize('NFKC'))
  .pipe(z.string().min(1).max(80));

const workflowNodeBase = {
  id: entityIdSchema,
  name: workflowNameSchema,
  position: z.strictObject({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  }),
};

const tableRowsTriggerNodeSchema = z.strictObject({
  ...workflowNodeBase,
  configuration: z.strictObject({
    searchQuery: gridSearchQuerySchema.nullable().default(null),
    tableId: entityIdSchema,
    viewId: entityIdSchema.nullable().default(null),
  }),
  kind: z.literal('trigger.table_rows'),
});

const enrichColumnNodeSchema = z.strictObject({
  ...workflowNodeBase,
  configuration: z.strictObject({
    columnId: entityIdSchema,
    mode: bulkRunModeSchema.default('pending'),
  }),
  kind: z.literal('action.enrich_column'),
});

const filterNodeSchema = z.strictObject({
  ...workflowNodeBase,
  configuration: z.strictObject({
    filterTree: gridViewFilterTreeSchema,
  }),
  kind: z.literal('logic.filter'),
});

const writeTableNodeSchema = z.strictObject({
  ...workflowNodeBase,
  configuration: z.strictObject({
    columnMappings: z
      .array(
        z.strictObject({
          sourceColumnId: entityIdSchema,
          targetColumnId: entityIdSchema,
        })
      )
      .min(1)
      .max(256),
    tableId: entityIdSchema,
  }),
  kind: z.literal('destination.write_table'),
});

const sendWebhookNodeSchema = z.strictObject({
  ...workflowNodeBase,
  configuration: z.strictObject({
    destinationId: entityIdSchema,
  }),
  kind: z.literal('destination.send_webhook'),
});

export const workflowNodeSchema = z.discriminatedUnion('kind', [
  tableRowsTriggerNodeSchema,
  enrichColumnNodeSchema,
  filterNodeSchema,
  writeTableNodeSchema,
  sendWebhookNodeSchema,
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeKind = WorkflowNode['kind'];

export const workflowEdgeSchema = z.strictObject({
  id: entityIdSchema,
  sourceHandle: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  sourceNodeId: entityIdSchema,
  targetHandle: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  targetNodeId: entityIdSchema,
});
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

const workflowGraphShapeSchema = z.strictObject({
  edges: z.array(workflowEdgeSchema).max(MAXIMUM_WORKFLOW_EDGES),
  nodes: z.array(workflowNodeSchema).max(MAXIMUM_WORKFLOW_NODES),
  schemaVersion: z.literal(1),
  viewport: z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().finite().min(0.1).max(4),
    })
    .default({ x: 0, y: 0, zoom: 1 }),
});

export const workflowDraftGraphSchema = workflowGraphShapeSchema.superRefine(
  validateWorkflowGraphStructure
);
export type WorkflowDraftGraph = z.infer<typeof workflowDraftGraphSchema>;

export const workflowGraphSchema = workflowGraphShapeSchema.superRefine(
  (graph, context) => {
    validateWorkflowGraphStructure(graph, context);
    validatePublishableWorkflowGraph(graph, context);
  }
);

export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export const workflowDefinitionRequestSchema = z.strictObject({
  graph: workflowDraftGraphSchema,
  name: workflowNameSchema,
});

export const workflowDraftUpdateRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  graph: workflowDraftGraphSchema,
  name: workflowNameSchema,
});

/**
 * The complete payload allowed to cross the SQLite outbox → scheduler boundary.
 * Published plans, mutable inputs, and credentials are resolved by ID at run
 * time so scheduler history cannot become another workflow authority.
 */
export const workflowRunDispatchInputSchema = z.strictObject({
  runId: entityIdSchema,
  workspaceId: entityIdSchema,
});
export type WorkflowRunDispatchInput = z.infer<
  typeof workflowRunDispatchInputSchema
>;

type WorkflowPort = Readonly<{
  id: string;
  type: 'rows';
}>;

const nodePorts: Record<
  WorkflowNodeKind,
  Readonly<{
    inputs: readonly WorkflowPort[];
    outputs: readonly WorkflowPort[];
  }>
> = {
  'trigger.table_rows': {
    inputs: [],
    outputs: [{ id: 'rows', type: 'rows' }],
  },
  'action.enrich_column': {
    inputs: [{ id: 'rows', type: 'rows' }],
    outputs: [{ id: 'rows', type: 'rows' }],
  },
  'logic.filter': {
    inputs: [{ id: 'rows', type: 'rows' }],
    outputs: [
      { id: 'matched', type: 'rows' },
      { id: 'rejected', type: 'rows' },
    ],
  },
  'destination.write_table': {
    inputs: [{ id: 'rows', type: 'rows' }],
    outputs: [],
  },
  'destination.send_webhook': {
    inputs: [{ id: 'rows', type: 'rows' }],
    outputs: [],
  },
};

export function workflowNodePorts(kind: WorkflowNodeKind) {
  return nodePorts[kind];
}

function validateWorkflowGraphStructure(
  graph: {
    edges: WorkflowEdge[];
    nodes: WorkflowNode[];
  },
  context: z.RefinementCtx
) {
  const nodesById = new Map<string, WorkflowNode>();
  for (const [index, node] of graph.nodes.entries()) {
    if (nodesById.has(node.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow node IDs must be unique.',
        path: ['nodes', index, 'id'],
      });
    }
    nodesById.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  const occupiedInputs = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>(
    graph.nodes.map((node) => [node.id, 0] as const)
  );
  for (const [index, edge] of graph.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow edge IDs must be unique.',
        path: ['edges', index, 'id'],
      });
    }
    edgeIds.add(edge.id);

    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!source || !target) {
      context.addIssue({
        code: 'custom',
        message: 'Every edge endpoint must reference a workflow node.',
        path: ['edges', index],
      });
      continue;
    }
    if (source.id === target.id) {
      context.addIssue({
        code: 'custom',
        message: 'A workflow node cannot connect to itself.',
        path: ['edges', index],
      });
      continue;
    }

    const sourcePort = workflowNodePorts(source.kind).outputs.find(
      (port) => port.id === edge.sourceHandle
    );
    const targetPort = workflowNodePorts(target.kind).inputs.find(
      (port) => port.id === edge.targetHandle
    );
    if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) {
      context.addIssue({
        code: 'custom',
        message: 'The edge connects incompatible workflow ports.',
        path: ['edges', index],
      });
      continue;
    }

    const inputKey = `${target.id}:${targetPort.id}`;
    if (occupiedInputs.has(inputKey)) {
      context.addIssue({
        code: 'custom',
        message: 'A workflow input can have only one incoming edge.',
        path: ['edges', index, 'targetHandle'],
      });
    }
    occupiedInputs.add(inputKey);
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), target.id]);
    incomingCount.set(target.id, (incomingCount.get(target.id) ?? 0) + 1);
  }

  const remainingIncoming = new Map(incomingCount);
  const acyclicQueue = graph.nodes
    .filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  let visited = 0;
  while (acyclicQueue.length > 0) {
    const nodeId = acyclicQueue.pop()!;
    visited += 1;
    for (const targetId of outgoing.get(nodeId) ?? []) {
      const nextCount = (remainingIncoming.get(targetId) ?? 0) - 1;
      remainingIncoming.set(targetId, nextCount);
      if (nextCount === 0) acyclicQueue.push(targetId);
    }
  }
  if (visited !== graph.nodes.length) {
    context.addIssue({
      code: 'custom',
      message: 'Workflow cycles are not supported.',
    });
  }
}

function validatePublishableWorkflowGraph(
  graph: {
    edges: WorkflowEdge[];
    nodes: WorkflowNode[];
  },
  context: z.RefinementCtx
) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>(
    graph.nodes.map((node) => [node.id, 0] as const)
  );
  for (const edge of graph.edges) {
    if (
      !nodesById.has(edge.sourceNodeId) ||
      !nodesById.has(edge.targetNodeId)
    ) {
      continue;
    }
    outgoing.set(edge.sourceNodeId, [
      ...(outgoing.get(edge.sourceNodeId) ?? []),
      edge.targetNodeId,
    ]);
    incomingCount.set(
      edge.targetNodeId,
      (incomingCount.get(edge.targetNodeId) ?? 0) + 1
    );
  }

  const triggers = graph.nodes.filter(
    (node) => node.kind === 'trigger.table_rows'
  );
  const destinations = graph.nodes.filter((node) =>
    node.kind.startsWith('destination.')
  );
  if (triggers.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'A workflow needs a trigger.',
    });
  }
  if (destinations.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'A workflow needs at least one destination.',
    });
  }
  for (const [index, node] of graph.nodes.entries()) {
    if (
      node.kind !== 'trigger.table_rows' &&
      (incomingCount.get(node.id) ?? 0) === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Every non-trigger node needs an input.',
        path: ['nodes', index],
      });
    }
  }

  const reachable = new Set<string>();
  const pending = triggers.map((node) => node.id);
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  if (reachable.size !== graph.nodes.length) {
    context.addIssue({
      code: 'custom',
      message: 'Every workflow node must be reachable from a trigger.',
    });
  }
}
