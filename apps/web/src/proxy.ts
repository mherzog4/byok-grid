import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createContentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from './lib/content-security-policy';
import { enforceApiMutationOrigin } from './lib/request-origin';

export function proxy(request: NextRequest): Response {
  const nonce = createContentSecurityPolicyNonce();
  const contentSecurityPolicy = createContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', contentSecurityPolicy);
  requestHeaders.set('x-nonce', nonce);

  if (
    request.nextUrl.pathname === '/api' ||
    request.nextUrl.pathname.startsWith('/api/')
  ) {
    const rejection = enforceApiMutationOrigin(
      request,
      process.env.BETTER_AUTH_URL
    );
    if (rejection) {
      rejection.headers.set('content-security-policy', contentSecurityPolicy);
      return rejection;
    }
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('content-security-policy', contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
