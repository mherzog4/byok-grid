import { describe, expect, it } from 'vitest';
import {
  authenticationResponseDelayMs,
  MINIMUM_ENUMERATION_SENSITIVE_RESPONSE_MS,
} from './auth-response-timing';

describe('authentication response timing', () => {
  it('adds a minimum floor to enumeration-sensitive email endpoints', () => {
    expect(
      authenticationResponseDelayMs('/api/auth/request-password-reset', 120.25)
    ).toBe(380);
    expect(
      authenticationResponseDelayMs('/api/auth/send-verification-email', 0)
    ).toBe(MINIMUM_ENUMERATION_SENSITIVE_RESPONSE_MS);
    expect(
      authenticationResponseDelayMs('/api/auth/request-password-reset', 700)
    ).toBe(0);
  });

  it('does not delay unrelated authentication operations', () => {
    expect(authenticationResponseDelayMs('/api/auth/sign-in/email', 0)).toBe(0);
  });
});
