import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyPublicDeployment } from './verify-public-deployment.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const standaloneServer = join(
  repositoryRoot,
  'apps/web/.next/standalone/apps/web/server.js'
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'byok-grid-signup-drill-')
);
const minimumObservedResetResponseMilliseconds = 450;

try {
  await access(standaloneServer).catch(() => {
    throw new Error(
      'The standalone web server is missing. Run npm run build before this drill.'
    );
  });

  await verifyPublicOpenRejected();
  await verifyDisabledSignup();
  await verifyAllowlistedSignup();
  await verifySmtpAccountRecovery();
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_SIGNUP_POLICY_DRILL_PASSED' })
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function verifyPublicOpenRejected() {
  const unsafeProxyRange = '0.0.0.0/0';
  try {
    const runtime = await startRuntime('open', '', {
      BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS: unsafeProxyRange,
    });
    await runtime.stop();
    throw new Error(
      'Public open signup and trust-all proxy configuration unexpectedly reached readiness.'
    );
  } catch (error) {
    const diagnostic = String(error);
    if (
      !diagnostic.includes('open is allowed only for loopback') ||
      !diagnostic.includes('BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS') ||
      diagnostic.includes(unsafeProxyRange)
    ) {
      throw error;
    }
  }
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_PUBLIC_OPEN_SIGNUP_REJECTED' })
  );
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_UNSAFE_PROXY_TRUST_REJECTED' })
  );
}

async function verifyDisabledSignup() {
  const runtime = await startRuntime('disabled', '');
  try {
    await verifyCompiledPublicContract(runtime);
    const signup = await signUp(
      runtime,
      `disabled-${crypto.randomUUID()}@example.test`
    );
    assertStatus(signup, 400, 'disabled signup');
    const signupRequestId = assertRequestId(signup, 'disabled signup');

    const attackerPublicId = 'attacker-public-request-id';
    const attackerInternalId = 'attacker-internal-request-id';
    const page = await fetch(`${runtime.localUrl}/sign-in`, {
      headers: {
        'x-byok-grid-request-id': attackerInternalId,
        'x-request-id': attackerPublicId,
      },
    });
    assertStatus(page, 200, 'disabled sign-in page');
    const pageRequestId = assertRequestId(page, 'disabled sign-in page');
    if (
      pageRequestId === signupRequestId ||
      pageRequestId === attackerPublicId ||
      pageRequestId === attackerInternalId
    ) {
      throw new Error('Request correlation did not issue a fresh server ID.');
    }
    const html = await page.text();
    if (html.includes('Create account')) {
      throw new Error('Disabled signup remained visible in the sign-in UI.');
    }
    const recoveryPage = await fetch(`${runtime.localUrl}/forgot-password`);
    assertStatus(recoveryPage, 404, 'disabled recovery page');

    const crossOriginMutation = await fetch(
      `${runtime.localUrl}/api/auth/sign-up/email`,
      {
        body: JSON.stringify({
          email: `cross-origin-${crypto.randomUUID()}@example.test`,
          name: 'Cross-origin Drill',
          password: 'correct-horse-battery-staple-drill',
        }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.example',
          'x-request-id': attackerPublicId,
        },
        method: 'POST',
      }
    );
    assertStatus(crossOriginMutation, 403, 'cross-origin signup');
    const rejectionRequestId = assertRequestId(
      crossOriginMutation,
      'cross-origin signup'
    );
    if (
      rejectionRequestId === attackerPublicId ||
      rejectionRequestId === signupRequestId ||
      rejectionRequestId === pageRequestId
    ) {
      throw new Error(
        'A rejected request retained or reused a correlation identifier.'
      );
    }
    console.log(
      JSON.stringify({ marker: 'BYOK_GRID_REQUEST_CORRELATION_DRILL_PASSED' })
    );

    const spoofedAttempts = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      spoofedAttempts.push(
        await signIn(
          runtime,
          `missing-${crypto.randomUUID()}@example.test`,
          'correct-horse-battery-staple-drill',
          { 'x-forwarded-for': `198.51.100.${attempt + 1}` }
        )
      );
    }
    for (const [index, response] of spoofedAttempts.entries()) {
      assertStatus(
        response,
        index < 3 ? 401 : 429,
        `spoof-rotated authentication attempt ${index + 1}`
      );
      if (
        index === 3 &&
        response.headers.get('x-byok-grid-rate-limit-layer') !== 'application'
      ) {
        throw new Error(
          'The application rate-limit response lacked exact layer provenance.'
        );
      }
    }
    console.log(
      JSON.stringify({ marker: 'BYOK_GRID_AUTH_RATE_LIMIT_DRILL_PASSED' })
    );
  } finally {
    await runtime.stop();
  }
  console.log(JSON.stringify({ marker: 'BYOK_GRID_SIGNUP_DISABLED_VERIFIED' }));
}

async function verifyCompiledPublicContract(runtime) {
  await verifyPublicDeployment({
    fetchImplementation: (input, init) => {
      const requested = new URL(input);
      return fetch(
        new URL(`${requested.pathname}${requested.search}`, runtime.localUrl),
        init
      );
    },
    origin: runtime.publicUrl,
  });
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_PUBLIC_CONTRACT_DRILL_PASSED' })
  );
}

async function verifyAllowlistedSignup() {
  const allowedEmail = `owner-${crypto.randomUUID()}@example.test`;
  const runtime = await startRuntime('allowlist', allowedEmail);
  try {
    const rejected = await signUp(
      runtime,
      `rejected-${crypto.randomUUID()}@example.test`
    );
    assertStatus(rejected, 400, 'non-allowlisted signup');
    const rejection = await rejected.json();
    if (rejection.code !== 'SIGNUP_NOT_ALLOWED') {
      throw new Error(
        'Non-allowlisted signup returned the wrong error contract.'
      );
    }

    const accepted = await signUp(runtime, allowedEmail.toUpperCase());
    assertStatus(accepted, 200, 'allowlisted signup');
    const firstCookie = sessionCookie(accepted, 'allowlisted signup');

    const secondLogin = await signIn(runtime, allowedEmail);
    assertStatus(secondLogin, 200, 'second allowlisted sign-in');
    const secondCookie = sessionCookie(
      secondLogin,
      'second allowlisted sign-in'
    );

    const blockedSessionsResponse = await fetch(
      `${runtime.localUrl}/api/auth/list-sessions`,
      { headers: { cookie: secondCookie } }
    );
    assertStatus(blockedSessionsResponse, 404, 'external session listing');

    const accountPage = await fetch(`${runtime.localUrl}/app`, {
      headers: { cookie: secondCookie },
    });
    assertStatus(accountPage, 200, 'authenticated account page');
    const accountHtml = await accountPage.text();
    if (!accountHtml.includes('Sign out 1 other session')) {
      throw new Error(
        'The account UI did not expose other-session revocation.'
      );
    }
    for (const cookie of [firstCookie, secondCookie]) {
      if (accountHtml.includes(cookieValue(cookie))) {
        throw new Error(
          'A session credential leaked into rendered account HTML.'
        );
      }
    }

    const revocation = await fetch(
      `${runtime.localUrl}/api/auth/revoke-other-sessions`,
      {
        headers: { cookie: secondCookie, origin: runtime.publicUrl },
        method: 'POST',
      }
    );
    assertStatus(revocation, 200, 'other-session revocation');
    if ((await revocation.json()).status !== true) {
      throw new Error('Other-session revocation returned the wrong contract.');
    }

    const revokedPage = await fetch(`${runtime.localUrl}/app`, {
      headers: { cookie: firstCookie },
      redirect: 'manual',
    });
    assertRedirectToSignIn(revokedPage, 'revoked session');

    const currentPage = await fetch(`${runtime.localUrl}/app`, {
      headers: { cookie: secondCookie },
    });
    assertStatus(currentPage, 200, 'current session after revocation');

    const page = await fetch(`${runtime.localUrl}/sign-in`);
    assertStatus(page, 200, 'allowlist sign-in page');
    const html = await page.text();
    if (!html.includes('operator-approved email addresses')) {
      throw new Error('Allowlist policy was not visible in the sign-in UI.');
    }
  } finally {
    await runtime.stop();
  }
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_SIGNUP_ALLOWLIST_VERIFIED' })
  );
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_SESSION_POLICY_DRILL_PASSED' })
  );
}

async function verifySmtpAccountRecovery() {
  const smtp = await startSmtpReceiver();
  const email = `recovery-${crypto.randomUUID()}@example.test`;
  const originalPassword = 'correct-horse-battery-staple-drill';
  const newPassword = 'replacement-horse-battery-staple-drill';
  const runtime = await startRuntime('allowlist', email, {
    BYOK_GRID_EMAIL_MODE: 'smtp',
    SMTP_FROM_EMAIL: 'security@example.test',
    SMTP_FROM_NAME: 'BYOK Grid Drill',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_REQUIRE_TLS: 'false',
    SMTP_SECURE: 'false',
  });

  try {
    const signInPage = await fetch(`${runtime.localUrl}/sign-in`);
    assertStatus(signInPage, 200, 'SMTP-enabled sign-in page');
    if (!(await signInPage.text()).includes('Forgot your password?')) {
      throw new Error('SMTP-enabled sign-in did not expose account recovery.');
    }

    const signup = await signUp(runtime, email, '/app');
    assertStatus(signup, 200, 'SMTP-enabled signup');
    if (signup.headers.get('set-cookie')) {
      throw new Error('Unverified signup unexpectedly created a session.');
    }
    const verificationMessage = await waitForSmtpMessage(smtp, 0);
    const verificationUrl = extractAuthenticationUrl(
      verificationMessage,
      '/api/auth/verify-email'
    );
    const verification = await fetchLocalAuthenticationUrl(
      runtime,
      verificationUrl
    );
    if (![302, 303, 307, 308].includes(verification.status)) {
      throw new Error('Verification link did not redirect after validation.');
    }
    const verifiedCookie = sessionCookie(verification, 'verified signup');

    const unknownResetStartedAt = performance.now();
    const unknownReset = await requestPasswordReset(
      runtime,
      `missing-${crypto.randomUUID()}@example.test`
    );
    assertEnumerationResponseFloor(
      performance.now() - unknownResetStartedAt,
      'unknown-address reset request'
    );
    assertStatus(unknownReset, 200, 'unknown-address reset request');
    const unknownContract = await unknownReset.json();
    if (
      unknownContract.message !==
      'If this email exists in our system, check your email for the reset link'
    ) {
      throw new Error(
        'Unknown-address reset returned the wrong public contract.'
      );
    }
    await delay(150);
    if (smtp.messages.length !== 1) {
      throw new Error('Unknown-address reset unexpectedly delivered email.');
    }

    const knownResetStartedAt = performance.now();
    const knownReset = await requestPasswordReset(runtime, email);
    assertEnumerationResponseFloor(
      performance.now() - knownResetStartedAt,
      'known-address reset request'
    );
    assertStatus(knownReset, 200, 'known-address reset request');
    const knownContract = await knownReset.json();
    if (knownContract.message !== unknownContract.message) {
      throw new Error('Reset response disclosed whether the account exists.');
    }
    const resetMessage = await waitForSmtpMessage(smtp, 1);
    const resetUrl = extractAuthenticationUrl(
      resetMessage,
      '/api/auth/reset-password/'
    );
    const resetCallback = await fetchLocalAuthenticationUrl(runtime, resetUrl);
    if (![302, 303, 307, 308].includes(resetCallback.status)) {
      throw new Error('Reset link did not redirect after token validation.');
    }
    const callbackLocation = resetCallback.headers.get('location');
    const resetToken = callbackLocation
      ? new URL(callbackLocation, runtime.publicUrl).searchParams.get('token')
      : null;
    if (!resetToken) {
      throw new Error('Validated reset link did not provide a reset token.');
    }
    const resetPageUrl = new URL(callbackLocation, runtime.publicUrl);
    const resetPage = await fetch(
      `${runtime.localUrl}${resetPageUrl.pathname}${resetPageUrl.search}`
    );
    assertStatus(resetPage, 200, 'token-bearing reset page');
    if (
      resetPage.headers.get('cache-control') !==
        'private, no-store, max-age=0' ||
      resetPage.headers.get('x-robots-tag') !== 'noindex, nofollow'
    ) {
      throw new Error('The token-bearing reset page lost its privacy headers.');
    }
    if (!(await resetPage.text()).includes('Choose a new password.')) {
      throw new Error('The validated reset token did not render the reset UI.');
    }

    const reset = await submitPasswordReset(runtime, resetToken, newPassword);
    assertStatus(reset, 200, 'password reset');

    const revokedPage = await fetch(`${runtime.localUrl}/app`, {
      headers: { cookie: verifiedCookie },
      redirect: 'manual',
    });
    assertRedirectToSignIn(revokedPage, 'session revoked by password reset');
    assertStatus(
      await signIn(runtime, email, originalPassword),
      401,
      'old password after reset'
    );
    assertStatus(
      await signIn(runtime, email, newPassword),
      200,
      'new password after reset'
    );
    assertStatus(
      await submitPasswordReset(runtime, resetToken, `${newPassword}-reused`),
      400,
      'reused reset token'
    );
  } finally {
    await runtime.stop();
    await smtp.stop();
  }

  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_SMTP_RECOVERY_DRILL_PASSED' })
  );
}

async function startRuntime(mode, allowedEmails, extraEnvironment = {}) {
  const id = crypto.randomUUID();
  const databaseUrl = `file:${join(temporaryDirectory, `${id}.sqlite`)}`;
  await run('npm', ['run', 'db:sqlite:migrate', '--workspace=@byok-grid/db'], {
    SQLITE_DATABASE_URL: databaseUrl,
  });

  const port = await availablePort();
  const localUrl = `http://127.0.0.1:${port}`;
  const publicUrl = `https://signup-${id}.example.test`;
  const environment = {
    BETTER_AUTH_SECRET: 'drill-only-auth-secret-with-32-characters',
    BETTER_AUTH_URL: publicUrl,
    BYOK_GRID_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    BYOK_GRID_MASTER_KEY_ID: 'drill-v1',
    BYOK_GRID_SIGNUP_ALLOWED_EMAILS: allowedEmails,
    BYOK_GRID_SIGNUP_MODE: mode,
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    PORT: String(port),
    SQLITE_DATABASE_URL: databaseUrl,
    ...extraEnvironment,
  };
  const child = spawn(process.execPath, [standaloneServer], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    await waitUntilHealthy(localUrl, child, () => output);
  } catch (error) {
    child.kill('SIGTERM');
    await exited;
    throw error;
  }

  return {
    child,
    exited,
    localUrl,
    publicUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const timeout = new AbortController();
      try {
        await Promise.race([
          exited,
          delay(5_000, undefined, { signal: timeout.signal }).then(async () => {
            child.kill('SIGKILL');
            await exited;
          }),
        ]);
      } finally {
        timeout.abort();
      }
    },
  };
}

async function signUp(runtime, email, callbackURL) {
  return fetch(`${runtime.localUrl}/api/auth/sign-up/email`, {
    body: JSON.stringify({
      ...(callbackURL ? { callbackURL } : {}),
      email,
      name: 'Signup Drill',
      password: 'correct-horse-battery-staple-drill',
    }),
    headers: {
      'content-type': 'application/json',
      origin: runtime.publicUrl,
    },
    method: 'POST',
  });
}

async function signIn(
  runtime,
  email,
  password = 'correct-horse-battery-staple-drill',
  additionalHeaders = {}
) {
  return fetch(`${runtime.localUrl}/api/auth/sign-in/email`, {
    body: JSON.stringify({
      email,
      password,
    }),
    headers: {
      'content-type': 'application/json',
      origin: runtime.publicUrl,
      ...additionalHeaders,
    },
    method: 'POST',
  });
}

async function requestPasswordReset(runtime, email) {
  return fetch(`${runtime.localUrl}/api/auth/request-password-reset`, {
    body: JSON.stringify({ email, redirectTo: '/reset-password' }),
    headers: {
      'content-type': 'application/json',
      origin: runtime.publicUrl,
    },
    method: 'POST',
  });
}

function assertEnumerationResponseFloor(elapsedMilliseconds, operation) {
  if (elapsedMilliseconds < minimumObservedResetResponseMilliseconds) {
    throw new Error(
      `${operation} completed in ${elapsedMilliseconds.toFixed(1)}ms, below the anti-enumeration response floor.`
    );
  }
}

async function submitPasswordReset(runtime, token, newPassword) {
  return fetch(`${runtime.localUrl}/api/auth/reset-password`, {
    body: JSON.stringify({ newPassword, token }),
    headers: {
      'content-type': 'application/json',
      origin: runtime.publicUrl,
    },
    method: 'POST',
  });
}

async function fetchLocalAuthenticationUrl(runtime, publicUrl) {
  const parsed = new URL(publicUrl);
  return fetch(`${runtime.localUrl}${parsed.pathname}${parsed.search}`, {
    redirect: 'manual',
  });
}

async function waitUntilHealthy(localUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`The signup drill server exited early.\n${output()}`);
    }
    try {
      const response = await fetch(`${localUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The standalone listener may not be bound yet.
    }
    await delay(100);
  }
  throw new Error(
    `The signup drill server did not become healthy.\n${output()}`
  );
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a signup drill port.');
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function startSmtpReceiver() {
  const messages = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.write('220 localhost BYOK Grid drill SMTP\r\n');
    let buffer = '';
    let dataMode = false;

    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.length > 0) {
        if (dataMode) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator < 0) return;
          messages.push(buffer.slice(0, terminator));
          buffer = buffer.slice(terminator + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }

        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.split(' ', 1)[0]?.toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-localhost\r\n250 PIPELINING\r\n');
        } else if (command === 'DATA') {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 bye\r\n');
        } else if (
          command === 'MAIL' ||
          command === 'RCPT' ||
          command === 'RSET' ||
          command === 'NOOP'
        ) {
          socket.write('250 2.0.0 ok\r\n');
        } else {
          socket.write('502 5.5.2 command not implemented\r\n');
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind the SMTP drill receiver.');
  }
  return {
    messages,
    port: address.port,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

async function waitForSmtpMessage(smtp, index) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (smtp.messages[index]) return smtp.messages[index];
    await delay(50);
  }
  throw new Error(`SMTP message ${index + 1} was not delivered.`);
}

function extractAuthenticationUrl(message, path) {
  const decoded = message
    .replace(/=\r\n/gu, '')
    .replace(/=3D/giu, '=')
    .replace(/&amp;/gu, '&');
  const start = decoded.indexOf('https://');
  if (start < 0)
    throw new Error('Authentication email contained no HTTPS URL.');
  const candidate = decoded.slice(start).split(/\s/u, 1)[0];
  const url = new URL(candidate);
  if (!url.pathname.startsWith(path)) {
    throw new Error('Authentication email contained the wrong callback path.');
  }
  return url.href;
}

async function run(command, arguments_, extraEnvironment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}.\n${output}`);
  }
}

function assertStatus(response, expected, operation) {
  if (response.status !== expected) {
    throw new Error(
      `${operation} returned ${response.status}; expected ${expected}.`
    );
  }
}

function assertRequestId(response, operation) {
  const requestId = response.headers.get('x-request-id');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      requestId ?? ''
    )
  ) {
    throw new Error(`${operation} did not return a canonical request ID.`);
  }
  return requestId;
}

function sessionCookie(response, operation) {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.includes('better-auth.session_token='));
  if (!setCookie) {
    throw new Error(`${operation} did not create a session cookie.`);
  }
  if (!/(?:^|;\s*)Max-Age=604800(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${operation} did not use the bounded seven-day cookie.`);
  }
  return setCookie.split(';', 1)[0];
}

function cookieValue(cookie) {
  return cookie.slice(cookie.indexOf('=') + 1);
}

function assertRedirectToSignIn(response, operation) {
  const location = response.headers.get('location');
  if (
    ![302, 303, 307, 308].includes(response.status) ||
    location !== '/sign-in'
  ) {
    throw new Error(
      `${operation} returned ${response.status} with location ${location}; expected a sign-in redirect.`
    );
  }
}

function appendBounded(current, chunk) {
  return `${current}${String(chunk)}`.slice(-8_000);
}
