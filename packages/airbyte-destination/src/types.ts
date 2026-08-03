export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface AirbyteRecordMessage {
  data: JsonObject;
  emitted_at?: number;
  namespace?: string;
  stream: string;
}

export interface AirbyteMessage {
  record?: AirbyteRecordMessage;
  type: string;
}

export interface ConfiguredAirbyteCatalog {
  streams: Array<{
    destination_sync_mode?: string;
    stream: { name: string; namespace?: string };
  }>;
}

export interface DestinationRoute {
  bearerToken: string;
  endpointUrl: string;
  namespace: string | null;
  stream: string;
}

export interface DestinationConfig {
  allowInsecureHttp: boolean;
  applicationTimeoutSeconds: number;
  batchMaximumBytes: number;
  batchMaximumRecords: number;
  routes: DestinationRoute[];
}

export interface DestinationRuntime {
  emit(line: string): void;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  randomId(): string;
  sleep(milliseconds: number): Promise<void>;
}
