import type { SqliteBulkRunLimits } from '@byok-grid/db';
import { z } from 'zod';

const limitsSchema = z.object({
  maxOutputTokens: z.coerce.number().int().min(1).default(500_000),
  maxProviderRequests: z.coerce.number().int().min(1).default(1_000),
  maxRows: z.coerce.number().int().min(1).default(500),
});

export function getBulkRunLimits(): SqliteBulkRunLimits {
  return limitsSchema.parse({
    maxOutputTokens: process.env.BULK_RUN_MAX_OUTPUT_TOKENS,
    maxProviderRequests: process.env.BULK_RUN_MAX_PROVIDER_REQUESTS,
    maxRows: process.env.BULK_RUN_MAX_ROWS,
  });
}
