import { describe, expect, it } from 'vitest';
import {
  workflowDraftGraphSchema,
  workflowGraphSchema,
} from './workflow-policy';

const triggerId = '00000000-0000-4000-8000-000000000001';
const actionId = '00000000-0000-4000-8000-000000000002';
const destinationId = '00000000-0000-4000-8000-000000000003';
const tableId = '00000000-0000-4000-8000-000000000010';
const columnId = '00000000-0000-4000-8000-000000000011';

function validGraph() {
  return {
    edges: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        sourceHandle: 'rows',
        sourceNodeId: triggerId,
        targetHandle: 'rows',
        targetNodeId: actionId,
      },
      {
        id: '00000000-0000-4000-8000-000000000102',
        sourceHandle: 'rows',
        sourceNodeId: actionId,
        targetHandle: 'rows',
        targetNodeId: destinationId,
      },
    ],
    nodes: [
      {
        configuration: {
          searchQuery: '  ＡＣＭＥ  Corp ',
          tableId,
          viewId: null,
        },
        id: triggerId,
        kind: 'trigger.table_rows',
        name: ' Rows ',
        position: { x: 0, y: 0 },
      },
      {
        configuration: { columnId, mode: 'pending' },
        id: actionId,
        kind: 'action.enrich_column',
        name: 'Enrich',
        position: { x: 250, y: 0 },
      },
      {
        configuration: { destinationId },
        id: destinationId,
        kind: 'destination.send_webhook',
        name: 'Send',
        position: { x: 500, y: 0 },
      },
    ],
    schemaVersion: 1,
    viewport: { x: 10, y: 20, zoom: 1.2 },
  };
}

describe('workflow graph policy', () => {
  it('allows an incomplete but structurally safe draft', () => {
    expect(
      workflowDraftGraphSchema.parse({
        edges: [],
        nodes: [],
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
      })
    ).toMatchObject({ edges: [], nodes: [] });
    expect(() =>
      workflowGraphSchema.parse({
        edges: [],
        nodes: [],
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
      })
    ).toThrow(/needs a trigger/);
  });

  it('normalizes a valid portable graph', () => {
    const graph = workflowGraphSchema.parse(validGraph());

    expect(graph.nodes[0]?.name).toBe('Rows');
    if (graph.nodes[0]?.kind !== 'trigger.table_rows') throw new Error();
    expect(graph.nodes[0].configuration.searchQuery).toBe('ACME Corp');
  });

  it('rejects incompatible handles', () => {
    const graph = validGraph();
    graph.edges[0]!.sourceHandle = 'missing';

    expect(() => workflowGraphSchema.parse(graph)).toThrow(
      /incompatible workflow ports/
    );
  });

  it('rejects cycles', () => {
    const graph = validGraph();
    graph.edges.push({
      id: '00000000-0000-4000-8000-000000000103',
      sourceHandle: 'rows',
      sourceNodeId: actionId,
      targetHandle: 'rows',
      targetNodeId: actionId,
    });

    expect(() => workflowGraphSchema.parse(graph)).toThrow(
      /cannot connect to itself|cycles are not supported/
    );
  });

  it('rejects nodes that are not reachable from a trigger', () => {
    const graph = validGraph();
    graph.edges.splice(1, 1);

    expect(() => workflowGraphSchema.parse(graph)).toThrow(
      /needs an input|reachable from a trigger/
    );
  });
});
