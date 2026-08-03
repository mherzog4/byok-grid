import { ConnectorError } from '@byok-grid/connectors';
import { ConnectorRevokedError } from '@byok-grid/db/postgres';
import { z } from 'zod';

export interface CellRunFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export function classifyCellRunFailure(error: unknown): CellRunFailure {
  if (error instanceof ConnectorRevokedError) {
    return {
      code: 'connector_revoked',
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'The connector input or credential is invalid.',
      retryable: false,
    };
  }
  return {
    code: 'internal',
    message: 'The connector run failed unexpectedly.',
    retryable: true,
  };
}
