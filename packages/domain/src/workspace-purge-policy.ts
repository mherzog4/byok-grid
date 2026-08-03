import { z } from 'zod';

export const workspacePurgeReasonSchema = z.enum([
  'duplicate_workspace',
  'test_data',
  'user_requested',
  'other',
]);
export type WorkspacePurgeReason = z.infer<typeof workspacePurgeReasonSchema>;

export const workspacePurgeRequestSchema = z.strictObject({
  acknowledgeIrreversible: z.literal(true),
  confirmationName: z.string().min(1).max(120),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reason: workspacePurgeReasonSchema,
});
export type WorkspacePurgeRequest = z.infer<typeof workspacePurgeRequestSchema>;

export interface WorkspacePurgeImpact {
  auditRecords: number;
  cells: number;
  columns: number;
  credentials: number;
  executionRecords: number;
  integrations: number;
  invitations: number;
  members: number;
  rows: number;
  tables: number;
}

/**
 * Destructive confirmation is intentionally exact and case-sensitive. A
 * normalized comparison could accept text that is visually similar but not
 * the actual workspace name shown in the impact preview.
 */
export function workspacePurgeConfirmationMatches(
  workspaceName: string,
  confirmationName: string
): boolean {
  return confirmationName === workspaceName;
}
