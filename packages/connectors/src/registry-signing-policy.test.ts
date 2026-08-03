import { describe, expect, it } from 'vitest';
import { formatRegistryPublisherFingerprint } from './registry-signing-policy';

describe('registry signing policy', () => {
  it('formats every public-key byte and rejects noncanonical keys', () => {
    const key = '0123456789abcdef'.repeat(4);
    expect(formatRegistryPublisherFingerprint(key)).toBe(
      '01234567:89abcdef:01234567:89abcdef:01234567:89abcdef:01234567:89abcdef'
    );
    expect(() => formatRegistryPublisherFingerprint(key.toUpperCase())).toThrow(
      /32-byte lowercase hex/
    );
  });
});
