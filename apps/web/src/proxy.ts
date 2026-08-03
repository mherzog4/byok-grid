import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { enforceApiMutationOrigin } from './lib/request-origin';

export function proxy(request: NextRequest): Response {
  return (
    enforceApiMutationOrigin(request, process.env.BETTER_AUTH_URL) ??
    NextResponse.next()
  );
}

export const config = {
  matcher: '/api/:path*',
};
