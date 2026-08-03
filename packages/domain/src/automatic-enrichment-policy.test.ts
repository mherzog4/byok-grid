import { describe, expect, it } from 'vitest';
import { decideAutomaticFanout } from './automatic-enrichment-policy';

describe('automatic enrichment policy', () => {
  it('deduplicates and orders an allowed fan-out', () => {
    expect(decideAutomaticFanout(['b', 'a', 'b'], 2)).toEqual({
      columnIds: ['a', 'b'],
      kind: 'queue',
    });
  });

  it('blocks the complete change when provider fan-out exceeds the limit', () => {
    expect(decideAutomaticFanout(['a', 'b', 'c'], 2)).toEqual({
      candidateCount: 3,
      kind: 'blocked',
      limit: 2,
    });
  });
});
