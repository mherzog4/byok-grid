const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects browser-originated, unsafe API requests unless their Origin or
 * Referer matches the configured public origin. Headless capability clients
 * remain supported when they send neither cookies nor browser metadata.
 */
export function enforceApiMutationOrigin(
  request: Request,
  configuredPublicUrl: string | undefined
): Response | null {
  if (SAFE_HTTP_METHODS.has(request.method.toUpperCase())) return null;

  const publicOrigin = parseConfiguredPublicOrigin(configuredPublicUrl);
  if (!publicOrigin) {
    return apiBoundaryResponse(
      503,
      'The web runtime configuration is invalid.'
    );
  }

  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    return crossOriginResponse();
  }

  const origin = request.headers.get('origin');
  if (origin !== null) {
    return parseHeaderOrigin(origin, false) === publicOrigin
      ? null
      : crossOriginResponse();
  }

  const referer = request.headers.get('referer');
  if (referer !== null) {
    return parseHeaderOrigin(referer, true) === publicOrigin
      ? null
      : crossOriginResponse();
  }

  if (request.headers.has('cookie')) return crossOriginResponse();
  return null;
}

function parseConfiguredPublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseHeaderOrigin(value: string, allowPath: boolean): string | null {
  if (!value || value.toLowerCase() === 'null') return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (!allowPath && parsed.pathname !== '/')
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function crossOriginResponse(): Response {
  return apiBoundaryResponse(
    403,
    'Cross-origin API mutations are not allowed.'
  );
}

function apiBoundaryResponse(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      headers: { 'cache-control': 'no-store' },
      status,
    }
  );
}
