import { ConnectorError } from '@byok-grid/connectors';
import { ConnectorRevokedError } from '@byok-grid/db/postgres';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyCellRunFailure } from './cell-run-failure-policy';

describe('cell run failure policy', () => {
  it('makes an emergency connector revocation terminal and visible', () => {
    expect(
      classifyCellRunFailure(
        new ConnectorRevokedError('community_lookup@1.2.3 is revoked.')
      )
    ).toEqual({
      code: 'connector_revoked',
      message: 'community_lookup@1.2.3 is revoked.',
      retryable: false,
    });
  });

  it('preserves connector retry decisions and hides unknown internals', () => {
    expect(
      classifyCellRunFailure(
        new ConnectorError('transient', 'Provider unavailable.', true)
      )
    ).toEqual({
      code: 'transient',
      message: 'Provider unavailable.',
      retryable: true,
    });
    expect(classifyCellRunFailure(new Error('secret detail'))).toEqual({
      code: 'internal',
      message: 'The connector run failed unexpectedly.',
      retryable: true,
    });
  });

  it('makes invalid durable inputs terminal', () => {
    const error = z.string().safeParse(1).error;
    expect(classifyCellRunFailure(error)).toMatchObject({
      code: 'invalid_input',
      retryable: false,
    });
  });
});
