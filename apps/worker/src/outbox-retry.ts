export function outboxRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt) - 1, 6));
  return Math.min(60_000, 1_000 * 2 ** exponent);
}
