import { describe, expect, it } from 'vitest';
import {
  builtInConnectorManifests,
  getBuiltInActionPolicy,
  getBuiltInCredentialSchema,
} from './index';

describe('built-in connector registry', () => {
  it('publishes executable-free manifests for installed connectors', () => {
    expect(builtInConnectorManifests.map((manifest) => manifest.id)).toEqual([
      'http',
      'hunter',
      'openai',
    ]);
    const serialized = JSON.stringify(builtInConnectorManifests);
    expect(serialized).not.toContain('execute');
    expect(serialized).not.toContain('hunter-secret');
  });

  it('keeps provider host policy in trusted definitions', () => {
    expect(getBuiltInActionPolicy('hunter', 'domain_search')).toEqual({
      hosts: ['api.hunter.io'],
      kind: 'fixed',
    });
    expect(getBuiltInActionPolicy('http', 'request')).toEqual({
      kind: 'runtime',
    });
    expect(getBuiltInActionPolicy('openai', 'generate_text')).toEqual({
      hosts: ['api.openai.com'],
      kind: 'fixed',
    });
  });

  it('resolves connector-specific credential schemas', () => {
    expect(
      getBuiltInCredentialSchema('hubspot')?.safeParse({
        accessToken: 'test-private-app-token-123',
      }).success
    ).toBe(true);
    expect(
      getBuiltInCredentialSchema('hunter')?.safeParse({ apiKey: 'key' }).success
    ).toBe(true);
    expect(getBuiltInCredentialSchema('unknown')).toBeUndefined();
    expect(
      getBuiltInCredentialSchema('openai')?.safeParse({ apiKey: 'key' }).success
    ).toBe(true);
  });
});
