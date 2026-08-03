import { z } from 'zod';

const meteredTextOutputSchema = z.object({
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    })
    .nullable(),
});

export function providerUnitsForRun(
  connectorId: string,
  output: unknown
): string | null {
  if (connectorId !== 'openai') return null;
  const parsed = meteredTextOutputSchema.safeParse(output);
  return parsed.success && parsed.data.usage
    ? JSON.stringify(parsed.data.usage)
    : null;
}
