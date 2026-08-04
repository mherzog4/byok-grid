import { auth } from '@/lib/auth';
import { authenticationResponseDelayMs } from '@/lib/auth-response-timing';
import {
  cloneRequestWithBoundedBody,
  MAXIMUM_AUTH_REQUEST_BODY_BYTES,
} from '@/lib/request-body';
import { markApplicationRateLimitResponse } from '@/lib/rate-limit-response';
import { toNextJsHandler } from 'better-auth/next-js';
import { setTimeout as delay } from 'node:timers/promises';

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request): Promise<Response> {
  const startedAt = performance.now();
  const boundedRequest = await cloneRequestWithBoundedBody(
    request,
    MAXIMUM_AUTH_REQUEST_BODY_BYTES
  );
  const response =
    boundedRequest instanceof Response
      ? boundedRequest
      : await handlers.POST(boundedRequest);
  const remainingDelay = authenticationResponseDelayMs(
    new URL(request.url).pathname,
    performance.now() - startedAt
  );
  if (remainingDelay > 0) await delay(remainingDelay);
  return markApplicationRateLimitResponse(response);
}
