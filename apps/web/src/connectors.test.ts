import { describe, expect, it } from 'vitest';
import { GET } from './app/api/connectors/route';

describe('connector catalog API', () => {
  it('returns cacheable serializable manifests without executable code', async () => {
    const response = GET();
    const body = (await response.json()) as {
      connectors: Array<{ actions: Array<{ id: string }>; id: string }>;
    };

    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(body.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ id: 'domain_search' }),
          ]),
          id: 'hunter',
        }),
        expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ id: 'generate_text' }),
          ]),
          id: 'openai',
        }),
      ])
    );
    expect(JSON.stringify(body)).not.toContain('execute');
  });
});
