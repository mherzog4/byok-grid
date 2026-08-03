import { z } from 'zod';

export const CONNECTOR_PROTOCOL_VERSION = '1.1' as const;
export const CONNECTOR_SANDBOX_PROTOCOL_VERSION = '1.0' as const;

const identifierPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type ConnectorErrorCode =
  | 'authentication'
  | 'invalid_input'
  | 'policy'
  | 'rate_limited'
  | 'response_too_large'
  | 'transient'
  | 'upstream';

export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConnectorError';
  }
}

export type ConnectorExecutionContext = Readonly<{
  abortSignal: AbortSignal;
  allowedHosts: ReadonlySet<string>;
  fetch: typeof globalThis.fetch;
  idempotencyKey: string;
  maxResponseBytes: number;
}>;

export type ConnectorHostPolicy =
  | Readonly<{ hosts: readonly string[]; kind: 'fixed' }>
  | Readonly<{ kind: 'runtime' }>;

export type ConnectorJsonValue =
  | boolean
  | null
  | number
  | string
  | ConnectorJsonValue[]
  | { [key: string]: ConnectorJsonValue };

const connectorJsonSchema: z.ZodType<ConnectorJsonValue> = z.json();

const sandboxIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const sandboxHttpResponseSchema = z.strictObject({
  bodyBase64: z.string().max(1_500_000),
  headers: z.record(z.string(), z.string().max(8_192)),
  status: z.number().int().min(100).max(599),
});

export const sandboxConnectorInvocationSchema = z.strictObject({
  actionId: sandboxIdentifierSchema,
  connectorId: sandboxIdentifierSchema,
  connectorVersion: z.string().regex(semanticVersionPattern),
  continuation: z
    .strictObject({
      response: sandboxHttpResponseSchema,
      state: connectorJsonSchema,
    })
    .nullable(),
  credential: z.record(z.string(), connectorJsonSchema),
  input: connectorJsonSchema,
  protocolVersion: z.literal(CONNECTOR_SANDBOX_PROTOCOL_VERSION),
  runId: z.string().uuid(),
});
export type SandboxConnectorInvocation = z.infer<
  typeof sandboxConnectorInvocationSchema
>;

const sandboxConnectorFailureSchema = z.strictObject({
  code: z.enum([
    'authentication',
    'invalid_input',
    'policy',
    'rate_limited',
    'response_too_large',
    'transient',
    'upstream',
  ]),
  kind: z.literal('failure'),
  message: z.string().min(1).max(2_048),
  retryable: z.boolean(),
});

const sandboxConnectorHttpRequestSchema = z.strictObject({
  bodyBase64: z.string().max(1_500_000).nullable(),
  headers: z.record(z.string(), z.string().max(8_192)),
  method: z.enum(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']),
  url: z.url().startsWith('https://'),
});

export const sandboxConnectorStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('complete'),
    output: connectorJsonSchema,
  }),
  z.strictObject({
    kind: z.literal('http_request'),
    request: sandboxConnectorHttpRequestSchema,
    state: connectorJsonSchema,
  }),
  sandboxConnectorFailureSchema,
]);
export type SandboxConnectorStep = z.infer<typeof sandboxConnectorStepSchema>;

export const sandboxConnectorResultSchema = z.strictObject({
  protocolVersion: z.literal(CONNECTOR_SANDBOX_PROTOCOL_VERSION),
  step: sandboxConnectorStepSchema,
});
export type SandboxConnectorResult = z.infer<
  typeof sandboxConnectorResultSchema
>;

export type ConnectorColumnInputField = Readonly<{
  description: string;
  key: string;
  label: string;
  required: boolean;
  source: 'column';
}>;

export type ConnectorLiteralInputField = Readonly<{
  defaultValue?: ConnectorJsonValue;
  description: string;
  key: string;
  label: string;
  multiline?: boolean;
  options?: readonly Readonly<{
    label: string;
    value: boolean | number | string;
  }>[];
  required: boolean;
  source: 'literal';
  valueType: 'boolean' | 'json' | 'number' | 'text';
}>;

export type ConnectorInputField =
  ConnectorColumnInputField | ConnectorLiteralInputField;

export type ConnectorCellOutput = Readonly<{
  path?: readonly string[];
  valueType: 'boolean' | 'json' | 'number' | 'text';
}>;

export type ConnectorCellValue =
  | Readonly<{ type: 'boolean'; value: boolean }>
  | Readonly<{ type: 'json'; value: ConnectorJsonValue }>
  | Readonly<{ type: 'number'; value: number }>
  | Readonly<{ type: 'text'; value: string }>;

export type ConnectorAction<I, O, C> = Readonly<{
  cellOutput: ConnectorCellOutput;
  description: string;
  execute: (args: {
    context: ConnectorExecutionContext;
    credential: C;
    input: I;
  }) => Promise<O>;
  hostPolicy: ConnectorHostPolicy;
  inputFields: readonly ConnectorInputField[];
  inputSchema: z.ZodType<I>;
  name: string;
  outputSchema: z.ZodType<O>;
}>;

export type ConnectorActionMetadata = Readonly<{
  cellOutput: ConnectorCellOutput;
  description: string;
  hostPolicy: ConnectorHostPolicy;
  inputFields: readonly ConnectorInputField[];
  inputSchema: z.ZodType<any>;
  name: string;
  outputSchema: z.ZodType<any>;
}>;

export type ConnectorCategory =
  'ai' | 'crm' | 'data' | 'email' | 'http' | 'sales';

export type ConnectorDefinition<
  C,
  Actions extends Readonly<Record<string, ConnectorActionMetadata>> = Readonly<
    Record<string, ConnectorActionMetadata>
  >,
> = Readonly<{
  actions: Actions;
  category: ConnectorCategory;
  credentialName: string;
  credentialRequired: boolean;
  credentialSchema: z.ZodType<C>;
  description: string;
  displayName: string;
  documentationUrl: string;
  id: string;
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  version: string;
}>;

export type ConnectorManifest = Readonly<{
  actions: ReadonlyArray<
    Omit<ConnectorActionMetadata, 'inputSchema' | 'outputSchema'> &
      Readonly<{
        id: string;
        inputSchema: Record<string, unknown>;
        outputSchema: Record<string, unknown>;
      }>
  >;
  category: ConnectorCategory;
  credentialName: string;
  credentialRequired: boolean;
  credentialSchema: Record<string, unknown>;
  description: string;
  displayName: string;
  documentationUrl: string;
  id: string;
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  version: string;
}>;

const connectorCellOutputSchema = z.strictObject({
  path: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(16)
    .optional(),
  valueType: z.enum(['boolean', 'json', 'number', 'text']),
});

const connectorHostPolicySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    hosts: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9.-]+$/)
          .refine((host) => !host.includes('..'))
      )
      .min(1)
      .max(32),
    kind: z.literal('fixed'),
  }),
  z.strictObject({ kind: z.literal('runtime') }),
]);

const connectorInputFieldSchema = z.discriminatedUnion('source', [
  z.strictObject({
    description: z.string().min(1).max(512),
    key: sandboxIdentifierSchema,
    label: z.string().min(1).max(120),
    required: z.boolean(),
    source: z.literal('column'),
  }),
  z.strictObject({
    defaultValue: connectorJsonSchema.optional(),
    description: z.string().min(1).max(512),
    key: sandboxIdentifierSchema,
    label: z.string().min(1).max(120),
    multiline: z.boolean().optional(),
    options: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(120),
          value: z.union([z.boolean(), z.number().finite(), z.string()]),
        })
      )
      .max(64)
      .optional(),
    required: z.boolean(),
    source: z.literal('literal'),
    valueType: z.enum(['boolean', 'json', 'number', 'text']),
  }),
]);

const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const connectorManifestSchema = z.strictObject({
  actions: z
    .array(
      z.strictObject({
        cellOutput: connectorCellOutputSchema,
        description: z.string().min(1).max(2_048),
        hostPolicy: connectorHostPolicySchema,
        id: sandboxIdentifierSchema,
        inputFields: z.array(connectorInputFieldSchema).min(1).max(32),
        inputSchema: jsonSchemaObjectSchema,
        name: z.string().min(1).max(120),
        outputSchema: jsonSchemaObjectSchema,
      })
    )
    .min(1)
    .max(64),
  category: z.enum(['ai', 'crm', 'data', 'email', 'http', 'sales']),
  credentialName: z.string().min(1).max(120),
  credentialRequired: z.boolean(),
  credentialSchema: jsonSchemaObjectSchema,
  description: z.string().min(1).max(2_048),
  displayName: z.string().min(1).max(120),
  documentationUrl: z.url().startsWith('https://'),
  id: sandboxIdentifierSchema,
  protocolVersion: z.literal(CONNECTOR_PROTOCOL_VERSION),
  version: z.string().regex(semanticVersionPattern),
});

export function defineConnector<
  C,
  Actions extends Readonly<Record<string, ConnectorActionMetadata>>,
>(
  definition: ConnectorDefinition<C, Actions>
): ConnectorDefinition<C, Actions> {
  assertIdentifier(definition.id, 'connector');
  if (!semanticVersionPattern.test(definition.version)) {
    throw new TypeError(
      `Connector ${definition.id} must use a semantic version.`
    );
  }
  if (!definition.documentationUrl.startsWith('https://')) {
    throw new TypeError(
      `Connector ${definition.id} must use an HTTPS documentation URL.`
    );
  }
  const actionEntries = Object.entries(definition.actions);
  if (actionEntries.length === 0) {
    throw new TypeError(`Connector ${definition.id} must declare an action.`);
  }
  for (const [actionId, action] of actionEntries) {
    assertIdentifier(actionId, 'action');
    const fieldKeys = new Set<string>();
    for (const field of action.inputFields) {
      assertIdentifier(field.key, 'input field');
      if (fieldKeys.has(field.key)) {
        throw new TypeError(
          `Action ${definition.id}.${actionId} repeats input field ${field.key}.`
        );
      }
      fieldKeys.add(field.key);
      if (field.source === 'literal') {
        if (field.defaultValue !== undefined) {
          assertLiteralValue(
            field.defaultValue,
            field.valueType,
            `${definition.id}.${actionId}.${field.key} default`
          );
        }
        for (const option of field.options ?? []) {
          assertLiteralValue(
            option.value,
            field.valueType,
            `${definition.id}.${actionId}.${field.key} option`
          );
        }
      }
    }
    for (const segment of action.cellOutput.path ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
        throw new TypeError(
          `Action ${definition.id}.${actionId} has an invalid cell output path.`
        );
      }
    }
    if (action.hostPolicy.kind === 'fixed') {
      if (action.hostPolicy.hosts.length === 0) {
        throw new TypeError(
          `Action ${definition.id}.${actionId} needs at least one fixed host.`
        );
      }
      for (const host of action.hostPolicy.hosts) assertHost(host);
    }
  }
  return definition;
}

export function createConnectorManifest<
  C,
  Actions extends Readonly<Record<string, ConnectorActionMetadata>>,
>(definition: ConnectorDefinition<C, Actions>): ConnectorManifest {
  return toPlainJsonValue({
    actions: Object.entries(definition.actions).map(([id, action]) => ({
      cellOutput: action.cellOutput,
      description: action.description,
      hostPolicy: action.hostPolicy,
      id,
      inputFields: action.inputFields,
      inputSchema: z.toJSONSchema(action.inputSchema, {
        target: 'draft-2020-12',
      }),
      name: action.name,
      outputSchema: z.toJSONSchema(action.outputSchema, {
        target: 'draft-2020-12',
      }),
    })),
    category: definition.category,
    credentialName: definition.credentialName,
    credentialRequired: definition.credentialRequired,
    credentialSchema: z.toJSONSchema(definition.credentialSchema, {
      target: 'draft-2020-12',
    }),
    description: definition.description,
    displayName: definition.displayName,
    documentationUrl: definition.documentationUrl,
    id: definition.id,
    protocolVersion: definition.protocolVersion,
    version: definition.version,
  }) as ConnectorManifest;
}

function toPlainJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export async function executeAction<I, O, C>(args: {
  action: ConnectorAction<I, O, C>;
  context: ConnectorExecutionContext;
  credential: unknown;
  credentialSchema: z.ZodType<C>;
  input: unknown;
}): Promise<O> {
  const parsedInput = args.action.inputSchema.safeParse(args.input);
  if (!parsedInput.success) {
    throw new ConnectorError(
      'invalid_input',
      'The connector input does not match the action schema.',
      false,
      { cause: parsedInput.error }
    );
  }
  const parsedCredential = args.credentialSchema.safeParse(args.credential);
  if (!parsedCredential.success) {
    throw new ConnectorError(
      'authentication',
      'The stored connector credential is invalid.',
      false,
      { cause: parsedCredential.error }
    );
  }
  const output = await args.action.execute({
    context: args.context,
    credential: parsedCredential.data,
    input: parsedInput.data,
  });
  const parsedOutput = args.action.outputSchema.safeParse(output);
  if (!parsedOutput.success) {
    throw new ConnectorError(
      'upstream',
      'The connector returned an invalid output.',
      false,
      { cause: parsedOutput.error }
    );
  }
  return parsedOutput.data;
}

export function extractConnectorCellValue(
  output: unknown,
  policy: ConnectorCellOutput
): ConnectorCellValue {
  let value = output;
  for (const segment of policy.path ?? []) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      throw new ConnectorError(
        'upstream',
        'The connector output does not contain its configured cell value.',
        false
      );
    }
    value = (value as Record<string, unknown>)[segment];
  }

  if (policy.valueType === 'text' && typeof value === 'string') {
    return { type: 'text', value };
  }
  if (
    policy.valueType === 'number' &&
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return { type: 'number', value };
  }
  if (policy.valueType === 'boolean' && typeof value === 'boolean') {
    return { type: 'boolean', value };
  }
  const json = z.json().safeParse(value);
  if (policy.valueType === 'json' && json.success) {
    return { type: 'json', value: json.data };
  }
  throw new ConnectorError(
    'upstream',
    'The connector output cell value has the wrong type.',
    false
  );
}

function assertIdentifier(value: string, kind: string): void {
  if (!identifierPattern.test(value)) {
    throw new TypeError(`Invalid ${kind} identifier: ${value}.`);
  }
}

function assertHost(host: string): void {
  if (
    host !== host.toLowerCase() ||
    host.includes('/') ||
    host.includes(':') ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    throw new TypeError(`Invalid connector host: ${host}.`);
  }
}

function assertLiteralValue(
  value: ConnectorJsonValue,
  valueType: ConnectorLiteralInputField['valueType'],
  label: string
): void {
  const valid =
    valueType === 'json'
      ? z.json().safeParse(value).success
      : valueType === 'text'
        ? typeof value === 'string'
        : valueType === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean';
  if (!valid) {
    throw new TypeError(`${label} does not match ${valueType}.`);
  }
}
