import { ConnectorError } from '@byok-grid/connectors';
import { describe, expect, it, vi } from 'vitest';
import { executeWaterfallPlan, type WaterfallProgress } from './waterfall';

const plan = {
  kind: 'http_waterfall' as const,
  providers: [
    {
      credentialId: null,
      name: 'Primary',
      providerId: '00000000-0000-4000-8000-000000000601',
      resultPath: 'body.company',
      url: 'https://primary.example.test/search?q=acme.example',
    },
    {
      credentialId: null,
      name: 'Fallback',
      providerId: '00000000-0000-4000-8000-000000000602',
      resultPath: 'body.company',
      url: 'https://fallback.example.test/search?q=acme.example',
    },
  ],
  version: 1 as const,
};

describe('workflow worker HTTP waterfalls', () => {
  it('continues after no-match, persists progress, and resumes without replay', async () => {
    const progress: WaterfallProgress[] = [];
    const executeProvider = vi
      .fn()
      .mockResolvedValueOnce({ body: {}, status: 200 })
      .mockResolvedValueOnce({
        body: { company: { domain: 'acme.example' } },
        requestId: 'request-2',
        status: 200,
      });
    const result = await executeWaterfallPlan({
      executeProvider,
      plan,
      priorOutput: null,
      runId: '00000000-0000-4000-8000-000000000603',
      saveProgress: async (value) => {
        progress.push(value);
      },
    });
    expect(result).toMatchObject({
      attempts: [
        { outcome: 'no_match', providerName: 'Primary' },
        {
          httpStatus: 200,
          outcome: 'match',
          providerName: 'Fallback',
          requestId: 'request-2',
        },
      ],
      matchedProviderName: 'Fallback',
      value: { domain: 'acme.example' },
    });
    expect(progress).toMatchObject([{ nextProviderIndex: 1 }]);

    const resumedProvider = vi.fn().mockResolvedValue({
      body: { company: 'resumed' },
      status: 200,
    });
    const resumed = await executeWaterfallPlan({
      executeProvider: resumedProvider,
      plan,
      priorOutput: progress[0],
      runId: '00000000-0000-4000-8000-000000000603',
      saveProgress: async () => undefined,
    });
    expect(resumedProvider).toHaveBeenCalledTimes(1);
    expect(resumedProvider).toHaveBeenCalledWith(
      plan.providers[1],
      '00000000-0000-4000-8000-000000000603:00000000-0000-4000-8000-000000000602'
    );
    expect(resumed.matchedProviderName).toBe('Fallback');
  });

  it('keeps the current provider position when a retryable limit is hit', async () => {
    const progress: WaterfallProgress[] = [];
    await expect(
      executeWaterfallPlan({
        executeProvider: async () => {
          throw new ConnectorError(
            'rate_limited',
            'Provider limit reached.',
            true
          );
        },
        plan,
        priorOutput: null,
        runId: '00000000-0000-4000-8000-000000000604',
        saveProgress: async (value) => {
          progress.push(value);
        },
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    expect(progress).toMatchObject([
      {
        attempts: [{ outcome: 'rate_limited', providerName: 'Primary' }],
        nextProviderIndex: 0,
      },
    ]);
  });
});
