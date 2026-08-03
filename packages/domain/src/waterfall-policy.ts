export type ProviderOutcome =
  'match' | 'no_match' | 'invalid_input' | 'rate_limited' | 'provider_error';

export type WaterfallDecision =
  'continue' | 'retry_current' | 'stop_failure' | 'stop_success';

/**
 * Product policy seam for multi-provider columns.
 *
 * TODO(product owner): revise this mapping if a no-match, rate limit, or
 * provider error should consume a different fallback or failure policy.
 */
export function decideWaterfallAfterProvider(
  outcome: ProviderOutcome
): WaterfallDecision {
  switch (outcome) {
    case 'match':
      return 'stop_success';
    case 'no_match':
      return 'continue';
    case 'rate_limited':
      return 'retry_current';
    case 'invalid_input':
    case 'provider_error':
      return 'stop_failure';
  }
}
