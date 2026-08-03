import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './navigation';

describe('safe internal navigation', () => {
  it('preserves invitation paths and query strings', () => {
    expect(safeInternalPath('/invite/token-123?from=email')).toBe(
      '/invite/token-123?from=email'
    );
  });

  it('rejects external and backslash-based redirects', () => {
    expect(safeInternalPath('https://attacker.example')).toBe('/app');
    expect(safeInternalPath('//attacker.example/path')).toBe('/app');
    expect(safeInternalPath('/\\attacker.example/path')).toBe('/app');
  });
});
