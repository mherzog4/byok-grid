import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { createByokGridAuth } from './auth-factory';
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

export const auth = createByokGridAuth({
  baseURL: authBaseUrl,
  database: sqliteDb,
  secret:
    process.env.BETTER_AUTH_SECRET ??
    (isProductionBuild
      ? 'build-only-placeholder-never-used-at-runtime'
      : undefined),
  signupPolicy,
});
