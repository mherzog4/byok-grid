import { createHash } from 'node:crypto';
import {
  checkEndpoint,
  submitBatch,
  type EndpointCapability,
} from './client.js';
import { routeKey } from './config.js';
import type {
  AirbyteMessage,
  AirbyteRecordMessage,
  ConfiguredAirbyteCatalog,
  DestinationConfig,
  DestinationRoute,
  DestinationRuntime,
  JsonObject,
  JsonValue,
} from './types.js';

const maximumProtocolLineBytes = 8 * 1_048_576;
const maximumFields = 100;
const encoder = new TextEncoder();
const emptyEnvelopeBytes = encoder.encode('{"records":[]}').byteLength;

export class AirbyteDestinationProtocolError extends Error {}

interface PendingBatch {
  byteCount: number;
  records: string[];
}

export async function checkAllEndpoints(
  config: DestinationConfig,
  runtime: DestinationRuntime
): Promise<Map<string, EndpointCapability>> {
  const capabilities = new Map<string, EndpointCapability>();
  for (const route of config.routes) {
    const capability = await checkEndpoint(route, runtime);
    if (
      config.batchMaximumRecords > capability.maximumRecords ||
      config.batchMaximumBytes > capability.maximumBodyBytes
    ) {
      throw new AirbyteDestinationProtocolError(
        `Configured batch limits exceed the server capability for stream “${displayRoute(route)}”.`
      );
    }
    capabilities.set(routeKey(route.namespace, route.stream), capability);
  }
  return capabilities;
}

export class AirbyteDestinationWriter {
  readonly #batchByRoute = new Map<string, PendingBatch>();
  readonly #capabilityByRoute: ReadonlyMap<string, EndpointCapability>;
  readonly #catalogKeys: ReadonlySet<string>;
  readonly #config: DestinationConfig;
  readonly #routeByKey: ReadonlyMap<string, DestinationRoute>;
  readonly #runtime: DestinationRuntime;
  readonly #syncId: string;
  #batchSequence = 0;

  constructor(input: {
    capabilities: ReadonlyMap<string, EndpointCapability>;
    catalog: ConfiguredAirbyteCatalog;
    config: DestinationConfig;
    runtime: DestinationRuntime;
  }) {
    this.#capabilityByRoute = input.capabilities;
    this.#catalogKeys = new Set(
      input.catalog.streams.map(({ stream }) =>
        routeKey(stream.namespace ?? null, stream.name)
      )
    );
    this.#config = input.config;
    this.#routeByKey = new Map(
      input.config.routes.map((route) => [
        routeKey(route.namespace, route.stream),
        route,
      ])
    );
    this.#runtime = input.runtime;
    this.#syncId = input.runtime.randomId();
  }

  async acceptLine(line: string): Promise<void> {
    if (line.trim() === '') return;
    if (encoder.encode(line).byteLength > maximumProtocolLineBytes) {
      throw new AirbyteDestinationProtocolError(
        'An Airbyte protocol message exceeds 8 MiB.'
      );
    }
    let message: AirbyteMessage & JsonObject;
    try {
      message = JSON.parse(line) as AirbyteMessage & JsonObject;
    } catch {
      throw new AirbyteDestinationProtocolError(
        'Airbyte write input contains invalid JSON.'
      );
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new AirbyteDestinationProtocolError(
        'Airbyte write input must contain JSON objects.'
      );
    }
    if (message.type === 'RECORD') {
      await this.#acceptRecord(parseRecordMessage(message.record));
      return;
    }
    if (message.type === 'STATE') {
      if (!Object.prototype.hasOwnProperty.call(message, 'state')) {
        throw new AirbyteDestinationProtocolError(
          'An Airbyte STATE message is missing its state payload.'
        );
      }
      await this.flushAll();
      this.#runtime.emit(line);
      return;
    }
    if (['CONTROL', 'LOG', 'TRACE'].includes(message.type)) return;
    throw new AirbyteDestinationProtocolError(
      `Unsupported Airbyte message type “${String(message.type).slice(0, 40)}”.`
    );
  }

  async finish(): Promise<void> {
    await this.flushAll();
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.#batchByRoute.keys()].sort()) {
      await this.#flush(key);
    }
  }

  async #acceptRecord(record: AirbyteRecordMessage): Promise<void> {
    const key = routeKey(record.namespace ?? null, record.stream);
    if (!this.#catalogKeys.has(key)) {
      throw new AirbyteDestinationProtocolError(
        `Received a record for stream “${displayStream(record)}” outside the configured catalog.`
      );
    }
    const route = this.#routeByKey.get(key);
    const capability = this.#capabilityByRoute.get(key);
    if (!route || !capability) {
      throw new AirbyteDestinationProtocolError(
        `No verified BYOK Grid endpoint exists for stream “${displayStream(record)}”.`
      );
    }
    const normalized = normalizeRecord(record.data, capability.recordKeyField);
    const serialized = stableStringify(normalized);
    const recordBytes = encoder.encode(serialized).byteLength;
    if (emptyEnvelopeBytes + recordBytes > this.#config.batchMaximumBytes) {
      throw new AirbyteDestinationProtocolError(
        `A normalized record from stream “${displayStream(record)}” exceeds the configured batch byte limit.`
      );
    }
    let pending = this.#batchByRoute.get(key) ?? {
      byteCount: emptyEnvelopeBytes,
      records: [],
    };
    const nextByteCount =
      pending.byteCount + recordBytes + (pending.records.length === 0 ? 0 : 1);
    if (
      pending.records.length >= this.#config.batchMaximumRecords ||
      nextByteCount > this.#config.batchMaximumBytes
    ) {
      await this.#flush(key);
      pending = { byteCount: emptyEnvelopeBytes, records: [] };
    }
    pending.records.push(serialized);
    pending.byteCount += recordBytes + (pending.records.length === 1 ? 0 : 1);
    this.#batchByRoute.set(key, pending);
  }

  async #flush(key: string): Promise<void> {
    const pending = this.#batchByRoute.get(key);
    if (!pending || pending.records.length === 0) return;
    const route = this.#routeByKey.get(key)!;
    const body = `{"records":[${pending.records.join(',')}]}`;
    const actualBytes = encoder.encode(body).byteLength;
    if (actualBytes !== pending.byteCount) {
      throw new Error('The Airbyte batch byte checkpoint is inconsistent.');
    }
    this.#batchSequence += 1;
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 20);
    const idempotencyKey = `airbyte:${this.#syncId}:${this.#batchSequence}:${digest}`;
    await submitBatch(route, this.#runtime, {
      body,
      idempotencyKey,
      timeoutSeconds: this.#config.applicationTimeoutSeconds,
    });
    this.#batchByRoute.delete(key);
  }
}

export function normalizeRecord(
  data: JsonObject,
  recordKeyField: string
): JsonObject {
  const entries = Object.entries(data);
  if (entries.length === 0 || entries.length > maximumFields) {
    throw new AirbyteDestinationProtocolError(
      'Airbyte records must contain between 1 and 100 fields.'
    );
  }
  const normalized = Object.create(null) as JsonObject;
  for (const [field, value] of entries) {
    if (!field || field.length > 120 || /\p{Cc}/u.test(field)) {
      throw new AirbyteDestinationProtocolError(
        'An Airbyte record contains an invalid field name.'
      );
    }
    assertSafeNumbers(value, field);
    normalized[field] =
      value !== null && typeof value === 'object'
        ? stableStringify(value)
        : value;
  }
  const key = normalized[recordKeyField];
  if (
    key === null ||
    key === undefined ||
    (typeof key !== 'string' &&
      typeof key !== 'number' &&
      typeof key !== 'boolean') ||
    String(key).trim() === ''
  ) {
    throw new AirbyteDestinationProtocolError(
      `An Airbyte record has no usable “${recordKeyField}” key.`
    );
  }
  return normalized;
}

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as JsonObject)[key]!)}`
    )
    .join(',')}}`;
}

function parseRecordMessage(value: unknown): AirbyteRecordMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AirbyteDestinationProtocolError(
      'An Airbyte RECORD message is missing its record payload.'
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.stream !== 'string' ||
    record.stream.length === 0 ||
    record.stream.length > 256 ||
    (record.namespace !== undefined && typeof record.namespace !== 'string') ||
    !record.data ||
    typeof record.data !== 'object' ||
    Array.isArray(record.data)
  ) {
    throw new AirbyteDestinationProtocolError(
      'An Airbyte RECORD message has an invalid stream or data object.'
    );
  }
  return {
    data: record.data as JsonObject,
    ...(typeof record.emitted_at === 'number'
      ? { emitted_at: record.emitted_at }
      : {}),
    ...(typeof record.namespace === 'string'
      ? { namespace: record.namespace }
      : {}),
    stream: record.stream,
  };
}

function assertSafeNumbers(value: JsonValue, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AirbyteDestinationProtocolError(
        `Airbyte field “${path}” contains a non-finite number.`
      );
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new AirbyteDestinationProtocolError(
        `Airbyte field “${path}” contains an unsafe integer; emit it as a string to preserve precision.`
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeNumbers(item, `${path}[${index}]`)
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assertSafeNumbers(nested, `${path}.${key}`);
  }
}

function displayStream(
  record: Pick<AirbyteRecordMessage, 'namespace' | 'stream'>
) {
  return record.namespace
    ? `${record.namespace}.${record.stream}`
    : record.stream;
}

function displayRoute(route: DestinationRoute): string {
  return route.namespace ? `${route.namespace}.${route.stream}` : route.stream;
}
