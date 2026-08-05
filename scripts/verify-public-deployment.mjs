import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_API_BODY_BYTES = 64 * 1_024;
const MAXIMUM_HTML_BODY_BYTES = 2 * 1_024 * 1_024;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseProductionOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The deployment origin must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('The deployment origin must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('The deployment origin must not contain credentials.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      'The deployment origin must not contain a path, query, or fragment.'
    );
  }
  return url.origin;
}

export async function verifyPublicDeployment(options) {
  const origin = parseProductionOrigin(options.origin);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;

  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new Error(
      'The deployment verification timeout must be between 1000 and 60000 milliseconds.'
    );
  }

  const [live, ready, firstPage, secondPage] = await Promise.all([
    request(origin, '/api/live', fetchImplementation, timeoutMilliseconds),
    request(origin, '/api/health', fetchImplementation, timeoutMilliseconds),
    request(origin, '/app', fetchImplementation, timeoutMilliseconds),
    request(origin, '/app', fetchImplementation, timeoutMilliseconds),
  ]);

  const liveBody = await verifyJsonResponse(live, '/api/live', {
    status: 'ok',
  });
  const readyBody = await verifyJsonResponse(ready, '/api/health', {
    configuration: 'valid',
    database: 'sqlite',
    status: 'ok',
  });
  const firstPageEvidence = await verifyHtmlResponse(firstPage, '/app');
  const secondPageEvidence = await verifyHtmlResponse(secondPage, '/app');

  if (firstPageEvidence.nonce === secondPageEvidence.nonce) {
    throw new Error('/app reused its Content Security Policy nonce.');
  }

  const requestIds = [
    live.requestId,
    ready.requestId,
    firstPage.requestId,
    secondPage.requestId,
  ];
  if (new Set(requestIds).size !== requestIds.length) {
    throw new Error('The deployment reused an X-Request-ID across requests.');
  }

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.valueOf())) {
    throw new Error(
      'The deployment verification clock returned an invalid date.'
    );
  }

  return {
    checks: {
      cspNonceUnique: true,
      health: readyBody.status,
      live: liveBody.status,
      requestIdsUnique: true,
      securityHeaders: true,
    },
    marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
    origin,
    requests: requestIds.length,
    verifiedAt: verifiedAt.toISOString(),
  };
}

async function request(
  origin,
  pathname,
  fetchImplementation,
  timeoutMilliseconds
) {
  let response;
  try {
    response = await fetchImplementation(new URL(pathname, origin), {
      headers: {
        accept: pathname.startsWith('/api/') ? 'application/json' : 'text/html',
        'cache-control': 'no-cache',
        'user-agent': 'byok-grid-production-verifier/1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    throw new Error(`${pathname} could not be reached.`, { cause: error });
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${pathname} unexpectedly redirected.`);
  }
  if (response.status !== 200) {
    throw new Error(`${pathname} returned HTTP ${response.status}.`);
  }

  const requestId = response.headers.get('x-request-id');
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`${pathname} did not return a valid X-Request-ID.`);
  }

  verifySecurityHeaders(response.headers, pathname);
  return { pathname, requestId, response };
}

async function verifyJsonResponse(result, pathname, expected) {
  const contentType = result.response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error(`${pathname} did not return application/json.`);
  }
  verifyNoStore(result.response.headers, pathname);

  const body = await readBoundedBody(
    result.response,
    MAXIMUM_API_BODY_BYTES,
    pathname
  );
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${pathname} did not return valid JSON.`);
  }
  if (!hasExactPrimitiveShape(parsed, expected)) {
    throw new Error(`${pathname} returned an unexpected health contract.`);
  }
  return parsed;
}

function hasExactPrimitiveShape(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key, index) =>
        key === expectedKeys[index] && value[key] === expected[key]
    )
  );
}

async function verifyHtmlResponse(result, pathname) {
  const contentType = result.response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('text/html')) {
    throw new Error(`${pathname} did not return text/html.`);
  }
  verifyNoStore(result.response.headers, pathname);

  const policy = result.response.headers.get('content-security-policy');
  const nonce = contentSecurityPolicyNonce(policy, pathname);
  const body = await readBoundedBody(
    result.response,
    MAXIMUM_HTML_BODY_BYTES,
    pathname
  );
  const scripts = body.match(/<script\b[^>]*>/giu) ?? [];
  if (scripts.length === 0) {
    throw new Error(`${pathname} did not render any script elements.`);
  }
  for (const script of scripts) {
    const match = /\bnonce=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(script);
    const renderedNonce = match?.[1] ?? match?.[2] ?? match?.[3];
    if (renderedNonce !== nonce) {
      throw new Error(
        `${pathname} rendered a script without the response CSP nonce.`
      );
    }
  }
  return { nonce, scripts: scripts.length };
}

function verifySecurityHeaders(headers, pathname) {
  if (headers.has('x-powered-by')) {
    throw new Error(`${pathname} exposed the framework X-Powered-By header.`);
  }
  requireHeader(headers, pathname, 'x-content-type-options', 'nosniff');
  requireHeader(headers, pathname, 'x-frame-options', 'deny');
  requireHeader(headers, pathname, 'referrer-policy', 'no-referrer');

  const strictTransportSecurity = requireHeader(
    headers,
    pathname,
    'strict-transport-security'
  );
  const maximumAge = /(?:^|;)\s*max-age=(\d+)(?:;|$)/iu.exec(
    strictTransportSecurity
  )?.[1];
  if (!maximumAge || Number(maximumAge) < 31_536_000) {
    throw new Error(`${pathname} did not enforce at least one year of HSTS.`);
  }

  const permissionsPolicy = requireHeader(
    headers,
    pathname,
    'permissions-policy'
  ).toLowerCase();
  for (const directive of [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'browsing-topics=()',
  ]) {
    if (!permissionsPolicy.includes(directive)) {
      throw new Error(
        `${pathname} omitted ${directive} from Permissions-Policy.`
      );
    }
  }

  contentSecurityPolicyNonce(headers.get('content-security-policy'), pathname);
}

function contentSecurityPolicyNonce(policy, pathname) {
  if (!policy) {
    throw new Error(`${pathname} omitted Content-Security-Policy.`);
  }
  if (policy.includes(',')) {
    throw new Error(`${pathname} returned multiple merged CSP policies.`);
  }
  const scriptDirectives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive.startsWith('script-src '));
  if (scriptDirectives.length !== 1) {
    throw new Error(
      `${pathname} must return exactly one script-src CSP directive.`
    );
  }
  const scriptDirective = scriptDirectives[0];
  if (
    !scriptDirective.includes("'self'") ||
    !scriptDirective.includes("'strict-dynamic'") ||
    scriptDirective.includes("'unsafe-inline'") ||
    scriptDirective.includes("'unsafe-eval'")
  ) {
    throw new Error(`${pathname} returned an unsafe script-src policy.`);
  }
  const nonces = [...scriptDirective.matchAll(/'nonce-([^']+)'/gu)];
  if (
    nonces.length !== 1 ||
    !nonces[0]?.[1] ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(nonces[0][1])
  ) {
    throw new Error(`${pathname} must return exactly one CSP script nonce.`);
  }
  return nonces[0][1];
}

function verifyNoStore(headers, pathname) {
  const cacheControl = requireHeader(headers, pathname, 'cache-control');
  if (
    !cacheControl
      .toLowerCase()
      .split(',')
      .some((value) => value.trim() === 'no-store')
  ) {
    throw new Error(`${pathname} must return Cache-Control: no-store.`);
  }
}

function requireHeader(headers, pathname, name, exactValue) {
  const value = headers.get(name);
  if (!value) throw new Error(`${pathname} omitted ${name}.`);
  if (exactValue && value.toLowerCase() !== exactValue) {
    throw new Error(`${pathname} returned an unexpected ${name} value.`);
  }
  return value;
}

async function readBoundedBody(response, maximumBytes, pathname) {
  if (!response.body) throw new Error(`${pathname} returned no response body.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error(`${pathname} exceeded its verification body limit.`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function main() {
  const [origin, unexpected] = process.argv.slice(2);
  if (!origin || unexpected) {
    console.error(
      'Usage: npm run release:verify-deployment -- https://grid.example.com'
    );
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await verifyPublicDeployment({ origin })));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Deployment verification failed.'
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
