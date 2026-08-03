import { describe, expect, it } from 'vitest';
import { compileWorkflowGraph } from './workflow-compiler';

const ids = {
  destinationMatched: '00000000-0000-4000-8000-000000000004',
  destinationRejected: '00000000-0000-4000-8000-000000000005',
  edgeActionFilter: '00000000-0000-4000-8000-000000000103',
  edgeFilterMatched: '00000000-0000-4000-8000-000000000104',
  edgeFilterRejected: '00000000-0000-4000-8000-000000000105',
  edgeTriggerAction: '00000000-0000-4000-8000-000000000102',
  filter: '00000000-0000-4000-8000-000000000003',
  enrich: '00000000-0000-4000-8000-000000000002',
  trigger: '00000000-0000-4000-8000-000000000001',
};

function graph() {
  return {
    edges: [
      {
        id: ids.edgeFilterRejected,
        sourceHandle: 'rejected',
        sourceNodeId: ids.filter,
        targetHandle: 'rows',
        targetNodeId: ids.destinationRejected,
      },
      {
        id: ids.edgeTriggerAction,
        sourceHandle: 'rows',
        sourceNodeId: ids.trigger,
        targetHandle: 'rows',
        targetNodeId: ids.enrich,
      },
      {
        id: ids.edgeFilterMatched,
        sourceHandle: 'matched',
        sourceNodeId: ids.filter,
        targetHandle: 'rows',
        targetNodeId: ids.destinationMatched,
      },
      {
        id: ids.edgeActionFilter,
        sourceHandle: 'rows',
        sourceNodeId: ids.enrich,
        targetHandle: 'rows',
        targetNodeId: ids.filter,
      },
    ],
    nodes: [
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000015',
        },
        id: ids.destinationRejected,
        kind: 'destination.send_webhook',
        name: 'Rejected leads',
        position: { x: 900, y: 200 },
      },
      {
        configuration: {
          filterTree: {
            children: [],
            combinator: 'and',
          },
        },
        id: ids.filter,
        kind: 'logic.filter',
        name: 'Qualified?',
        position: { x: 600, y: 0 },
      },
      {
        configuration: {
          columnId: '00000000-0000-4000-8000-000000000012',
          mode: 'pending',
        },
        id: ids.enrich,
        kind: 'action.enrich_column',
        name: 'Enrich company',
        position: { x: 300, y: 0 },
      },
      {
        configuration: {
          searchQuery: null,
          tableId: '00000000-0000-4000-8000-000000000011',
          viewId: null,
        },
        id: ids.trigger,
        kind: 'trigger.table_rows',
        name: 'New leads',
        position: { x: 0, y: 0 },
      },
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000014',
        },
        id: ids.destinationMatched,
        kind: 'destination.send_webhook',
        name: 'Qualified leads',
        position: { x: 900, y: -200 },
      },
    ],
    schemaVersion: 1,
    viewport: { x: 400, y: 200, zoom: 0.8 },
  };
}

describe('workflow compiler', () => {
  it('produces a deterministic execution plan with named branch routes', () => {
    const plan = compileWorkflowGraph(graph());

    expect(plan.entryStepIds).toEqual([ids.trigger]);
    expect(plan.terminalStepIds).toEqual([
      ids.destinationMatched,
      ids.destinationRejected,
    ]);
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      ids.trigger,
      ids.enrich,
      ids.filter,
      ids.destinationMatched,
      ids.destinationRejected,
    ]);
    expect(plan.steps.find((step) => step.stepId === ids.filter)).toMatchObject(
      {
        dependencyStepIds: [ids.enrich],
        outboundRoutes: [
          expect.objectContaining({
            sourceHandle: 'matched',
            targetStepId: ids.destinationMatched,
          }),
          expect.objectContaining({
            sourceHandle: 'rejected',
            targetStepId: ids.destinationRejected,
          }),
        ],
      }
    );
    expect(JSON.stringify(plan)).not.toContain('position');
    expect(JSON.stringify(plan)).not.toContain('viewport');
  });

  it('is independent of authoring-array order and does not alias configuration', () => {
    const authored = graph();
    const first = compileWorkflowGraph(authored);
    authored.nodes.reverse();
    authored.edges.reverse();
    const second = compileWorkflowGraph(authored);

    expect(second).toEqual(first);
    authored.nodes.find((node) => node.id === ids.enrich)!.name = 'Changed';
    expect(first.steps.find((step) => step.stepId === ids.enrich)?.name).toBe(
      'Enrich company'
    );
  });
});
