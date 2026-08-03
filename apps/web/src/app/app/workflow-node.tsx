'use client';

import { workflowNodePorts } from '@byok-grid/domain';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowCanvasNode } from './workflow-editor-model';

const kindLabels = {
  'action.enrich_column': 'ACTION',
  'destination.send_webhook': 'DESTINATION',
  'destination.write_table': 'DESTINATION',
  'logic.filter': 'LOGIC',
  'trigger.table_rows': 'TRIGGER',
} as const;

export function WorkflowNodeView({
  data,
  selected,
}: NodeProps<WorkflowCanvasNode>) {
  const ports = workflowNodePorts(data.node.kind);
  return (
    <article
      className={`workflow-node workflow-node-${data.node.kind.split('.')[0]}${
        selected ? ' selected' : ''
      }`}
    >
      {ports.inputs.map((port, index) => (
        <Handle
          id={port.id}
          key={port.id}
          position={Position.Left}
          style={{ top: `${handlePosition(index, ports.inputs.length)}%` }}
          type="target"
        />
      ))}
      <p>{kindLabels[data.node.kind]}</p>
      <strong>{data.node.name}</strong>
      <span>{kindDescription(data.node.kind)}</span>
      {ports.outputs.map((port, index) => (
        <div
          className="workflow-node-output"
          key={port.id}
          style={{ top: `${handlePosition(index, ports.outputs.length)}%` }}
        >
          {ports.outputs.length > 1 ? <small>{port.id}</small> : null}
          <Handle id={port.id} position={Position.Right} type="source" />
        </div>
      ))}
    </article>
  );
}

function handlePosition(index: number, count: number): number {
  if (count <= 1) return 50;
  return ((index + 1) / (count + 1)) * 100;
}

function kindDescription(kind: WorkflowCanvasNode['data']['node']['kind']) {
  if (kind === 'trigger.table_rows') return 'Select rows from a table';
  if (kind === 'action.enrich_column') return 'Run one enrichment column';
  if (kind === 'logic.filter') return 'Route matching and rejected rows';
  if (kind === 'destination.write_table')
    return 'Copy mapped values into a table';
  return 'Deliver rows to a signed webhook';
}
