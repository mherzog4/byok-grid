import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { resolveClientIpPolicy } from './client-ip-policy';
import { createAuthenticationEmailDelivery } from './email-delivery';
import { resolveEmailPolicy } from './email-policy';
import { createByokGridAuth } from './auth-factory';
import { resolveSessionPolicy } from './session-policy';
import { sqliteDb } from './sqlite-database';
import { resolveSignupPolicy } from './signup-policy';

const isProductionBuild = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
const authBaseUrl =
  process.env.BETTER_AUTH_URL ??
  (isProductionBuild ? 'http://127.0.0.1:3000' : undefined);

export const signupPolicy = resolveSignupPolicy({
  ...process.env,
  BETTER_AUTH_URL: authBaseUrl,
});
export const sessionPolicy = resolveSessionPolicy({
  ...process.env,
  BETTER_AUTH_URL: authBaseUrl,
});
export const emailPolicy = resolveEmailPolicy(process.env);
export const clientIpPolicy = resolveClientIpPolicy(process.env);
const emailDelivery = createAuthenticationEmailDelivery(
  emailPolicy,
  authBaseUrl
);

export const auth = createByokGridAuth({
  baseURL: authBaseUrl,
  clientIpPolicy,
  database: sqliteDb,
  emailDelivery,
  emailPolicy,
  secret:
    process.env.BETTER_AUTH_SECRET ??
    (isProductionBuild
      ? 'build-only-placeholder-never-used-at-runtime'
      : undefined),
  sessionPolicy,
  signupPolicy,
});
