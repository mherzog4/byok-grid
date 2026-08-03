import { z } from 'zod';

export const connectorRunModeSchema = z.enum(['manual', 'on_change']);
export type ConnectorRunMode = z.infer<typeof connectorRunModeSchema>;

export type AutomaticFanoutDecision =
  | { columnIds: string[]; kind: 'queue' }
  | { candidateCount: number; kind: 'blocked'; limit: number };

export function decideAutomaticFanout(
  candidateColumnIds: readonly string[],
  maximumRuns: number
): AutomaticFanoutDecision {
  const columnIds = [...new Set(candidateColumnIds)].sort();
  // CONTRIBUTOR DECISION POINT: the safe default blocks the whole fan-out so
  // column ordering cannot silently decide which providers incur cost. A
  // product may instead queue a deterministic prefix and retain the remainder.
  return columnIds.length > maximumRuns
    ? { candidateCount: columnIds.length, kind: 'blocked', limit: maximumRuns }
    : { columnIds, kind: 'queue' };
}
