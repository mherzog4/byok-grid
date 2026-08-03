import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const standaloneServer = join(
  repositoryRoot,
  'apps/web/.next/standalone/apps/web/server.js'
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'byok-grid-signup-drill-')
);

try {
  await access(standaloneServer).catch(() => {
    throw new Error(
      'The standalone web server is missing. Run npm run build before this drill.'
    );
  });

  await verifyPublicOpenRejected();
  await verifyDisabledSignup();
  await verifyAllowlistedSignup();
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_SIGNUP_POLICY_DRILL_PASSED' })
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function verifyPublicOpenRejected() {
  try {
    const runtime = await startRuntime('open', '');
    await runtime.stop();
    throw new Error('Public open signup unexpectedly reached readiness.');
  } catch (error) {
    if (!String(error).includes('open is allowed only for loopback')) {
      throw error;
    }
  }
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_PUBLIC_OPEN_SIGNUP_REJECTED' })
  );
}

async function verifyDisabledSignup() {
  const runtime = await startRuntime('disabled', '');
  try {
    const signup = await signUp(
      runtime,
      `disabled-${crypto.randomUUID()}@example.test`
    );
    assertStatus(signup, 400, 'disabled signup');

    const page = await fetch(`${runtime.localUrl}/sign-in`);
    assertStatus(page, 200, 'disabled sign-in page');
    const html = await page.text();
    if (html.includes('Create account')) {
      throw new Error('Disabled signup remained visible in the sign-in UI.');
    }
  } finally {
    await runtime.stop();
  }
  console.log(JSON.stringify({ marker: 'BYOK_GRID_SIGNUP_DISABLED_VERIFIED' }));
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
    if (
      !accepted.headers
        .get('set-cookie')
        ?.includes('better-auth.session_token=')
    ) {
      throw new Error('Allowlisted signup did not create a session cookie.');
    }

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
}

async function startRuntime(mode, allowedEmails) {
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

async function signUp(runtime, email) {
  return fetch(`${runtime.localUrl}/api/auth/sign-up/email`, {
    body: JSON.stringify({
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

function appendBounded(current, chunk) {
  return `${current}${String(chunk)}`.slice(-8_000);
}
