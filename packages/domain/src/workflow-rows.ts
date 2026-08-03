import { z } from 'zod';
import { entityIdSchema } from './identifiers';

export const MAXIMUM_WORKFLOW_ROW_BATCH_SIZE = 500;

export const workflowRowReferenceSchema = z.strictObject({
  rowId: entityIdSchema,
  tableId: entityIdSchema,
});

export const workflowRowBatchSchema = z.strictObject({
  rows: z
    .array(workflowRowReferenceSchema)
    .max(MAXIMUM_WORKFLOW_ROW_BATCH_SIZE),
  schemaVersion: z.literal(1),
});

export type WorkflowRowReference = z.infer<typeof workflowRowReferenceSchema>;
export type WorkflowRowBatch = z.infer<typeof workflowRowBatchSchema>;

export function readWorkflowRowBatchOutput(
  output: unknown,
  handle: string
): WorkflowRowBatch {
  if (!output || Array.isArray(output) || typeof output !== 'object') {
    throw new TypeError('A workflow predecessor returned an invalid output.');
  }
  return workflowRowBatchSchema.parse(
    (output as Readonly<Record<string, unknown>>)[handle]
  );
}
