import { ConnectorError, type ConnectorErrorCode } from '@byok-grid/connectors';
import {
  decideWaterfallAfterProvider,
  httpWaterfallRunPlanSchema,
  type HttpWaterfallRunPlan,
  type ProviderOutcome,
} from '@byok-grid/domain';

export interface WaterfallAttempt {
  errorCode?: string;
  httpStatus?: number;
  outcome: ProviderOutcome;
  providerId: string;
  providerName: string;
  requestId?: string;
}

export interface WaterfallProgress {
  attempts: WaterfallAttempt[];
  kind: 'http_waterfall_progress';
  nextProviderIndex: number;
}

export interface WaterfallResult {
  attempts: WaterfallAttempt[];
  kind: 'http_waterfall_result';
  matchedProviderId: string | null;
  matchedProviderName: string | null;
  value: unknown;
}

export async function executeWaterfallPlan(input: {
  executeProvider: (
    provider: HttpWaterfallRunPlan['providers'][number],
    idempotencyKey: string
  ) => Promise<unknown>;
  plan: HttpWaterfallRunPlan;
  priorOutput: unknown;
  runId: string;
  saveProgress: (progress: WaterfallProgress) => Promise<void>;
}): Promise<WaterfallResult> {
  const plan = httpWaterfallRunPlanSchema.parse(input.plan);
  const prior = readProgress(input.priorOutput, plan.providers.length);
  const attempts = [...prior.attempts];

  for (
    let providerIndex = prior.nextProviderIndex;
    providerIndex < plan.providers.length;
    providerIndex += 1
  ) {
    const provider = plan.providers[providerIndex]!;
    let output: unknown;
    try {
      output = await input.executeProvider(
        provider,
        `${input.runId}:${provider.providerId}`
      );
    } catch (error) {
      const failure = classifyProviderFailure(error);
      attempts.push({
        errorCode: failure.code,
        outcome: failure.outcome,
        providerId: provider.providerId,
        providerName: provider.name,
      });
      const decision = decideWaterfallAfterProvider(failure.outcome);
      await input.saveProgress({
        attempts,
        kind: 'http_waterfall_progress',
        nextProviderIndex:
          decision === 'retry_current' ? providerIndex : providerIndex + 1,
      });
      if (decision === 'continue') continue;
      throw new ConnectorError(
        failure.code,
        failure.message,
        decision === 'retry_current',
        { cause: error }
      );
    }

    const value = readResultPath(output, provider.resultPath);
    const outcome: ProviderOutcome = hasMatchValue(value)
      ? 'match'
      : 'no_match';
    attempts.push({
      ...readResponseMetadata(output),
      outcome,
      providerId: provider.providerId,
      providerName: provider.name,
    });
    const decision = decideWaterfallAfterProvider(outcome);
    if (decision === 'stop_success') {
      return {
        attempts,
        kind: 'http_waterfall_result',
        matchedProviderId: provider.providerId,
        matchedProviderName: provider.name,
        value,
      };
    }
    await input.saveProgress({
      attempts,
      kind: 'http_waterfall_progress',
      nextProviderIndex: providerIndex + 1,
    });
  }

  return {
    attempts,
    kind: 'http_waterfall_result',
    matchedProviderId: null,
    matchedProviderName: null,
    value: null,
  };
}

function readProgress(
  output: unknown,
  providerCount: number
): WaterfallProgress {
  if (!output || typeof output !== 'object') {
    return {
      attempts: [],
      kind: 'http_waterfall_progress',
      nextProviderIndex: 0,
    };
  }
  const candidate = output as Partial<WaterfallProgress>;
  if (
    candidate.kind !== 'http_waterfall_progress' ||
    !Array.isArray(candidate.attempts) ||
    !Number.isInteger(candidate.nextProviderIndex) ||
    candidate.nextProviderIndex! < 0 ||
    candidate.nextProviderIndex! > providerCount
  ) {
    return {
      attempts: [],
      kind: 'http_waterfall_progress',
      nextProviderIndex: 0,
    };
  }
  return candidate as WaterfallProgress;
}

function classifyProviderFailure(error: unknown): {
  code: ConnectorErrorCode;
  message: string;
  outcome: ProviderOutcome;
} {
  if (!(error instanceof ConnectorError)) {
    return {
      code: 'upstream',
      message: 'The provider failed unexpectedly.',
      outcome: 'provider_error',
    };
  }
  if (error.code === 'rate_limited') {
    return {
      code: error.code,
      message: error.message,
      outcome: 'rate_limited',
    };
  }
  if (
    error.code === 'authentication' ||
    error.code === 'invalid_input' ||
    error.code === 'policy' ||
    error.code === 'response_too_large'
  ) {
    return {
      code: error.code,
      message: error.message,
      outcome: 'invalid_input',
    };
  }
  return {
    code: error.code,
    message: error.message,
    outcome: 'provider_error',
  };
}

function readResultPath(output: unknown, path: string): unknown {
  let current = output;
  for (const segment of path.split('.')) {
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasMatchValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function readResponseMetadata(output: unknown): {
  httpStatus?: number;
  requestId?: string;
} {
  if (!output || typeof output !== 'object') return {};
  const value = output as { requestId?: unknown; status?: unknown };
  return {
    ...(typeof value.status === 'number' ? { httpStatus: value.status } : {}),
    ...(typeof value.requestId === 'string'
      ? { requestId: value.requestId }
      : {}),
  };
}
