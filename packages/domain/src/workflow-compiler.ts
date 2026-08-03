import {
  workflowGraphSchema,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
} from './workflow-policy';

export interface CompiledWorkflowRoute {
  edgeId: string;
  sourceHandle: string;
  sourceStepId: string;
  targetHandle: string;
  targetStepId: string;
}

export interface CompiledWorkflowStep {
  configuration: WorkflowNode['configuration'];
  dependencyStepIds: readonly string[];
  inboundRoutes: readonly CompiledWorkflowRoute[];
  kind: WorkflowNodeKind;
  name: string;
  outboundRoutes: readonly CompiledWorkflowRoute[];
  stepId: string;
}

export interface CompiledWorkflowPlan {
  entryStepIds: readonly string[];
  schemaVersion: 1;
  steps: readonly CompiledWorkflowStep[];
  terminalStepIds: readonly string[];
}

/**
 * Compiles the portable authoring graph into a deterministic execution plan.
 * Editor layout is intentionally absent: retries must depend on published
 * execution semantics, not on where a user dragged a node on the canvas.
 */
export function compileWorkflowGraph(
  graphInput: unknown
): CompiledWorkflowPlan {
  const graph = workflowGraphSchema.parse(graphInput);
  const routes = compileRoutes(graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const inboundByNode = groupRoutes(routes, 'targetStepId');
  const outboundByNode = groupRoutes(routes, 'sourceStepId');
  const orderedStepIds = deterministicTopologicalOrder(
    nodesById,
    inboundByNode,
    outboundByNode
  );

  const steps = orderedStepIds.map((stepId) => {
    const node = nodesById.get(stepId)!;
    const inboundRoutes = inboundByNode.get(stepId) ?? [];
    return {
      configuration: cloneJson(node.configuration),
      dependencyStepIds: [
        ...new Set(inboundRoutes.map((route) => route.sourceStepId)),
      ].sort(),
      inboundRoutes,
      kind: node.kind,
      name: node.name,
      outboundRoutes: outboundByNode.get(stepId) ?? [],
      stepId,
    } satisfies CompiledWorkflowStep;
  });

  return {
    entryStepIds: steps
      .filter((step) => step.inboundRoutes.length === 0)
      .map((step) => step.stepId),
    schemaVersion: 1,
    steps,
    terminalStepIds: steps
      .filter((step) => step.outboundRoutes.length === 0)
      .map((step) => step.stepId),
  };
}

function compileRoutes(graph: WorkflowGraph): CompiledWorkflowRoute[] {
  return graph.edges
    .map((edge) => ({
      edgeId: edge.id,
      sourceHandle: edge.sourceHandle,
      sourceStepId: edge.sourceNodeId,
      targetHandle: edge.targetHandle,
      targetStepId: edge.targetNodeId,
    }))
    .sort(compareRoutes);
}

function groupRoutes(
  routes: readonly CompiledWorkflowRoute[],
  field: 'sourceStepId' | 'targetStepId'
): Map<string, CompiledWorkflowRoute[]> {
  const grouped = new Map<string, CompiledWorkflowRoute[]>();
  for (const route of routes) {
    grouped.set(route[field], [...(grouped.get(route[field]) ?? []), route]);
  }
  return grouped;
}

function deterministicTopologicalOrder(
  nodesById: ReadonlyMap<string, WorkflowNode>,
  inboundByNode: ReadonlyMap<string, readonly CompiledWorkflowRoute[]>,
  outboundByNode: ReadonlyMap<string, readonly CompiledWorkflowRoute[]>
): string[] {
  const remainingDependencies = new Map(
    [...nodesById.keys()].map((nodeId) => [
      nodeId,
      new Set(
        (inboundByNode.get(nodeId) ?? []).map((route) => route.sourceStepId)
      ).size,
    ])
  );
  const ready = [...nodesById.keys()]
    .filter((nodeId) => remainingDependencies.get(nodeId) === 0)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    ordered.push(nodeId);
    const targets = [
      ...new Set(
        (outboundByNode.get(nodeId) ?? []).map((route) => route.targetStepId)
      ),
    ].sort();
    for (const targetId of targets) {
      const remaining = (remainingDependencies.get(targetId) ?? 0) - 1;
      remainingDependencies.set(targetId, remaining);
      if (remaining === 0) insertSorted(ready, targetId);
    }
  }

  if (ordered.length !== nodesById.size) {
    throw new Error('The validated workflow graph could not be ordered.');
  }
  return ordered;
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => candidate > value);
  if (index === -1) values.push(value);
  else values.splice(index, 0, value);
}

function compareRoutes(
  left: CompiledWorkflowRoute,
  right: CompiledWorkflowRoute
): number {
  return (
    left.sourceStepId.localeCompare(right.sourceStepId) ||
    left.sourceHandle.localeCompare(right.sourceHandle) ||
    left.targetStepId.localeCompare(right.targetStepId) ||
    left.targetHandle.localeCompare(right.targetHandle) ||
    left.edgeId.localeCompare(right.edgeId)
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
