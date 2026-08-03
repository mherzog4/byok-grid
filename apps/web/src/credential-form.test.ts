import { describe, expect, it } from 'vitest';
import { readDeclarativeCredential } from './app/app/credential-form';

describe('community connector credential form', () => {
  it('maps reviewed field keys and omits empty optional values', () => {
    const form = new FormData();
    form.set('credential:api_key', 'workspace-owned-key');
    form.set('credential:region', '');

    expect(
      readDeclarativeCredential(
        [
          {
            description: 'Workspace-owned provider API key.',
            key: 'api_key',
            label: 'API key',
            required: true,
            secret: true,
          },
          {
            description: 'Optional provider region.',
            key: 'region',
            label: 'Region',
            required: false,
            secret: false,
          },
        ],
        form
      )
    ).toEqual({ api_key: 'workspace-owned-key' });
  });
});
