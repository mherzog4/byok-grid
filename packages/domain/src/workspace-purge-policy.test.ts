import { describe, expect, it } from 'vitest';
import {
  workspacePurgeConfirmationMatches,
  workspacePurgeRequestSchema,
} from './workspace-purge-policy';

describe('workspace purge policy', () => {
  it('requires an explicit irreversible acknowledgement and bounded reason', () => {
    expect(
      workspacePurgeRequestSchema.safeParse({
        acknowledgeIrreversible: true,
        confirmationName: 'Revenue Operations',
        previewDigest: 'a'.repeat(64),
        reason: 'user_requested',
      }).success
    ).toBe(true);
    expect(
      workspacePurgeRequestSchema.safeParse({
        acknowledgeIrreversible: false,
        confirmationName: 'Revenue Operations',
        previewDigest: 'a'.repeat(64),
        reason: 'user_requested',
      }).success
    ).toBe(false);
  });

  it('keeps destructive name confirmation exact and case-sensitive', () => {
    expect(
      workspacePurgeConfirmationMatches(
        'Revenue Operations',
        'Revenue Operations'
      )
    ).toBe(true);
    expect(
      workspacePurgeConfirmationMatches(
        'Revenue Operations',
        'revenue operations'
      )
    ).toBe(false);
    expect(
      workspacePurgeConfirmationMatches(
        'Revenue Operations',
        'Revenue Operations '
      )
    ).toBe(false);
  });
});
