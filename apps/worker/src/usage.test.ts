import { describe, expect, it } from 'vitest';
import { providerUnitsForRun } from './usage';

describe('provider usage extraction', () => {
  it('records validated OpenAI token units', () => {
    expect(
      JSON.parse(
        providerUnitsForRun('openai', {
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        })!
      )
    ).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });

  it('ignores absent, malformed, and unmetered output', () => {
    expect(providerUnitsForRun('openai', { usage: null })).toBeNull();
    expect(
      providerUnitsForRun('openai', { usage: { totalTokens: -1 } })
    ).toBeNull();
    expect(
      providerUnitsForRun('hunter', { usage: { totalTokens: 10 } })
    ).toBeNull();
  });
});
