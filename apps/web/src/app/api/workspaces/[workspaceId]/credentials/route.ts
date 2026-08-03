import { readApiJsonBody } from '@/lib/request-body';
import {
  getBuiltInCredentialSchema,
  getConnectorManifest,
  getSandboxConnector,
  sandboxJsonSchemaMatches,
} from '@byok-grid/connectors';
import {
  createSqliteEncryptedCredential,
  listSqliteCredentialMetadata,
} from '@byok-grid/db';
import { credentialErrorResponse } from '@/lib/credential-api';
import { getApiUser } from '@/lib/grid-api';
import { getDeploymentMasterKeys } from '@/lib/master-key';
import { sqliteDb } from '@/lib/sqlite-database';
import { z } from 'zod';

const createCredentialSchema = z.strictObject({
  connectorId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(120),
  secret: z
    .record(z.string().min(1).max(64), z.json())
    .refine((value) => Object.keys(value).length <= 16)
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536),
});

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await listSqliteCredentialMetadata(sqliteDb, {
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return credentialErrorResponse(error, request);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await readApiJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = createCredentialSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'The credential is invalid.' },
      { status: 400 }
    );
  }

  const credentialSchema = getBuiltInCredentialSchema(parsed.data.connectorId);
  const sandboxManifest = getConnectorManifest(parsed.data.connectorId);
  const sandboxConnector = sandboxManifest
    ? getSandboxConnector(parsed.data.connectorId, sandboxManifest.version)
    : undefined;
  const builtInSecret = credentialSchema?.safeParse(parsed.data.secret);
  const sandboxSecretValid = sandboxConnector?.manifest.credentialRequired
    ? sandboxJsonSchemaMatches(
        sandboxConnector.manifest.credentialSchema,
        parsed.data.secret
      )
    : false;
  if (
    (!builtInSecret?.success && !sandboxSecretValid) ||
    (parsed.data.connectorId === 'http' &&
      builtInSecret?.success &&
      'type' in builtInSecret.data &&
      builtInSecret.data.type === 'none')
  ) {
    return Response.json(
      { error: 'The connector credential is invalid.' },
      { status: 400 }
    );
  }

  try {
    const { workspaceId } = await context.params;
    return Response.json(
      await createSqliteEncryptedCredential(sqliteDb, {
        connectorId: parsed.data.connectorId,
        masterKeys: getDeploymentMasterKeys(),
        name: parsed.data.name,
        secret: builtInSecret?.success
          ? builtInSecret.data
          : parsed.data.secret,
        userId: user.id,
        workspaceId,
      }),
      { status: 201 }
    );
  } catch (error) {
    return credentialErrorResponse(error, request);
  }
}
