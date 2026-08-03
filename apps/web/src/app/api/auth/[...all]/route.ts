import { auth } from '@/lib/auth';
import {
  cloneRequestWithBoundedBody,
  MAXIMUM_AUTH_REQUEST_BODY_BYTES,
} from '@/lib/request-body';
import { toNextJsHandler } from 'better-auth/next-js';

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request): Promise<Response> {
  const boundedRequest = await cloneRequestWithBoundedBody(
    request,
    MAXIMUM_AUTH_REQUEST_BODY_BYTES
  );
  if (boundedRequest instanceof Response) return boundedRequest;
  return handlers.POST(boundedRequest);
}
