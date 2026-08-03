import { describe, expect, it } from 'vitest';
import {
  canConnectWorkflowNodes,
  workflowCanvasToDraft,
  workflowDraftToCanvas,
} from './workflow-editor-model';

const triggerId = '00000000-0000-4000-8000-000000000001';
const filterId = '00000000-0000-4000-8000-000000000002';
const destinationId = '00000000-0000-4000-8000-000000000003';

function draft() {
  return {
    edges: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        sourceHandle: 'rows',
        sourceNodeId: triggerId,
        targetHandle: 'rows',
        targetNodeId: filterId,
      },
      {
        id: '00000000-0000-4000-8000-000000000102',
        sourceHandle: 'matched',
        sourceNodeId: filterId,
        targetHandle: 'rows',
        targetNodeId: destinationId,
      },
    ],
    nodes: [
      {
        configuration: {
          searchQuery: null,
          tableId: '00000000-0000-4000-8000-000000000011',
          viewId: null,
        },
        id: triggerId,
        kind: 'trigger.table_rows',
        name: 'Rows',
        position: { x: 0, y: 0 },
      },
      {
        configuration: {
          filterTree: { children: [], combinator: 'and' },
        },
        id: filterId,
        kind: 'logic.filter',
        name: 'Qualified?',
        position: { x: 300, y: 0 },
      },
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000012',
        },
        id: destinationId,
        kind: 'destination.send_webhook',
        name: 'Send',
        position: { x: 600, y: 0 },
      },
    ],
    schemaVersion: 1,
    viewport: { x: 25, y: 50, zoom: 1.2 },
  };
}

describe('workflow editor model', () => {
  it('round-trips the portable graph without React Flow state', () => {
    const canvas = workflowDraftToCanvas(draft());
    canvas.nodes[0]!.selected = true;
    canvas.nodes[0]!.measured = { height: 100, width: 200 };

    expect(
      workflowCanvasToDraft(canvas.nodes, canvas.edges, canvas.viewport)
    ).toEqual(draft());
  });

  it('uses domain validation for handles, occupied inputs, and cycles', () => {
    const canvas = workflowDraftToCanvas(draft());
    expect(
      canConnectWorkflowNodes(canvas.nodes, canvas.edges, {
        source: filterId,
        sourceHandle: 'rejected',
        target: destinationId,
        targetHandle: 'rows',
      })
    ).toBe(false);
    expect(
      canConnectWorkflowNodes(canvas.nodes, canvas.edges, {
        source: destinationId,
        sourceHandle: 'rows',
        target: triggerId,
        targetHandle: 'rows',
      })
    ).toBe(false);
    expect(
      canConnectWorkflowNodes(canvas.nodes, canvas.edges, {
        source: filterId,
        sourceHandle: 'rejected',
        target: triggerId,
        targetHandle: 'rows',
      })
    ).toBe(false);
  });
});
