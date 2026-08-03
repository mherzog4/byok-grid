import type {
  ConfiguredAirbyteCatalog,
  DestinationConfig,
  DestinationRoute,
  JsonObject,
} from './types.js';

const maximumRoutes = 50;

export class AirbyteDestinationConfigurationError extends Error {}

export function parseDestinationConfig(value: unknown): DestinationConfig {
  const object = requireObject(value, 'Destination configuration');
  rejectUnknownKeys(object, [
    'allow_insecure_http',
    'application_timeout_seconds',
    'batch_maximum_bytes',
    'batch_maximum_records',
    'routes',
  ]);
  if (!Array.isArray(object.routes) || object.routes.length === 0) {
    throw new AirbyteDestinationConfigurationError(
      'Destination configuration requires at least one stream route.'
    );
  }
  if (object.routes.length > maximumRoutes) {
    throw new AirbyteDestinationConfigurationError(
      `A destination cannot configure more than ${maximumRoutes} routes.`
    );
  }
  const allowInsecureHttp = optionalBoolean(
    object.allow_insecure_http,
    false,
    'allow_insecure_http'
  );
  const routes = object.routes.map((route, index) =>
    parseRoute(route, index, allowInsecureHttp)
  );
  const routeKeys = new Set<string>();
  const endpointUrls = new Set<string>();
  for (const route of routes) {
    const key = routeKey(route.namespace, route.stream);
    if (routeKeys.has(key)) {
      throw new AirbyteDestinationConfigurationError(
        `The ${displayRoute(route.namespace, route.stream)} route appears more than once.`
      );
    }
    if (endpointUrls.has(route.endpointUrl)) {
      throw new AirbyteDestinationConfigurationError(
        'Each Airbyte stream must use a separate BYOK Grid ingestion endpoint.'
      );
    }
    routeKeys.add(key);
    endpointUrls.add(route.endpointUrl);
  }
  return {
    allowInsecureHttp,
    applicationTimeoutSeconds: boundedInteger(
      object.application_timeout_seconds,
      600,
      30,
      1_800,
      'application_timeout_seconds'
    ),
    batchMaximumBytes: boundedInteger(
      object.batch_maximum_bytes,
      4_194_304,
      65_536,
      4_718_592,
      'batch_maximum_bytes'
    ),
    batchMaximumRecords: boundedInteger(
      object.batch_maximum_records,
      500,
      1,
      1_000,
      'batch_maximum_records'
    ),
    routes,
  };
}

export function parseConfiguredCatalog(
  value: unknown,
  config: DestinationConfig
): ConfiguredAirbyteCatalog {
  const object = requireObject(value, 'Configured catalog');
  if (!Array.isArray(object.streams) || object.streams.length === 0) {
    throw new AirbyteDestinationConfigurationError(
      'The configured catalog must contain at least one stream.'
    );
  }
  const catalog: ConfiguredAirbyteCatalog = { streams: [] };
  const catalogKeys = new Set<string>();
  for (const [index, value] of object.streams.entries()) {
    const configured = requireObject(value, `Catalog stream ${index + 1}`);
    const stream = requireObject(
      configured.stream,
      `Catalog stream ${index + 1} definition`
    );
    const name = boundedText(stream.name, 'Catalog stream name');
    const namespace = optionalText(
      stream.namespace,
      'Catalog stream namespace'
    );
    const destinationSyncMode =
      typeof configured.destination_sync_mode === 'string'
        ? configured.destination_sync_mode.toLowerCase()
        : undefined;
    if (!destinationSyncMode) {
      throw new AirbyteDestinationConfigurationError(
        `The configured catalog must select append or append_dedup for ${displayRoute(namespace, name)}.`
      );
    }
    if (!['append', 'append_dedup'].includes(destinationSyncMode)) {
      throw new AirbyteDestinationConfigurationError(
        `BYOK Grid does not support destination sync mode “${destinationSyncMode}”; use append or append_dedup.`
      );
    }
    const key = routeKey(namespace, name);
    if (catalogKeys.has(key)) {
      throw new AirbyteDestinationConfigurationError(
        `The configured catalog repeats ${displayRoute(namespace, name)}.`
      );
    }
    if (
      !config.routes.some(
        (route) => routeKey(route.namespace, route.stream) === key
      )
    ) {
      throw new AirbyteDestinationConfigurationError(
        `No BYOK Grid endpoint is configured for ${displayRoute(namespace, name)}.`
      );
    }
    catalogKeys.add(key);
    catalog.streams.push({
      destination_sync_mode: destinationSyncMode,
      stream: { name, ...(namespace === null ? {} : { namespace }) },
    });
  }
  return catalog;
}

export function routeKey(namespace: string | null, stream: string): string {
  return `${namespace ?? ''}\u0000${stream}`;
}

function parseRoute(
  value: unknown,
  index: number,
  allowInsecureHttp: boolean
): DestinationRoute {
  const route = requireObject(value, `Route ${index + 1}`);
  rejectUnknownKeys(route, [
    'bearer_token',
    'endpoint_url',
    'namespace',
    'stream',
  ]);
  const stream = boundedText(route.stream, `Route ${index + 1} stream`);
  const namespace = optionalText(
    route.namespace,
    `Route ${index + 1} namespace`
  );
  const bearerToken = boundedText(
    route.bearer_token,
    `Route ${index + 1} bearer token`,
    80
  );
  if (!/^bg_ingest_[A-Za-z0-9_-]{43}$/.test(bearerToken)) {
    throw new AirbyteDestinationConfigurationError(
      `Route ${index + 1} has an invalid BYOK Grid ingestion token.`
    );
  }
  const endpointUrl = validateEndpointUrl(
    boundedText(route.endpoint_url, `Route ${index + 1} endpoint URL`, 2_048),
    allowInsecureHttp
  );
  return { bearerToken, endpointUrl, namespace, stream };
}

function validateEndpointUrl(
  value: string,
  allowInsecureHttp: boolean
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AirbyteDestinationConfigurationError(
      'Every route endpoint must be an absolute URL.'
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AirbyteDestinationConfigurationError(
      'Ingestion endpoint URLs cannot contain credentials, queries, or fragments.'
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(allowInsecureHttp && url.protocol === 'http:')
  ) {
    throw new AirbyteDestinationConfigurationError(
      'Ingestion endpoints require HTTPS unless allow_insecure_http is explicitly enabled.'
    );
  }
  if (!/\/api\/ingest\/[0-9a-f-]{36}\/?$/i.test(url.pathname)) {
    throw new AirbyteDestinationConfigurationError(
      'The endpoint URL must end with /api/ingest/<endpoint UUID>.'
    );
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AirbyteDestinationConfigurationError(
      `${name} must be an object.`
    );
  }
  return value as JsonObject;
}

function rejectUnknownKeys(
  object: JsonObject,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new AirbyteDestinationConfigurationError(
      `Destination configuration contains unsupported field “${unknown}”.`
    );
  }
}

function boundedText(value: unknown, name: string, maximum = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AirbyteDestinationConfigurationError(`${name} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | null {
  return value === undefined || value === null
    ? null
    : boundedText(value, name);
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new AirbyteDestinationConfigurationError(
      `${name} must be a boolean.`
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new AirbyteDestinationConfigurationError(
      `${name} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return value as number;
}

function displayRoute(namespace: string | null, stream: string): string {
  return namespace ? `stream “${namespace}.${stream}”` : `stream “${stream}”`;
}
