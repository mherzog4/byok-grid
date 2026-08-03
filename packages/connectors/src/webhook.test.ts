import { describe, expect, it } from 'vitest';
import { webhookSigningCredentialSchema } from './webhook';

describe('webhook signing credential', () => {
  it('requires a high-entropy secret without control characters', () => {
    expect(
      webhookSigningCredentialSchema.safeParse({
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }).success
    ).toBe(true);
    expect(
      webhookSigningCredentialSchema.safeParse({ secret: 'too-short' }).success
    ).toBe(false);
    expect(
      webhookSigningCredentialSchema.safeParse({
        secret: `${'x'.repeat(42)}\n`,
      }).success
    ).toBe(false);
  });
});
