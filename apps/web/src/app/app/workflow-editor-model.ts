import {
  workflowDraftGraphSchema,
  type WorkflowDraftGraph,
  type WorkflowEdge,
  type WorkflowNode,
} from '@byok-grid/domain';
import type {
  Connection,
  Edge,
  Node,
  Viewport,
  XYPosition,
} from '@xyflow/react';

export type WorkflowCanvasNodeValue = WorkflowNode extends infer NodeType
  ? NodeType extends WorkflowNode
    ? Omit<NodeType, 'id' | 'position'>
    : never
  : never;

export type WorkflowCanvasNodeData = Record<string, unknown> & {
  node: WorkflowCanvasNodeValue;
};

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, 'workflow'>;
export type WorkflowCanvasEdge = Edge<Record<string, never>, 'smoothstep'>;

export interface WorkflowCanvasModel {
  edges: WorkflowCanvasEdge[];
  nodes: WorkflowCanvasNode[];
  viewport: Viewport;
}

export function workflowDraftToCanvas(
  graphInput: unknown
): WorkflowCanvasModel {
  const graph = workflowDraftGraphSchema.parse(graphInput);
  return {
    edges: graph.edges.map((edge) => ({
      data: {},
      id: edge.id,
      label: edge.sourceHandle === 'rows' ? undefined : edge.sourceHandle,
      source: edge.sourceNodeId,
      sourceHandle: edge.sourceHandle,
      target: edge.targetNodeId,
      targetHandle: edge.targetHandle,
      type: 'smoothstep',
    })),
    nodes: graph.nodes.map(({ id, position, ...node }) => ({
      data: { node },
      id,
      position,
      type: 'workflow',
    })),
    viewport: graph.viewport,
  };
}

export function workflowCanvasToDraft(
  nodes: readonly WorkflowCanvasNode[],
  edges: readonly WorkflowCanvasEdge[],
  viewport: Viewport
): WorkflowDraftGraph {
  return workflowDraftGraphSchema.parse({
    edges: edges.map(canvasEdgeToWorkflowEdge),
    nodes: nodes.map((node) => ({
      ...node.data.node,
      id: node.id,
      position: node.position,
    })),
    schemaVersion: 1,
    viewport,
  });
}

export function canConnectWorkflowNodes(
  nodes: readonly WorkflowCanvasNode[],
  edges: readonly WorkflowCanvasEdge[],
  connection: Connection
): boolean {
  if (
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  ) {
    return false;
  }
  return workflowDraftGraphSchema.safeParse({
    edges: [
      ...edges.map(canvasEdgeToWorkflowEdge),
      {
        id: crypto.randomUUID(),
        sourceHandle: connection.sourceHandle,
        sourceNodeId: connection.source,
        targetHandle: connection.targetHandle,
        targetNodeId: connection.target,
      },
    ],
    nodes: nodes.map((node) => ({
      ...node.data.node,
      id: node.id,
      position: node.position,
    })),
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
  }).success;
}

export function createWorkflowCanvasNode(
  node: WorkflowCanvasNodeValue,
  position: XYPosition,
  id = crypto.randomUUID()
): WorkflowCanvasNode {
  const draft = workflowDraftGraphSchema.parse({
    edges: [],
    nodes: [{ ...node, id, position }],
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const created = draft.nodes[0]!;
  const { id: createdId, position: createdPosition, ...createdValue } = created;
  return {
    data: { node: createdValue as WorkflowCanvasNodeValue },
    id: createdId,
    position: createdPosition,
    type: 'workflow',
  };
}

function canvasEdgeToWorkflowEdge(edge: WorkflowCanvasEdge): WorkflowEdge {
  return {
    id: edge.id,
    sourceHandle: edge.sourceHandle ?? '',
    sourceNodeId: edge.source,
    targetHandle: edge.targetHandle ?? '',
    targetNodeId: edge.target,
  };
}
