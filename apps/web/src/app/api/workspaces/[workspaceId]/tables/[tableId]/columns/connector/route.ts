import {
  getConnectorManifest,
  getSandboxConnector,
  loadSandboxConnectorRegistry,
  type ConnectorInputField,
} from '@byok-grid/connectors';
import { createSqliteConnectorActionColumn } from '@byok-grid/db';
import {
  connectorActionInputBindingSchema,
  connectorIdentifierSchema,
  entityIdSchema,
  type ConnectorActionInputBinding,
} from '@byok-grid/domain';
import { enrichmentErrorResponse } from '@/lib/enrichment-api';
import { getApiUser } from '@/lib/grid-api';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const createColumnSchema = z.strictObject({
  actionId: connectorIdentifierSchema,
  connectorId: connectorIdentifierSchema,
  credentialId: entityIdSchema.nullable(),
  inputBindings: z.record(
    connectorIdentifierSchema,
    connectorActionInputBindingSchema
  ),
  name: z.string().trim().min(1).max(120),
  runMode: z.enum(['manual', 'on_change']).default('manual'),
});

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = createColumnSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The connector column configuration is invalid.' },
      { status: 400 }
    );
  }

  const sandboxConnectors = loadSandboxConnectorRegistry();
  const manifest = getConnectorManifest(
    parsed.data.connectorId,
    undefined,
    sandboxConnectors
  );
  const action = manifest?.actions.find(
    (candidate) => candidate.id === parsed.data.actionId
  );
  if (!manifest || !action) {
    return Response.json(
      { error: 'The connector action is not installed.' },
      { status: 422 }
    );
  }
  const sandboxConnector = getSandboxConnector(
    manifest.id,
    manifest.version,
    sandboxConnectors
  );
  if (manifest.credentialRequired && !parsed.data.credentialId) {
    return Response.json(
      { error: `${manifest.displayName} requires a stored credential.` },
      { status: 422 }
    );
  }
  const allowedInputKeys = new Set(
    action.inputFields.map((field) => field.key)
  );
  const suppliedInputKeys = Object.keys(parsed.data.inputBindings);
  if (
    suppliedInputKeys.some((key) => !allowedInputKeys.has(key)) ||
    action.inputFields.some(
      (field) => field.required && !(field.key in parsed.data.inputBindings)
    ) ||
    action.inputFields.some((field) => {
      const binding = parsed.data.inputBindings[field.key];
      return binding !== undefined && !bindingMatchesField(binding, field);
    })
  ) {
    return Response.json(
      { error: 'The connector input mapping is incomplete.' },
      { status: 422 }
    );
  }

  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await createSqliteConnectorActionColumn(sqliteDb, {
        ...parsed.data,
        artifactSha256: sandboxConnector?.artifact.sha256 ?? null,
        connectorVersion: manifest.version,
        outputValueType: action.cellOutput.valueType,
        protocolVersion: manifest.protocolVersion,
        publisherKeyIds: sandboxConnector?.publisherKeyIds ?? [],
        registrySha256: sandboxConnector?.registrySha256 ?? null,
        tableId,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return enrichmentErrorResponse(error);
  }
}

function bindingMatchesField(
  binding: ConnectorActionInputBinding,
  field: ConnectorInputField
): boolean {
  if (binding.kind !== field.source) return false;
  if (field.source === 'column' || binding.kind === 'column') return true;

  const valueMatches =
    field.valueType === 'json'
      ? true
      : field.valueType === 'text'
        ? typeof binding.value === 'string'
        : field.valueType === 'number'
          ? typeof binding.value === 'number' && Number.isFinite(binding.value)
          : typeof binding.value === 'boolean';
  if (!valueMatches) return false;
  if (!field.options?.length) return true;
  return field.options.some((option) => option.value === binding.value);
}
