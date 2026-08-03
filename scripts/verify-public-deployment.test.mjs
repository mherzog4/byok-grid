import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  parseProductionOrigin,
  verifyPublicDeployment,
} from './verify-public-deployment.mjs';

const requestIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

test('accepts only a canonical HTTPS deployment origin', () => {
  assert.equal(
    parseProductionOrigin('https://grid.example.test'),
    'https://grid.example.test'
  );
  for (const origin of [
    'http://grid.example.test',
    'https://user:secret@grid.example.test',
    'https://grid.example.test/app',
    'https://grid.example.test?debug=true',
    'https://grid.example.test#fragment',
    'not a URL',
  ]) {
    assert.throws(() => parseProductionOrigin(origin));
  }
});

test('verifies public health, security headers, correlation, and CSP nonces', async () => {
  let requestIndex = 0;
  let pageIndex = 0;
  const fetchImplementation = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['cache-control'], 'no-cache');
    const requestId = requestIds[requestIndex++];

    if (url.pathname === '/api/live') {
      return jsonResponse({ status: 'ok' }, requestId);
    }
    if (url.pathname === '/api/health') {
      return jsonResponse(
        { configuration: 'valid', database: 'sqlite', status: 'ok' },
        requestId
      );
    }
    if (url.pathname === '/sign-in') {
      pageIndex += 1;
      return htmlResponse(encodedNonce(`nonce-${pageIndex}`), requestId);
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  const result = await verifyPublicDeployment({
    fetchImplementation,
    now: () => new Date('2026-08-03T21:45:00.000Z'),
    origin: 'https://grid.example.test',
  });

  assert.deepEqual(result, {
    checks: {
      cspNonceUnique: true,
      health: 'ok',
      live: 'ok',
      requestIdsUnique: true,
      securityHeaders: true,
    },
    marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
    origin: 'https://grid.example.test',
    requests: 4,
    verifiedAt: '2026-08-03T21:45:00.000Z',
  });
});

test('fails closed on degraded readiness', async () => {
  const fetchImplementation = createFetchFixture({
    health: new Response(
      JSON.stringify({
        configuration: 'invalid_or_unready',
        database: 'sqlite_unready',
        status: 'degraded',
      }),
      {
        headers: responseHeaders('application/json', requestIds[1]),
        status: 503,
      }
    ),
  });
  await assert.rejects(
    verifyPublicDeployment({
      fetchImplementation,
      origin: 'https://grid.example.test',
    }),
    /\/api\/health returned HTTP 503/u
  );
});

test('rejects an unsafe script policy', async () => {
  const unsafeHeaders = responseHeaders('text/html', requestIds[2]);
  unsafeHeaders.set(
    'content-security-policy',
    securityPolicy(encodedNonce('safe-nonce')).replace(
      "'strict-dynamic'",
      "'strict-dynamic' 'unsafe-eval'"
    )
  );
  const fetchImplementation = createFetchFixture({
    firstPage: new Response(
      '<html><script nonce="different-nonce"></script></html>',
      { headers: unsafeHeaders }
    ),
  });
  await assert.rejects(
    verifyPublicDeployment({
      fetchImplementation,
      origin: 'https://grid.example.test',
    }),
    /unsafe script-src policy/u
  );
});

test('rejects a rendered script nonce that does not match its response', async () => {
  const headers = responseHeaders('text/html', requestIds[2]);
  headers.set(
    'content-security-policy',
    securityPolicy(encodedNonce('declared-nonce'))
  );
  const fetchImplementation = createFetchFixture({
    firstPage: new Response(
      '<html><script nonce="different-nonce"></script></html>',
      { headers }
    ),
  });
  await assert.rejects(
    verifyPublicDeployment({
      fetchImplementation,
      origin: 'https://grid.example.test',
    }),
    /rendered a script without the response CSP nonce/u
  );
});

test('rejects reused request correlation IDs', async () => {
  const fetchImplementation = createFetchFixture({
    secondPage: htmlResponse(encodedNonce('nonce-2'), requestIds[2]),
  });
  await assert.rejects(
    verifyPublicDeployment({
      fetchImplementation,
      origin: 'https://grid.example.test',
    }),
    /reused an X-Request-ID/u
  );
});

test('the command rejects a non-TLS deployment before making requests', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'verify-public-deployment.mjs'),
      'http://grid.example.test',
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/u);
  assert.doesNotMatch(result.stdout, /BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED/u);
});

function createFetchFixture(overrides = {}) {
  let requestIndex = 0;
  let pageIndex = 0;
  return async (input) => {
    const pathname = new URL(input).pathname;
    const requestId = requestIds[requestIndex++];
    if (pathname === '/api/live') {
      return overrides.live ?? jsonResponse({ status: 'ok' }, requestId);
    }
    if (pathname === '/api/health') {
      return (
        overrides.health ??
        jsonResponse(
          { configuration: 'valid', database: 'sqlite', status: 'ok' },
          requestId
        )
      );
    }
    if (pathname === '/sign-in') {
      pageIndex += 1;
      if (pageIndex === 1 && overrides.firstPage) return overrides.firstPage;
      if (pageIndex === 2 && overrides.secondPage) return overrides.secondPage;
      return htmlResponse(encodedNonce(`nonce-${pageIndex}`), requestId);
    }
    throw new Error(`Unexpected request path: ${pathname}`);
  };
}

function jsonResponse(body, requestId) {
  return new Response(JSON.stringify(body), {
    headers: responseHeaders('application/json', requestId),
  });
}

function htmlResponse(nonce, requestId) {
  const headers = responseHeaders('text/html; charset=utf-8', requestId);
  headers.set('content-security-policy', securityPolicy(nonce));
  return new Response(
    `<html><body><script nonce="${nonce}"></script><script nonce='${nonce}'></script></body></html>`,
    { headers }
  );
}

function responseHeaders(contentType, requestId) {
  return new Headers({
    'cache-control': 'private, no-store, max-age=0',
    'content-security-policy': securityPolicy(encodedNonce(`api-${requestId}`)),
    'content-type': contentType,
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-request-id': requestId,
  });
}

function securityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function encodedNonce(value) {
  return Buffer.from(value).toString('base64');
}
