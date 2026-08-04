export const RATE_LIMIT_LAYER_HEADER = 'x-byok-grid-rate-limit-layer';

export function markApplicationRateLimitResponse(response: Response): Response {
  if (response.status !== 429) return response;

  const headers = new Headers(response.headers);
  headers.set(RATE_LIMIT_LAYER_HEADER, 'application');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
