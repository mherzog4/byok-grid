import { describe, expect, it } from 'vitest';
import { decideWaterfallAfterProvider } from './waterfall-policy';

describe('waterfall product policy', () => {
  it.each([
    ['match', 'stop_success'],
    ['no_match', 'continue'],
    ['rate_limited', 'retry_current'],
    ['invalid_input', 'stop_failure'],
    ['provider_error', 'stop_failure'],
  ] as const)('maps %s to %s', (outcome, expected) => {
    expect(decideWaterfallAfterProvider(outcome)).toBe(expected);
  });
});
