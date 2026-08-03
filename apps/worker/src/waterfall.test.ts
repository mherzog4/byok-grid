import { ConnectorError } from '@byok-grid/connectors';
import type { HttpWaterfallRunPlan } from '@byok-grid/domain';
import { describe, expect, it, vi } from 'vitest';
import { executeWaterfallPlan } from './waterfall';

const providerA = '4cb6c9df-c33e-42be-8552-5fc946ab530d';
const providerB = '4fc13ecf-90b7-4cf0-9be3-4449cd440813';
const runId = '77d61a89-4fb0-4300-a9b0-d1c2938b7d8d';

const plan: HttpWaterfallRunPlan = {
  kind: 'http_waterfall',
  providers: [
    {
      credentialId: null,
      name: 'Provider A',
      providerId: providerA,
      resultPath: 'body.company',
      url: 'https://a.example.test/search?domain=acme.test',
    },
    {
      credentialId: null,
      name: 'Provider B',
      providerId: providerB,
      resultPath: 'body.company',
      url: 'https://b.example.test/search?domain=acme.test',
    },
  ],
  version: 1,
};

describe('HTTP waterfall execution', () => {
  it('continues after no-match and stops at the first match', async () => {
    const saveProgress = vi.fn(async () => undefined);
    const executeProvider = vi
      .fn()
      .mockResolvedValueOnce({ body: {}, status: 200 })
      .mockResolvedValueOnce({
        body: { company: { name: 'Acme' } },
        requestId: 'req-2',
        status: 200,
      });

    const result = await executeWaterfallPlan({
      executeProvider,
      plan,
      priorOutput: null,
      runId,
      saveProgress,
    });

    expect(result).toMatchObject({
      matchedProviderId: providerB,
      value: { name: 'Acme' },
    });
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      'no_match',
      'match',
    ]);
    expect(executeProvider).toHaveBeenNthCalledWith(
      2,
      plan.providers[1],
      `${runId}:${providerB}`
    );
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it('resumes after a checkpoint without charging an earlier provider again', async () => {
    const executeProvider = vi.fn().mockResolvedValue({
      body: { company: { name: 'Acme' } },
      status: 200,
    });
    await executeWaterfallPlan({
      executeProvider,
      plan,
      priorOutput: {
        attempts: [
          {
            outcome: 'no_match',
            providerId: providerA,
            providerName: 'Provider A',
          },
        ],
        kind: 'http_waterfall_progress',
        nextProviderIndex: 1,
      },
      runId,
      saveProgress: async () => undefined,
    });
    expect(executeProvider).toHaveBeenCalledTimes(1);
    expect(executeProvider).toHaveBeenCalledWith(
      plan.providers[1],
      `${runId}:${providerB}`
    );
  });

  it('checkpoints a rate limit at the current provider for a durable retry', async () => {
    const saveProgress = vi.fn(async () => undefined);
    await expect(
      executeWaterfallPlan({
        executeProvider: async () => {
          throw new ConnectorError('rate_limited', 'Slow down.', true);
        },
        plan,
        priorOutput: null,
        runId,
        saveProgress,
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ nextProviderIndex: 0 })
    );
  });

  it('stops on provider errors under the default product policy', async () => {
    await expect(
      executeWaterfallPlan({
        executeProvider: async () => {
          throw new ConnectorError('upstream', 'Provider unavailable.', true);
        },
        plan,
        priorOutput: null,
        runId,
        saveProgress: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'upstream', retryable: false });
  });

  it('returns a successful exhausted result when no provider matches', async () => {
    const result = await executeWaterfallPlan({
      executeProvider: async () => ({ body: { company: null }, status: 200 }),
      plan,
      priorOutput: null,
      runId,
      saveProgress: async () => undefined,
    });
    expect(result).toMatchObject({
      matchedProviderId: null,
      value: null,
    });
    expect(result.attempts).toHaveLength(2);
  });
});
