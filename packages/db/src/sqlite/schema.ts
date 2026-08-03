import type {
  BulkRunSelectionSnapshot,
  CompiledWorkflowPlan,
  ConnectorRevocationTarget,
  GridViewFilterGroup,
  GridViewSort,
  HubSpotContactsSourceConfiguration,
  WebhookPayload,
  WritebackDestinationRequest,
  WritebackPayload,
  WorkspacePurgeImpact,
  WorkspacePurgeReason,
  WorkflowDraftGraph,
  WorkflowGraph,
  WorkflowNodeKind,
} from '@byok-grid/domain';
import type { CryptoEnvelope } from '@byok-grid/security';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const workspaceRoles = ['owner', 'admin', 'member'] as const;
const columnKinds = ['input', 'formula', 'connector', 'function'] as const;
const cellValueTypes = [
  'empty',
  'text',
  'number',
  'boolean',
  'timestamp',
  'json',
] as const;
const cellStatuses = [
  'idle',
  'stale',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

function id(name = 'id') {
  return text(name)
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
}

function timestamp(name: string) {
  return integer(name, { mode: 'timestamp_ms' });
}

function sqliteTimestamps() {
  return {
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: timestamp('updated_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`)
      .$onUpdateFn(() => new Date()),
  };
}

export const users = sqliteTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' })
      .default(false)
      .notNull(),
    image: text('image'),
    ...sqliteTimestamps(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)]
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...sqliteTimestamps(),
  },
  (table) => [
    uniqueIndex('sessions_token_unique').on(table.token),
    index('sessions_user_idx').on(table.userId),
  ]
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    ...sqliteTimestamps(),
  },
  (table) => [
    index('accounts_user_idx').on(table.userId),
    uniqueIndex('accounts_provider_account_unique').on(
      table.providerId,
      table.accountId
    ),
  ]
);

export const verifications = sqliteTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    ...sqliteTimestamps(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)]
);

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    id: id(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: integer('last_request').notNull(),
  },
  (table) => [uniqueIndex('rate_limits_key_unique').on(table.key)]
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ...sqliteTimestamps(),
  },
  (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)]
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: workspaceRoles }).notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check(
      'workspace_members_valid_role',
      sql`${table.role} in ('owner', 'admin', 'member')`
    ),
    index('workspace_members_user_idx').on(table.userId),
  ]
);

export const dataTables = sqliteTable(
  'data_tables',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at'),
    archivedByUserId: text('archived_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    index('data_tables_workspace_idx').on(table.workspaceId),
    index('data_tables_workspace_archived_idx').on(
      table.workspaceId,
      table.archivedAt,
      table.createdAt
    ),
    unique('data_tables_id_workspace_unique').on(table.id, table.workspaceId),
  ]
);

export const columns = sqliteTable(
  'columns',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: columnKinds }).notNull(),
    valueType: text('value_type', { enum: cellValueTypes }).notNull(),
    position: text('position').notNull(),
    configuration: text('configuration', { mode: 'json' })
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    archivedAt: timestamp('archived_at'),
    archivedByUserId: text('archived_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'columns_valid_kind',
      sql`${table.kind} in ('input', 'formula', 'connector', 'function')`
    ),
    check(
      'columns_valid_value_type',
      sql`${table.valueType} in ('empty', 'text', 'number', 'boolean', 'timestamp', 'json')`
    ),
    check(
      'columns_configuration_json',
      sql`json_valid(${table.configuration})`
    ),
    index('columns_table_position_idx').on(table.tableId, table.position),
    index('columns_table_archived_position_idx').on(
      table.tableId,
      table.archivedAt,
      table.position
    ),
    uniqueIndex('columns_table_name_unique').on(table.tableId, table.name),
    unique('columns_id_table_workspace_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'columns_table_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const savedGridViews = sqliteTable(
  'saved_grid_views',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    name: text('name').notNull(),
    filters: text('filters', { mode: 'json' })
      .$type<GridViewFilterGroup>()
      .notNull()
      .default({ children: [], combinator: 'and' }),
    sort: text('sort', { mode: 'json' }).$type<GridViewSort | null>(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    check('saved_grid_views_filters_json', sql`json_valid(${table.filters})`),
    check(
      'saved_grid_views_name_length',
      sql`length(${table.name}) between 1 and 80`
    ),
    uniqueIndex('saved_grid_views_table_name_unique').on(
      table.tableId,
      table.name
    ),
    index('saved_grid_views_workspace_table_created_idx').on(
      table.workspaceId,
      table.tableId,
      table.createdAt
    ),
    unique('saved_grid_views_id_table_workspace_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'saved_grid_views_table_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const rows = sqliteTable(
  'rows',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    position: text('position').notNull(),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check('rows_positive_version', sql`${table.version} >= 1`),
    index('rows_table_archived_position_idx').on(
      table.tableId,
      table.archivedAt,
      table.position
    ),
    unique('rows_id_table_workspace_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'rows_table_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const cells = sqliteTable(
  'cells',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    columnId: text('column_id').notNull(),
    valueType: text('value_type', { enum: cellValueTypes })
      .notNull()
      .default('empty'),
    valueText: text('value_text'),
    valueNumber: real('value_number'),
    valueBoolean: integer('value_boolean', { mode: 'boolean' }),
    valueTimestamp: timestamp('value_timestamp'),
    valueJson: text('value_json', { mode: 'json' }),
    searchText: text('search_text').notNull().default(''),
    status: text('status', { enum: cellStatuses }).notNull().default('idle'),
    version: integer('version').notNull().default(1),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'cells_valid_value_type',
      sql`${table.valueType} in ('empty', 'text', 'number', 'boolean', 'timestamp', 'json')`
    ),
    check(
      'cells_valid_status',
      sql`${table.status} in ('idle', 'stale', 'queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check('cells_positive_version', sql`${table.version} >= 1`),
    check('cells_search_text_bound', sql`length(${table.searchText}) <= 8192`),
    uniqueIndex('cells_row_column_unique').on(table.rowId, table.columnId),
    unique('cells_id_workspace_unique').on(table.id, table.workspaceId),
    index('cells_text_sort_idx').on(
      table.columnId,
      table.valueText,
      table.rowId
    ),
    index('cells_number_sort_idx').on(
      table.columnId,
      table.valueNumber,
      table.rowId
    ),
    index('cells_timestamp_sort_idx').on(
      table.columnId,
      table.valueTimestamp,
      table.rowId
    ),
    index('cells_boolean_sort_idx').on(
      table.columnId,
      table.valueBoolean,
      table.rowId
    ),
    index('cells_status_filter_idx').on(
      table.columnId,
      table.status,
      table.rowId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'cells_table_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'cells_row_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.columnId, table.tableId, table.workspaceId],
      foreignColumns: [columns.id, columns.tableId, columns.workspaceId],
      name: 'cells_column_scope_fk',
    }).onDelete('cascade'),
  ]
);

const workflowStates = ['draft', 'active', 'paused'] as const;

export const workflows = sqliteTable(
  'workflows',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    state: text('state', { enum: workflowStates }).notNull().default('draft'),
    draftGraph: text('draft_graph', { mode: 'json' })
      .$type<WorkflowDraftGraph>()
      .notNull(),
    draftDigest: text('draft_digest').notNull(),
    publishedVersion: integer('published_version'),
    draftRevision: integer('draft_revision').notNull().default(1),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'workflows_valid_state',
      sql`${table.state} in ('draft', 'active', 'paused')`
    ),
    check('workflows_positive_revision', sql`${table.draftRevision} >= 1`),
    check('workflows_draft_graph_json', sql`json_valid(${table.draftGraph})`),
    check(
      'workflows_draft_digest',
      sql`length(${table.draftDigest}) = 64 and ${table.draftDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      'workflows_published_state',
      sql`(${table.state} = 'draft' and ${table.publishedVersion} is null) or (${table.state} <> 'draft' and ${table.publishedVersion} >= 1)`
    ),
    uniqueIndex('workflows_workspace_name_unique').on(
      table.workspaceId,
      table.name
    ),
    index('workflows_workspace_updated_idx').on(
      table.workspaceId,
      table.updatedAt
    ),
    unique('workflows_id_workspace_unique').on(table.id, table.workspaceId),
  ]
);

export const workflowVersions = sqliteTable(
  'workflow_versions',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    version: integer('version').notNull(),
    graph: text('graph', { mode: 'json' }).$type<WorkflowGraph>().notNull(),
    graphDigest: text('graph_digest').notNull(),
    compiledPlan: text('compiled_plan', {
      mode: 'json',
    }).$type<CompiledWorkflowPlan>(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    publishedAt: timestamp('published_at').notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    check('workflow_versions_positive', sql`${table.version} >= 1`),
    check('workflow_versions_graph_json', sql`json_valid(${table.graph})`),
    check(
      'workflow_versions_compiled_plan_json',
      sql`${table.compiledPlan} is null or (json_valid(${table.compiledPlan}) and json_type(${table.compiledPlan}) = 'object')`
    ),
    check(
      'workflow_versions_digest',
      sql`length(${table.graphDigest}) = 64 and ${table.graphDigest} not glob '*[^0-9a-f]*'`
    ),
    uniqueIndex('workflow_versions_workflow_version_unique').on(
      table.workflowId,
      table.version
    ),
    unique('workflow_versions_execution_scope_unique').on(
      table.workflowId,
      table.version,
      table.workspaceId
    ),
    index('workflow_versions_workspace_published_idx').on(
      table.workspaceId,
      table.publishedAt
    ),
    unique('workflow_versions_id_scope_unique').on(
      table.id,
      table.workflowId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.workflowId, table.workspaceId],
      foreignColumns: [workflows.id, workflows.workspaceId],
      name: 'workflow_versions_workflow_scope_fk',
    }).onDelete('cascade'),
  ]
);

const workflowRunStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    workflowVersion: integer('workflow_version').notNull(),
    graphDigest: text('graph_digest').notNull(),
    status: text('status', { enum: workflowRunStatuses })
      .notNull()
      .default('queued'),
    requestedByUserId: text('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    input: text('input', { mode: 'json' })
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'workflow_runs_valid_status',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check('workflow_runs_positive_version', sql`${table.workflowVersion} >= 1`),
    check(
      'workflow_runs_graph_digest',
      sql`length(${table.graphDigest}) = 64 and ${table.graphDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      'workflow_runs_input_json',
      sql`json_valid(${table.input}) and json_type(${table.input}) = 'object'`
    ),
    check(
      'workflow_runs_error_lengths',
      sql`(${table.errorCode} is null or length(${table.errorCode}) between 1 and 120) and (${table.errorMessage} is null or length(${table.errorMessage}) between 1 and 500)`
    ),
    index('workflow_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('workflow_runs_status_updated_idx').on(table.status, table.updatedAt),
    unique('workflow_runs_id_workspace_unique').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.workflowId, table.workflowVersion, table.workspaceId],
      foreignColumns: [
        workflowVersions.workflowId,
        workflowVersions.version,
        workflowVersions.workspaceId,
      ],
      name: 'workflow_runs_version_scope_fk',
    }).onDelete('restrict'),
  ]
);

const workflowStepRunStatuses = [
  'blocked',
  'ready',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

export const workflowStepRuns = sqliteTable(
  'workflow_step_runs',
  {
    runId: text('run_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    stepId: text('step_id').notNull(),
    stepKind: text('step_kind').$type<WorkflowNodeKind>().notNull(),
    status: text('status', { enum: workflowStepRunStatuses })
      .notNull()
      .default('blocked'),
    attempt: integer('attempt').notNull().default(0),
    claimId: text('claim_id'),
    claimedAt: timestamp('claimed_at'),
    nextAttemptAt: timestamp('next_attempt_at'),
    input: text('input', { mode: 'json' }).$type<unknown>(),
    output: text('output', { mode: 'json' }).$type<unknown>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stepId] }),
    check(
      'workflow_step_runs_valid_status',
      sql`${table.status} in ('blocked', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'cancelled') and ${table.attempt} >= 0`
    ),
    check(
      'workflow_step_runs_claim_state',
      sql`((${table.claimId} is null and ${table.claimedAt} is null) or (${table.claimId} is not null and ${table.claimedAt} is not null)) and (${table.status} = 'running' or (${table.claimId} is null and ${table.claimedAt} is null))`
    ),
    check(
      'workflow_step_runs_json',
      sql`(${table.input} is null or json_valid(${table.input})) and (${table.output} is null or json_valid(${table.output}))`
    ),
    check(
      'workflow_step_runs_error_lengths',
      sql`(${table.errorCode} is null or length(${table.errorCode}) between 1 and 120) and (${table.errorMessage} is null or length(${table.errorMessage}) between 1 and 500)`
    ),
    index('workflow_step_runs_claim_idx').on(
      table.status,
      table.nextAttemptAt,
      table.claimedAt,
      table.updatedAt
    ),
    index('workflow_step_runs_workspace_run_idx').on(
      table.workspaceId,
      table.runId
    ),
    unique('workflow_step_runs_scope_unique').on(
      table.runId,
      table.stepId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [workflowRuns.id, workflowRuns.workspaceId],
      name: 'workflow_step_runs_run_scope_fk',
    }).onDelete('cascade'),
  ]
);

export type SchemaLifecycleAction =
  | 'column_archived'
  | 'column_restored'
  | 'column_type_converted'
  | 'table_archived'
  | 'table_restored';

export type SchemaLifecycleSnapshot = Readonly<Record<string, unknown>>;
export type CsvImportColumnMapping = ReadonlyArray<
  Readonly<{ columnId: string; header: string }>
>;

export const workspacePurgeHolds = sqliteTable(
  'workspace_purge_holds',
  {
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    placedBy: text('placed_by').notNull(),
    placedAt: timestamp('placed_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    check(
      'workspace_purge_holds_reason_length',
      sql`length(${table.reason}) between 8 and 500`
    ),
    check(
      'workspace_purge_holds_actor_length',
      sql`length(${table.placedBy}) between 1 and 200`
    ),
  ]
);

export const workspacePurgeReceipts = sqliteTable(
  'workspace_purge_receipts',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason').$type<WorkspacePurgeReason>().notNull(),
    previewDigest: text('preview_digest').notNull(),
    impact: text('impact', { mode: 'json' })
      .$type<WorkspacePurgeImpact>()
      .notNull(),
    purgedAt: timestamp('purged_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    analyticsEraseClaimId: text('analytics_erase_claim_id'),
    analyticsEraseClaimedAt: timestamp('analytics_erase_claimed_at'),
    analyticsEraseAttempts: integer('analytics_erase_attempts')
      .notNull()
      .default(0),
    analyticsEraseNextAttemptAt: timestamp('analytics_erase_next_attempt_at'),
    analyticsEraseLastError: text('analytics_erase_last_error'),
    analyticsErasedAt: timestamp('analytics_erased_at'),
  },
  (table) => [
    check(
      'workspace_purge_receipts_reason',
      sql`${table.reason} in ('duplicate_workspace', 'test_data', 'user_requested', 'other')`
    ),
    check(
      'workspace_purge_receipts_digest',
      sql`length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      'workspace_purge_receipts_impact_shape',
      sql`json_valid(${table.impact}) and json_type(${table.impact}) = 'object'`
    ),
    check(
      'workspace_purge_receipts_analytics_state',
      sql`${table.analyticsEraseAttempts} >= 0 and ((${table.analyticsEraseClaimId} is null and ${table.analyticsEraseClaimedAt} is null) or (${table.analyticsEraseClaimId} is not null and ${table.analyticsEraseClaimedAt} is not null)) and (${table.analyticsEraseLastError} is null or length(${table.analyticsEraseLastError}) <= 500)`
    ),
    uniqueIndex('workspace_purge_receipts_workspace_unique').on(
      table.workspaceId
    ),
    index('workspace_purge_receipts_purged_at_idx').on(table.purgedAt),
    index('workspace_purge_receipts_analytics_erase_idx').on(
      table.analyticsErasedAt,
      table.analyticsEraseNextAttemptAt,
      table.purgedAt
    ),
  ]
);

export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: workspaceRoles }).notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at').notNull(),
    acceptedAt: timestamp('accepted_at'),
    acceptedByUserId: text('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check('workspace_invitations_no_owner', sql`${table.role} <> 'owner'`),
    check(
      'workspace_invitations_token_hash_length',
      sql`length(${table.tokenHash}) = 64 and ${table.tokenHash} not glob '*[^0-9a-f]*'`
    ),
    uniqueIndex('workspace_invitations_token_hash_unique').on(table.tokenHash),
    uniqueIndex('workspace_invitations_active_email_unique')
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index('workspace_invitations_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

export const connectorRevocations = sqliteTable(
  'connector_revocations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    target: text('target', { mode: 'json' })
      .$type<ConnectorRevocationTarget>()
      .notNull(),
    targetKey: text('target_key').notNull(),
    reason: text('reason').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    liftedAt: timestamp('lifted_at'),
    liftedByUserId: text('lifted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'connector_revocations_target_json',
      sql`json_valid(${table.target}) and json_type(${table.target}) = 'object'`
    ),
    check(
      'connector_revocations_reason_length',
      sql`length(${table.reason}) between 8 and 500`
    ),
    check(
      'connector_revocations_lift_actor',
      sql`${table.liftedAt} is not null or ${table.liftedByUserId} is null`
    ),
    uniqueIndex('connector_revocations_workspace_active_target_unique')
      .on(table.workspaceId, table.targetKey)
      .where(sql`${table.liftedAt} is null`),
    index('connector_revocations_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

export const columnDependencies = sqliteTable(
  'column_dependencies',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    columnId: text('column_id').notNull(),
    dependsOnColumnId: text('depends_on_column_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.columnId, table.dependsOnColumnId] }),
    check(
      'column_dependencies_not_self',
      sql`${table.columnId} <> ${table.dependsOnColumnId}`
    ),
    foreignKey({
      columns: [table.columnId, table.tableId, table.workspaceId],
      foreignColumns: [columns.id, columns.tableId, columns.workspaceId],
      name: 'column_dependencies_column_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.dependsOnColumnId, table.tableId, table.workspaceId],
      foreignColumns: [columns.id, columns.tableId, columns.workspaceId],
      name: 'column_dependencies_parent_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const schemaLifecycleEvents = sqliteTable(
  'schema_lifecycle_events',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    columnId: text('column_id'),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').$type<SchemaLifecycleAction>().notNull(),
    snapshot: text('snapshot', { mode: 'json' })
      .$type<SchemaLifecycleSnapshot>()
      .notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    check(
      'schema_lifecycle_events_valid_action',
      sql`${table.action} in ('column_archived', 'column_restored', 'column_type_converted', 'table_archived', 'table_restored')`
    ),
    check(
      'schema_lifecycle_events_column_scope',
      sql`(${table.action} like 'column_%' and ${table.columnId} is not null) or (${table.action} like 'table_%' and ${table.columnId} is null)`
    ),
    check(
      'schema_lifecycle_events_snapshot_json',
      sql`json_valid(${table.snapshot})`
    ),
    index('schema_lifecycle_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('schema_lifecycle_events_resource_created_idx').on(
      table.tableId,
      table.columnId,
      table.createdAt
    ),
  ]
);

const importJobStatuses = [
  'staging',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const importJobs = sqliteTable(
  'import_jobs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    filename: text('filename').notNull(),
    status: text('status', { enum: importJobStatuses })
      .notNull()
      .default('staging'),
    headers: text('headers', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default([]),
    columnMapping: text('column_mapping', { mode: 'json' }).$type<
      CsvImportColumnMapping | undefined
    >(),
    uploadedBytes: integer('uploaded_bytes').notNull().default(0),
    stagedRowCount: integer('staged_row_count').notNull().default(0),
    importedRowCount: integer('imported_row_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'import_jobs_valid_status',
      sql`${table.status} in ('staging', 'queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      'import_jobs_headers_json',
      sql`json_valid(${table.headers}) and json_type(${table.headers}) = 'array'`
    ),
    check(
      'import_jobs_mapping_json',
      sql`${table.columnMapping} is null or json_valid(${table.columnMapping})`
    ),
    check(
      'import_jobs_nonnegative_counts',
      sql`${table.uploadedBytes} >= 0 and ${table.stagedRowCount} >= 0 and ${table.importedRowCount} >= 0`
    ),
    index('import_jobs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('import_jobs_status_created_idx').on(table.status, table.createdAt),
    unique('import_jobs_id_workspace_unique').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'import_jobs_table_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const importStagedRows = sqliteTable(
  'import_staged_rows',
  {
    importJobId: text('import_job_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    values: text('values', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.importJobId, table.rowNumber] }),
    check('import_staged_rows_positive_number', sql`${table.rowNumber} > 0`),
    check(
      'import_staged_rows_values_json',
      sql`json_valid(${table.values}) and json_type(${table.values}) = 'array'`
    ),
    index('import_staged_rows_workspace_job_idx').on(
      table.workspaceId,
      table.importJobId,
      table.rowNumber
    ),
    foreignKey({
      columns: [table.importJobId, table.workspaceId],
      foreignColumns: [importJobs.id, importJobs.workspaceId],
      name: 'import_staged_rows_job_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const workspaceKeys = sqliteTable('workspace_keys', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  wrappedKey: text('wrapped_key', { mode: 'json' })
    .$type<CryptoEnvelope>()
    .notNull(),
  keyId: text('key_id').notNull(),
  ...sqliteTimestamps(),
});

export const credentials = sqliteTable(
  'credentials',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    connectorId: text('connector_id').notNull(),
    encryptedValue: text('encrypted_value', { mode: 'json' })
      .$type<CryptoEnvelope>()
      .notNull(),
    revokedAt: timestamp('revoked_at'),
    lastUsedAt: timestamp('last_used_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'credentials_encrypted_value_json',
      sql`json_valid(${table.encryptedValue}) and json_type(${table.encryptedValue}) = 'object'`
    ),
    index('credentials_workspace_connector_idx').on(
      table.workspaceId,
      table.connectorId
    ),
    unique('credentials_id_workspace_unique').on(table.id, table.workspaceId),
  ]
);

export type SourceFieldMapping = ReadonlyArray<
  Readonly<{ columnId: string; field: string }>
>;
export type IngestionStagedValues = Readonly<Record<string, string | null>>;

const sourceDefinitionStatuses = ['active', 'paused'] as const;
const sourcePaginationModes = ['none', 'cursor'] as const;
const sourceMissingRecordModes = ['preserve', 'archive'] as const;
const sourceRunStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
const sourceRunTriggers = ['manual', 'schedule'] as const;

export const sourceDefinitions = sqliteTable(
  'source_definitions',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    adapterId: text('adapter_id').notNull().default('http_json'),
    adapterConfiguration: text('adapter_configuration', {
      mode: 'json',
    }).$type<HubSpotContactsSourceConfiguration>(),
    endpointUrl: text('endpoint_url').notNull(),
    credentialId: text('credential_id'),
    recordPath: text('record_path').notNull().default(''),
    recordKeyField: text('record_key_field').notNull(),
    maxRecords: integer('max_records').notNull().default(1_000),
    missingRecordMode: text('missing_record_mode', {
      enum: sourceMissingRecordModes,
    })
      .notNull()
      .default('preserve'),
    paginationMode: text('pagination_mode', { enum: sourcePaginationModes })
      .notNull()
      .default('none'),
    cursorParameter: text('cursor_parameter'),
    nextCursorPath: text('next_cursor_path'),
    maxPages: integer('max_pages').notNull().default(1),
    fieldMapping: text('field_mapping', { mode: 'json' }).$type<
      SourceFieldMapping | undefined
    >(),
    status: text('status', { enum: sourceDefinitionStatuses })
      .notNull()
      .default('active'),
    scheduleIntervalMinutes: integer('schedule_interval_minutes'),
    nextRunAt: timestamp('next_run_at'),
    lastRunAt: timestamp('last_run_at'),
    incrementalWatermark: timestamp('incremental_watermark'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'source_definitions_record_limits',
      sql`${table.maxRecords} between 1 and 5000`
    ),
    check(
      'source_definitions_supported_adapter',
      sql`${table.adapterId} in ('http_json', 'hubspot_contacts')`
    ),
    check(
      'source_definitions_adapter_configuration',
      sql`(${table.adapterId} = 'http_json' and ${table.adapterConfiguration} is null and ${table.incrementalWatermark} is null) or (${table.adapterId} = 'hubspot_contacts' and json_valid(${table.adapterConfiguration}) and json_type(${table.adapterConfiguration}) = 'object' and ${table.credentialId} is not null and ${table.missingRecordMode} = 'preserve' and ${table.paginationMode} = 'cursor')`
    ),
    check(
      'source_definitions_schedule_interval',
      sql`${table.scheduleIntervalMinutes} is null or ${table.scheduleIntervalMinutes} >= 5`
    ),
    check(
      'source_definitions_pagination_limits',
      sql`${table.maxPages} between 1 and 25`
    ),
    check(
      'source_definitions_pagination_configuration',
      sql`(${table.paginationMode} = 'none' and ${table.cursorParameter} is null and ${table.nextCursorPath} is null and ${table.maxPages} = 1) or (${table.paginationMode} = 'cursor' and ${table.cursorParameter} is not null and ${table.nextCursorPath} is not null and ${table.maxPages} >= 2)`
    ),
    check(
      'source_definitions_manual_has_no_next_run',
      sql`${table.scheduleIntervalMinutes} is not null or ${table.nextRunAt} is null`
    ),
    check(
      'source_definitions_valid_status',
      sql`${table.status} in ('active', 'paused')`
    ),
    check(
      'source_definitions_mapping_json',
      sql`${table.fieldMapping} is null or json_valid(${table.fieldMapping})`
    ),
    index('source_definitions_workspace_table_idx').on(
      table.workspaceId,
      table.tableId,
      table.createdAt
    ),
    index('source_definitions_due_idx').on(table.status, table.nextRunAt),
    unique('source_definitions_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    unique('source_definitions_scope_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'source_definitions_table_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.credentialId, table.workspaceId],
      foreignColumns: [credentials.id, credentials.workspaceId],
      name: 'source_definitions_credential_workspace_fk',
    }).onDelete('restrict'),
  ]
);

export const sourceRuns = sqliteTable(
  'source_runs',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    trigger: text('trigger', { enum: sourceRunTriggers }).notNull(),
    status: text('status', { enum: sourceRunStatuses })
      .notNull()
      .default('queued'),
    scheduledFor: timestamp('scheduled_for').notNull(),
    attempt: integer('attempt').notNull().default(0),
    pageCount: integer('page_count').notNull().default(0),
    nextCursorEncrypted: text('next_cursor_encrypted', {
      mode: 'json',
    }).$type<CryptoEnvelope>(),
    incrementalWindowStart: timestamp('incremental_window_start'),
    incrementalWindowEnd: timestamp('incremental_window_end'),
    receivedRecordCount: integer('received_record_count').notNull().default(0),
    createdRowCount: integer('created_row_count').notNull().default(0),
    updatedRowCount: integer('updated_row_count').notNull().default(0),
    archivedRowCount: integer('archived_row_count').notNull().default(0),
    restoredRowCount: integer('restored_row_count').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'source_runs_valid_state',
      sql`${table.trigger} in ('manual', 'schedule') and ${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      'source_runs_nonnegative_counts',
      sql`${table.attempt} >= 0 and ${table.pageCount} >= 0 and ${table.receivedRecordCount} >= 0 and ${table.createdRowCount} >= 0 and ${table.updatedRowCount} >= 0 and ${table.archivedRowCount} >= 0 and ${table.restoredRowCount} >= 0`
    ),
    check(
      'source_runs_incremental_window',
      sql`(${table.incrementalWindowStart} is null and ${table.incrementalWindowEnd} is null) or (${table.incrementalWindowStart} is not null and ${table.incrementalWindowEnd} is not null and ${table.incrementalWindowStart} < ${table.incrementalWindowEnd})`
    ),
    uniqueIndex('source_runs_source_scheduled_unique').on(
      table.sourceId,
      table.scheduledFor
    ),
    index('source_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('source_runs_source_created_idx').on(table.sourceId, table.createdAt),
    unique('source_runs_id_workspace_unique').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.sourceId, table.tableId, table.workspaceId],
      foreignColumns: [
        sourceDefinitions.id,
        sourceDefinitions.tableId,
        sourceDefinitions.workspaceId,
      ],
      name: 'source_runs_definition_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const sourceRecords = sqliteTable(
  'source_records',
  {
    sourceId: text('source_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    recordKey: text('record_key').notNull(),
    rowId: text('row_id').notNull(),
    lastSeenRunId: text('last_seen_run_id').references(() => sourceRuns.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at'),
    archivedByRunId: text('archived_by_run_id').references(
      () => sourceRuns.id,
      { onDelete: 'restrict' }
    ),
    ...sqliteTimestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.recordKey] }),
    check(
      'source_records_key_length',
      sql`length(${table.recordKey}) between 1 and 500`
    ),
    check(
      'source_records_archive_state',
      sql`(${table.archivedAt} is null and ${table.archivedByRunId} is null) or (${table.archivedAt} is not null and ${table.archivedByRunId} is not null)`
    ),
    uniqueIndex('source_records_source_row_unique').on(
      table.sourceId,
      table.rowId
    ),
    index('source_records_workspace_table_idx').on(
      table.workspaceId,
      table.tableId
    ),
    foreignKey({
      columns: [table.sourceId, table.tableId, table.workspaceId],
      foreignColumns: [
        sourceDefinitions.id,
        sourceDefinitions.tableId,
        sourceDefinitions.workspaceId,
      ],
      name: 'source_records_definition_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'source_records_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const ingestionEndpoints = sqliteTable(
  'ingestion_endpoints',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    recordKeyField: text('record_key_field').notNull(),
    fieldMapping: text('field_mapping', { mode: 'json' }).$type<
      SourceFieldMapping | undefined
    >(),
    revokedAt: timestamp('revoked_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'ingestion_endpoints_token_hash_length',
      sql`length(${table.tokenHash}) = 64 and ${table.tokenHash} not glob '*[^0-9a-f]*'`
    ),
    check(
      'ingestion_endpoints_token_prefix_length',
      sql`length(${table.tokenPrefix}) between 8 and 24`
    ),
    check(
      'ingestion_endpoints_text_lengths',
      sql`length(${table.name}) between 1 and 120 and length(${table.recordKeyField}) between 1 and 120`
    ),
    uniqueIndex('ingestion_endpoints_token_hash_unique').on(table.tokenHash),
    index('ingestion_endpoints_workspace_table_idx').on(
      table.workspaceId,
      table.tableId,
      table.createdAt
    ),
    unique('ingestion_endpoints_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    unique('ingestion_endpoints_scope_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'ingestion_endpoints_table_workspace_fk',
    }).onDelete('cascade'),
  ]
);

const ingestionBatchStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const ingestionBatches = sqliteTable(
  'ingestion_batches',
  {
    id: id(),
    endpointId: text('endpoint_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    status: text('status', { enum: ingestionBatchStatuses })
      .notNull()
      .default('queued'),
    fields: text('fields', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull(),
    recordCount: integer('record_count').notNull(),
    processedRecordCount: integer('processed_record_count')
      .notNull()
      .default(0),
    createdRowCount: integer('created_row_count').notNull().default(0),
    updatedRowCount: integer('updated_row_count').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'ingestion_batches_valid_status',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      'ingestion_batches_nonnegative_counts',
      sql`${table.recordCount} between 1 and 1000 and ${table.processedRecordCount} between 0 and ${table.recordCount} and ${table.createdRowCount} >= 0 and ${table.updatedRowCount} >= 0 and ${table.createdRowCount} + ${table.updatedRowCount} <= ${table.processedRecordCount} and ${table.attempt} >= 0`
    ),
    check(
      'ingestion_batches_request_digest_length',
      sql`length(${table.requestDigest}) = 64 and ${table.requestDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      'ingestion_batches_payload_shape',
      sql`json_valid(${table.fields}) and json_type(${table.fields}) = 'array' and json_array_length(${table.fields}) between 1 and 100 and length(${table.idempotencyKey}) between 8 and 200`
    ),
    uniqueIndex('ingestion_batches_endpoint_idempotency_unique').on(
      table.endpointId,
      table.idempotencyKey
    ),
    index('ingestion_batches_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    unique('ingestion_batches_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.endpointId, table.tableId, table.workspaceId],
      foreignColumns: [
        ingestionEndpoints.id,
        ingestionEndpoints.tableId,
        ingestionEndpoints.workspaceId,
      ],
      name: 'ingestion_batches_endpoint_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const ingestionStagedRecords = sqliteTable(
  'ingestion_staged_records',
  {
    batchId: text('batch_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    recordKey: text('record_key').notNull(),
    values: text('values', { mode: 'json' })
      .$type<IngestionStagedValues>()
      .notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.ordinal] }),
    check(
      'ingestion_staged_records_valid_ordinal',
      sql`${table.ordinal} between 1 and 1000`
    ),
    check(
      'ingestion_staged_records_key_length',
      sql`length(${table.recordKey}) between 1 and 500`
    ),
    check(
      'ingestion_staged_records_values_shape',
      sql`json_valid(${table.values}) and json_type(${table.values}) = 'object' and length(cast(${table.values} as blob)) <= 262144`
    ),
    uniqueIndex('ingestion_staged_records_batch_key_unique').on(
      table.batchId,
      table.recordKey
    ),
    index('ingestion_staged_records_workspace_batch_idx').on(
      table.workspaceId,
      table.batchId,
      table.ordinal
    ),
    foreignKey({
      columns: [table.batchId, table.workspaceId],
      foreignColumns: [ingestionBatches.id, ingestionBatches.workspaceId],
      name: 'ingestion_staged_records_batch_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const ingestionRecords = sqliteTable(
  'ingestion_records',
  {
    endpointId: text('endpoint_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    recordKey: text('record_key').notNull(),
    rowId: text('row_id').notNull(),
    lastBatchId: text('last_batch_id').references(() => ingestionBatches.id, {
      onDelete: 'set null',
    }),
    ...sqliteTimestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.endpointId, table.recordKey] }),
    check(
      'ingestion_records_key_length',
      sql`length(${table.recordKey}) between 1 and 500`
    ),
    uniqueIndex('ingestion_records_endpoint_row_unique').on(
      table.endpointId,
      table.rowId
    ),
    index('ingestion_records_workspace_table_idx').on(
      table.workspaceId,
      table.tableId
    ),
    foreignKey({
      columns: [table.endpointId, table.tableId, table.workspaceId],
      foreignColumns: [
        ingestionEndpoints.id,
        ingestionEndpoints.tableId,
        ingestionEndpoints.workspaceId,
      ],
      name: 'ingestion_records_endpoint_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'ingestion_records_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

const activePausedStatuses = ['active', 'paused'] as const;
const triggerModes = ['manual', 'row_settled'] as const;
const deliveryStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const webhookDestinations = sqliteTable(
  'webhook_destinations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    signingCredentialId: text('signing_credential_id').notNull(),
    status: text('status', { enum: activePausedStatuses })
      .notNull()
      .default('active'),
    triggerMode: text('trigger_mode', { enum: triggerModes })
      .notNull()
      .default('manual'),
    lastDeliveryAt: timestamp('last_delivery_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'webhook_destinations_valid_state',
      sql`${table.status} in ('active', 'paused') and ${table.triggerMode} in ('manual', 'row_settled')`
    ),
    index('webhook_destinations_workspace_table_idx').on(
      table.workspaceId,
      table.tableId,
      table.createdAt
    ),
    unique('webhook_destinations_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    unique('webhook_destinations_scope_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'webhook_destinations_table_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.signingCredentialId, table.workspaceId],
      foreignColumns: [credentials.id, credentials.workspaceId],
      name: 'webhook_destinations_credential_workspace_fk',
    }).onDelete('restrict'),
  ]
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    destinationId: text('destination_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    triggerMode: text('trigger_mode', { enum: triggerModes })
      .notNull()
      .default('manual'),
    payload: text('payload', { mode: 'json' })
      .$type<WebhookPayload>()
      .notNull(),
    status: text('status', { enum: deliveryStatuses })
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    responseStatus: integer('response_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'webhook_deliveries_valid_state',
      sql`${table.triggerMode} in ('manual', 'row_settled') and ${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check('webhook_deliveries_valid_attempt', sql`${table.attempt} >= 0`),
    check('webhook_deliveries_valid_row_version', sql`${table.rowVersion} > 0`),
    check(
      'webhook_deliveries_payload_json',
      sql`json_valid(${table.payload}) and json_type(${table.payload}) = 'object'`
    ),
    check(
      'webhook_deliveries_valid_response_status',
      sql`${table.responseStatus} is null or ${table.responseStatus} between 100 and 599`
    ),
    index('webhook_deliveries_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('webhook_deliveries_destination_created_idx').on(
      table.destinationId,
      table.createdAt
    ),
    uniqueIndex('webhook_deliveries_settlement_unique')
      .on(table.destinationId, table.rowId, table.rowVersion)
      .where(sql`${table.triggerMode} = 'row_settled'`),
    unique('webhook_deliveries_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.destinationId, table.tableId, table.workspaceId],
      foreignColumns: [
        webhookDestinations.id,
        webhookDestinations.tableId,
        webhookDestinations.workspaceId,
      ],
      name: 'webhook_deliveries_destination_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'webhook_deliveries_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const writebackDestinations = sqliteTable(
  'writeback_destinations',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    adapterId: text('adapter_id').notNull().default('hubspot_contact'),
    credentialId: text('credential_id').notNull(),
    recordIdColumnId: text('record_id_column_id').notNull(),
    fieldMappings: text('field_mappings', { mode: 'json' })
      .$type<WritebackDestinationRequest['fieldMappings']>()
      .notNull(),
    filterTree: text('filter_tree', { mode: 'json' })
      .$type<GridViewFilterGroup>()
      .notNull()
      .default({ children: [], combinator: 'and' }),
    status: text('status', { enum: activePausedStatuses })
      .notNull()
      .default('active'),
    triggerMode: text('trigger_mode', { enum: triggerModes })
      .notNull()
      .default('manual'),
    lastDeliveryAt: timestamp('last_delivery_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'writeback_destinations_supported_adapter',
      sql`${table.adapterId} = 'hubspot_contact'`
    ),
    check(
      'writeback_destinations_json',
      sql`json_valid(${table.fieldMappings}) and json_type(${table.fieldMappings}) = 'array' and json_valid(${table.filterTree}) and json_type(${table.filterTree}) = 'object'`
    ),
    check(
      'writeback_destinations_valid_state',
      sql`${table.status} in ('active', 'paused') and ${table.triggerMode} in ('manual', 'row_settled')`
    ),
    index('writeback_destinations_workspace_table_idx').on(
      table.workspaceId,
      table.tableId,
      table.createdAt
    ),
    unique('writeback_destinations_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    unique('writeback_destinations_scope_unique').on(
      table.id,
      table.tableId,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'writeback_destinations_table_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.credentialId, table.workspaceId],
      foreignColumns: [credentials.id, credentials.workspaceId],
      name: 'writeback_destinations_credential_workspace_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.recordIdColumnId, table.tableId, table.workspaceId],
      foreignColumns: [columns.id, columns.tableId, columns.workspaceId],
      name: 'writeback_destinations_record_id_column_scope_fk',
    }).onDelete('restrict'),
  ]
);

export const writebackDeliveries = sqliteTable(
  'writeback_deliveries',
  {
    id: text('id').primaryKey(),
    destinationId: text('destination_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    triggerMode: text('trigger_mode', { enum: triggerModes })
      .notNull()
      .default('manual'),
    filterTreeSnapshot: text('filter_tree_snapshot', {
      mode: 'json',
    }).$type<GridViewFilterGroup>(),
    payloadFingerprint: text('payload_fingerprint'),
    payload: text('payload', { mode: 'json' })
      .$type<WritebackPayload>()
      .notNull(),
    status: text('status', { enum: deliveryStatuses })
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    responseStatus: integer('response_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'writeback_deliveries_valid_state',
      sql`${table.triggerMode} in ('manual', 'row_settled') and ${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`
    ),
    check('writeback_deliveries_valid_attempt', sql`${table.attempt} >= 0`),
    check(
      'writeback_deliveries_valid_row_version',
      sql`${table.rowVersion} > 0`
    ),
    check(
      'writeback_deliveries_valid_response_status',
      sql`${table.responseStatus} is null or ${table.responseStatus} between 100 and 599`
    ),
    check(
      'writeback_deliveries_valid_fingerprint',
      sql`${table.payloadFingerprint} is null or (length(${table.payloadFingerprint}) = 64 and ${table.payloadFingerprint} not glob '*[^0-9a-f]*')`
    ),
    check(
      'writeback_deliveries_payload_json',
      sql`json_valid(${table.payload}) and json_type(${table.payload}) = 'object'`
    ),
    check(
      'writeback_deliveries_automatic_snapshot',
      sql`${table.triggerMode} = 'manual' or (${table.payloadFingerprint} is not null and json_valid(${table.filterTreeSnapshot}) and json_type(${table.filterTreeSnapshot}) = 'object')`
    ),
    index('writeback_deliveries_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('writeback_deliveries_destination_created_idx').on(
      table.destinationId,
      table.createdAt
    ),
    uniqueIndex('writeback_deliveries_settlement_unique')
      .on(table.destinationId, table.rowId, table.rowVersion)
      .where(sql`${table.triggerMode} = 'row_settled'`),
    uniqueIndex('writeback_deliveries_automatic_payload_unique')
      .on(table.destinationId, table.rowId, table.payloadFingerprint)
      .where(sql`${table.triggerMode} = 'row_settled'`),
    unique('writeback_deliveries_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.destinationId, table.tableId, table.workspaceId],
      foreignColumns: [
        writebackDestinations.id,
        writebackDestinations.tableId,
        writebackDestinations.workspaceId,
      ],
      name: 'writeback_deliveries_destination_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'writeback_deliveries_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

const rowSettlementStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;

export const rowSettlements = sqliteTable(
  'row_settlements',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    changedColumnIds: text('changed_column_ids', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default([]),
    consumedById: text('consumed_by_id'),
    status: text('status', { enum: rowSettlementStatuses })
      .notNull()
      .default('queued'),
    queuedDeliveryCount: integer('queued_delivery_count').notNull().default(0),
    queuedRunCount: integer('queued_run_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check('row_settlements_valid_version', sql`${table.rowVersion} > 0`),
    check(
      'row_settlements_changed_columns_json',
      sql`json_valid(${table.changedColumnIds}) and json_type(${table.changedColumnIds}) = 'array'`
    ),
    check(
      'row_settlements_valid_state',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'skipped')`
    ),
    check(
      'row_settlements_valid_delivery_count',
      sql`${table.queuedDeliveryCount} >= 0`
    ),
    check('row_settlements_valid_run_count', sql`${table.queuedRunCount} >= 0`),
    uniqueIndex('row_settlements_row_version_unique').on(
      table.rowId,
      table.rowVersion
    ),
    unique('row_settlements_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    index('row_settlements_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('row_settlements_status_created_idx').on(
      table.status,
      table.createdAt
    ),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'row_settlements_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

const bulkRunStatuses = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export const bulkRunBatches = sqliteTable(
  'bulk_run_batches',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    columnId: text('column_id').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    mode: text('mode', { enum: ['pending', 'all'] }).notNull(),
    status: text('status', { enum: bulkRunStatuses })
      .notNull()
      .default('queued'),
    selectedRowCount: integer('selected_row_count').notNull(),
    queuedRowCount: integer('queued_row_count').notNull().default(0),
    skippedRowCount: integer('skipped_row_count').notNull().default(0),
    estimatedProviderRequests: integer('estimated_provider_requests').notNull(),
    estimatedMaxOutputTokens: integer('estimated_max_output_tokens'),
    selectionSnapshot: text('selection_snapshot', { mode: 'json' })
      .$type<BulkRunSelectionSnapshot>()
      .notNull()
      .default({ kind: 'all_rows', searchQuery: null }),
    selectionDigest: text('selection_digest').notNull().default('0'.repeat(64)),
    cancelledByUserId: text('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'bulk_run_batches_valid_state',
      sql`${table.mode} in ('pending', 'all') and ${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`
    ),
    check(
      'bulk_run_batches_nonnegative_counts',
      sql`${table.selectedRowCount} >= 0 and ${table.queuedRowCount} >= 0 and ${table.skippedRowCount} >= 0 and ${table.estimatedProviderRequests} >= 0 and (${table.estimatedMaxOutputTokens} is null or ${table.estimatedMaxOutputTokens} >= 0)`
    ),
    check(
      'bulk_run_batches_processed_within_selected',
      sql`${table.queuedRowCount} + ${table.skippedRowCount} <= ${table.selectedRowCount}`
    ),
    check(
      'bulk_run_batches_selection_shape',
      sql`json_valid(${table.selectionSnapshot}) and json_type(${table.selectionSnapshot}) = 'object' and length(${table.selectionDigest}) = 64 and ${table.selectionDigest} not glob '*[^0-9a-f]*'`
    ),
    check(
      'bulk_run_batches_cancellation_state',
      sql`(${table.status} = 'cancelled' and ${table.cancelledAt} is not null) or (${table.status} <> 'cancelled' and ${table.cancelledAt} is null and ${table.cancelledByUserId} is null)`
    ),
    index('bulk_run_batches_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    index('bulk_run_batches_status_created_idx').on(
      table.status,
      table.createdAt
    ),
    unique('bulk_run_batches_id_workspace_unique').on(
      table.id,
      table.workspaceId
    ),
    foreignKey({
      columns: [table.tableId, table.workspaceId],
      foreignColumns: [dataTables.id, dataTables.workspaceId],
      name: 'bulk_run_batches_table_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.columnId, table.tableId, table.workspaceId],
      foreignColumns: [columns.id, columns.tableId, columns.workspaceId],
      name: 'bulk_run_batches_column_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const cellRuns = sqliteTable(
  'cell_runs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cellId: text('cell_id').notNull(),
    credentialId: text('credential_id'),
    connectorId: text('connector_id').notNull(),
    connectorVersion: text('connector_version').notNull().default('1.0.0'),
    artifactSha256: text('artifact_sha256'),
    registrySha256: text('registry_sha256'),
    publisherKeyIds: text('publisher_key_ids', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default([]),
    actionId: text('action_id').notNull(),
    input: text('input', { mode: 'json' }).$type<unknown>().notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    allowedHosts: text('allowed_hosts', { mode: 'json' })
      .$type<ReadonlyArray<string>>()
      .notNull(),
    status: text('status', { enum: deliveryStatuses })
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    output: text('output', { mode: 'json' }).$type<unknown>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    ...sqliteTimestamps(),
  },
  (table) => [
    check(
      'cell_runs_valid_state',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled') and ${table.attempt} >= 0`
    ),
    check(
      'cell_runs_json_arrays',
      sql`json_valid(${table.publisherKeyIds}) and json_type(${table.publisherKeyIds}) = 'array' and json_valid(${table.allowedHosts}) and json_type(${table.allowedHosts}) = 'array' and json_valid(${table.input})`
    ),
    check(
      'cell_runs_connector_digest_shape',
      sql`(${table.artifactSha256} is null or (length(${table.artifactSha256}) = 64 and ${table.artifactSha256} not glob '*[^0-9a-f]*')) and (${table.registrySha256} is null or (length(${table.registrySha256}) = 64 and ${table.registrySha256} not glob '*[^0-9a-f]*'))`
    ),
    index('cell_runs_cell_created_idx').on(table.cellId, table.createdAt),
    index('cell_runs_workspace_status_idx').on(table.workspaceId, table.status),
    unique('cell_runs_id_workspace_unique').on(table.id, table.workspaceId),
    foreignKey({
      columns: [table.cellId, table.workspaceId],
      foreignColumns: [cells.id, cells.workspaceId],
      name: 'cell_runs_cell_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.credentialId, table.workspaceId],
      foreignColumns: [credentials.id, credentials.workspaceId],
      name: 'cell_runs_credential_workspace_fk',
    }).onDelete('restrict'),
  ]
);

export const bulkRunItems = sqliteTable(
  'bulk_run_items',
  {
    batchId: text('batch_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    tableId: text('table_id').notNull(),
    rowId: text('row_id').notNull(),
    sequence: integer('sequence').notNull(),
    status: text('status', { enum: ['pending', 'queued', 'skipped'] })
      .notNull()
      .default('pending'),
    runId: text('run_id').references(() => cellRuns.id, {
      onDelete: 'set null',
    }),
    errorMessage: text('error_message'),
    ...sqliteTimestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.rowId] }),
    check('bulk_run_items_nonnegative_sequence', sql`${table.sequence} >= 0`),
    check(
      'bulk_run_items_valid_status',
      sql`${table.status} in ('pending', 'queued', 'skipped')`
    ),
    uniqueIndex('bulk_run_items_batch_sequence_unique').on(
      table.batchId,
      table.sequence
    ),
    index('bulk_run_items_batch_status_sequence_idx').on(
      table.batchId,
      table.status,
      table.sequence
    ),
    foreignKey({
      columns: [table.batchId, table.workspaceId],
      foreignColumns: [bulkRunBatches.id, bulkRunBatches.workspaceId],
      name: 'bulk_run_items_batch_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rowId, table.tableId, table.workspaceId],
      foreignColumns: [rows.id, rows.tableId, rows.workspaceId],
      name: 'bulk_run_items_row_scope_fk',
    }).onDelete('cascade'),
  ]
);

export const usageLedger = sqliteTable(
  'usage_ledger',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    connectorId: text('connector_id').notNull(),
    providerUnits: text('provider_units'),
    estimatedCostMicros: integer('estimated_cost_micros'),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    uniqueIndex('usage_ledger_run_unique').on(table.runId),
    index('usage_ledger_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [cellRuns.id, cellRuns.workspaceId],
      name: 'usage_ledger_run_workspace_fk',
    }).onDelete('cascade'),
  ]
);

export const outboxEvents = sqliteTable(
  'outbox_events',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    publishedAt: timestamp('published_at'),
    dispatchClaimId: text('dispatch_claim_id'),
    dispatchClaimedAt: timestamp('dispatch_claimed_at'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    dispatchNextAttemptAt: timestamp('dispatch_next_attempt_at'),
    dispatchLastError: text('dispatch_last_error'),
    analyticsClaimId: text('analytics_claim_id'),
    analyticsClaimedAt: timestamp('analytics_claimed_at'),
    analyticsProjectedAt: timestamp('analytics_projected_at'),
    analyticsAttempts: integer('analytics_attempts').notNull().default(0),
    analyticsNextAttemptAt: timestamp('analytics_next_attempt_at'),
    analyticsLastError: text('analytics_last_error'),
  },
  (table) => [
    check(
      'outbox_payload_json',
      sql`json_valid(${table.payload}) and json_type(${table.payload}) = 'object'`
    ),
    check(
      'outbox_dispatch_state',
      sql`${table.dispatchAttempts} >= 0 and ((${table.dispatchClaimId} is null and ${table.dispatchClaimedAt} is null) or (${table.dispatchClaimId} is not null and ${table.dispatchClaimedAt} is not null)) and (${table.dispatchLastError} is null or length(${table.dispatchLastError}) <= 500)`
    ),
    check(
      'outbox_analytics_projection_state',
      sql`${table.analyticsAttempts} >= 0 and ((${table.analyticsClaimId} is null and ${table.analyticsClaimedAt} is null) or (${table.analyticsClaimId} is not null and ${table.analyticsClaimedAt} is not null)) and (${table.analyticsLastError} is null or length(${table.analyticsLastError}) <= 500)`
    ),
    index('outbox_unpublished_idx').on(table.publishedAt, table.createdAt),
    index('outbox_dispatch_idx').on(
      table.publishedAt,
      table.dispatchNextAttemptAt,
      table.createdAt
    ),
    index('outbox_analytics_projection_idx').on(
      table.analyticsProjectedAt,
      table.analyticsNextAttemptAt,
      table.createdAt
    ),
    index('outbox_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);
