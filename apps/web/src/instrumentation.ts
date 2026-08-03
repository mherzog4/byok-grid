import { PHASE_PRODUCTION_BUILD } from 'next/constants';

export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD
  ) {
    try {
      const { assertWebRuntimeConfiguration } =
        await import('./lib/runtime-config');
      assertWebRuntimeConfiguration();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown web runtime configuration error.';
      console.error(message);
      process.exit(1);
    }
  }
}
