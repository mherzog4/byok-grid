import { describe, expect, it } from 'vitest';
import { outboxRetryDelayMs } from './outbox-retry';

describe('outbox retry delay', () => {
  it('backs off exponentially and caps at one minute', () => {
    expect(outboxRetryDelayMs(0)).toBe(1_000);
    expect(outboxRetryDelayMs(1)).toBe(1_000);
    expect(outboxRetryDelayMs(2)).toBe(2_000);
    expect(outboxRetryDelayMs(3)).toBe(4_000);
    expect(outboxRetryDelayMs(7)).toBe(60_000);
    expect(outboxRetryDelayMs(100)).toBe(60_000);
  });
});
