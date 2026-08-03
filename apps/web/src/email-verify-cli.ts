import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createAuthenticationEmailDelivery } from './lib/email-delivery';
import { resolveEmailPolicy } from './lib/email-policy';

if (existsSync('.env')) loadEnvFile('.env');

const policy = resolveEmailPolicy(process.env);
if (policy.mode !== 'smtp') {
  throw new Error(
    'BYOK_GRID_EMAIL_MODE must be smtp before verifying email delivery.'
  );
}

const delivery = createAuthenticationEmailDelivery(
  policy,
  process.env.BETTER_AUTH_URL
);
if (!delivery) throw new Error('SMTP delivery was not constructed.');

await delivery.verify();
console.log(JSON.stringify({ marker: 'BYOK_GRID_SMTP_CONNECTION_VERIFIED' }));
