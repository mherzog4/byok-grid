import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createContentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from './lib/content-security-policy';
import { enforceApiMutationOrigin } from './lib/request-origin';
import {
  createRequestId,
  INTERNAL_REQUEST_ID_HEADER,
  PUBLIC_REQUEST_ID_HEADER,
} from './lib/request-correlation';

export function proxy(request: NextRequest): Response {
  const requestId = createRequestId();
  const nonce = createContentSecurityPolicyNonce();
  const contentSecurityPolicy = createContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(INTERNAL_REQUEST_ID_HEADER);
  requestHeaders.delete(PUBLIC_REQUEST_ID_HEADER);
  requestHeaders.set(INTERNAL_REQUEST_ID_HEADER, requestId);
  requestHeaders.set('content-security-policy', contentSecurityPolicy);
  requestHeaders.set('x-nonce', nonce);

  if (
    request.nextUrl.pathname === '/api' ||
    request.nextUrl.pathname.startsWith('/api/')
  ) {
    const rejection = enforceApiMutationOrigin(
      request,
      process.env.BYOK_GRID_PUBLIC_URL || request.nextUrl.origin
    );
    if (rejection) {
      rejection.headers.set('content-security-policy', contentSecurityPolicy);
      rejection.headers.set(PUBLIC_REQUEST_ID_HEADER, requestId);
      return rejection;
    }
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('content-security-policy', contentSecurityPolicy);
  response.headers.set(PUBLIC_REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
