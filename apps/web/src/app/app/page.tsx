import {
  ensureSqlitePersonalWorkspace,
  getSqliteGridSnapshot,
  listSqliteCredentialMetadata,
  listSqliteIngestionEndpoints,
  listSqliteSources,
  listSqliteWorkspaceConnectorRevocations,
  listSqliteUserWorkspaces,
  listSqliteWebhookDestinations,
  listSqliteWritebackDestinations,
  listSqliteWorkflows,
  listSqliteWorkspaceTables,
} from '@byok-grid/db';
import {
  listConnectorManifests,
  loadSandboxConnectorRegistry,
  summarizeInstalledSandboxConnectors,
} from '@byok-grid/connectors';
import { getLocalOwner } from '@/lib/local-owner';
import { sqliteDb } from '@/lib/sqlite-database';
import { SourcePanel } from './source-panel';
import { CredentialPanel } from './credential-panel';
import { ConnectorColumnForm } from './connector-column-form';
import { ConnectorTrustPanel } from './connector-trust-panel';
import { GridEditor } from './grid-editor';
import { IngestionPanel } from './ingestion-panel';
import { TableManager } from './table-manager';
import { WorkflowPanel } from './workflow-panel';
import { WebhookPanel } from './webhook-panel';
import { WritebackPanel } from './writeback-panel';
import { WorkspaceSwitcher } from './workspace-switcher';

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; workspace?: string }>;
}) {
  const user = await getLocalOwner();

  const ensured = await ensureSqlitePersonalWorkspace(sqliteDb, {
    id: user.id,
    name: user.name,
  });
  const workspaces = await listSqliteUserWorkspaces(sqliteDb, user.id);
  const requested = await searchParams;
  const workspace =
    workspaces.find((item) => item.id === requested.workspace) ??
    workspaces.find((item) => item.id === ensured.id) ??
    ensured;
  const tables = await listSqliteWorkspaceTables(sqliteDb, {
    userId: user.id,
    workspaceId: workspace.id,
  });
  const table = tables.find((item) => item.id === requested.table) ?? tables[0];
  if (!table) throw new Error('The workspace does not have a starter table.');
  const [
    credentials,
    grid,
    ingestionEndpoints,
    revocations,
    sources,
    webhookDestinations,
    writebackDestinations,
    workflows,
  ] = await Promise.all([
    listSqliteCredentialMetadata(sqliteDb, {
      userId: user.id,
      workspaceId: workspace.id,
    }),
    getSqliteGridSnapshot(sqliteDb, {
      tableId: table.id,
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteIngestionEndpoints(sqliteDb, {
      tableId: table.id,
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteWorkspaceConnectorRevocations(sqliteDb, {
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteSources(sqliteDb, {
      tableId: table.id,
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteWebhookDestinations(sqliteDb, {
      tableId: table.id,
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteWritebackDestinations(sqliteDb, {
      tableId: table.id,
      userId: user.id,
      workspaceId: workspace.id,
    }),
    listSqliteWorkflows(sqliteDb, {
      userId: user.id,
      workspaceId: workspace.id,
    }),
  ]);
  const sandboxConnectors = loadSandboxConnectorRegistry();
  const connectors = listConnectorManifests(sandboxConnectors);
  const installedConnectors =
    summarizeInstalledSandboxConnectors(sandboxConnectors);
  const credentialConnectors = [
    ...builtInCredentialConnectors,
    ...sandboxConnectors.flatMap((connector) =>
      connector.catalog && connector.credentialForm
        ? [
            {
              credentialFields: connector.credentialForm.fields,
              credentialName: connector.manifest.credentialName,
              displayName: connector.manifest.displayName,
              id: connector.manifest.id,
            },
          ]
        : []
    ),
  ];

  return (
    <main className="app-page sqlite-app-page">
      <header className="app-header">
        <div className="brand-mark">B</div>
        <div>
          <p className="eyebrow">SQLITE WORKSPACE</p>
          <h1>{workspace.name}</h1>
          <WorkspaceSwitcher
            currentWorkspaceId={workspace.id}
            workspaces={workspaces}
          />
        </div>
        <div className="account-actions">
          <span>Local workspace</span>
        </div>
      </header>

      <TableManager
        currentTable={table}
        tables={tables}
        workspaceId={workspace.id}
      />

      <GridEditor
        initial={grid}
        webhookDestinations={webhookDestinations}
        writebackDestinations={writebackDestinations}
      />

      <CredentialPanel
        connectors={credentialConnectors}
        initial={credentials}
        workspaceId={workspace.id}
      />

      <ConnectorColumnForm
        columns={grid.columns}
        connectors={connectors}
        credentials={credentials}
        tableId={table.id}
        workspaceId={workspace.id}
      />

      <ConnectorTrustPanel
        initialRevocations={revocations}
        installed={installedConnectors}
        workspaceId={workspace.id}
      />

      <WebhookPanel
        credentials={credentials}
        initial={webhookDestinations}
        tableId={table.id}
        workspaceId={workspace.id}
      />

      <SourcePanel
        credentials={credentials}
        initial={sources}
        tableId={table.id}
        workspaceId={workspace.id}
      />

      <IngestionPanel
        initial={ingestionEndpoints}
        tableId={table.id}
        workspaceId={workspace.id}
      />

      <WritebackPanel
        columns={grid.columns}
        credentials={credentials}
        initial={writebackDestinations}
        tableId={table.id}
        workspaceId={workspace.id}
      />

      <WorkflowPanel
        initialWorkflows={workflows}
        resources={{
          columns: grid.columns.map((column) => ({
            id: column.id,
            kind: column.kind,
            name: column.name,
            tableId: table.id,
          })),
          tables,
          webhookDestinations,
        }}
        tables={tables}
        workspaceId={workspace.id}
      />
    </main>
  );
}

const builtInCredentialConnectors = [
  { credentialName: 'API key', displayName: 'Hunter', id: 'hunter' },
  { credentialName: 'API key', displayName: 'OpenAI', id: 'openai' },
  { credentialName: 'Access token', displayName: 'HubSpot', id: 'hubspot' },
  {
    credentialName: 'HTTP credential',
    displayName: 'Generic HTTP',
    id: 'http',
  },
  {
    credentialName: 'Signing secret',
    displayName: 'Webhook signing',
    id: 'webhook',
  },
] as const;
