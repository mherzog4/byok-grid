import type { CryptoEnvelope } from '@byok-grid/security';
import type {
  BulkRunSelectionSnapshot,
  ConnectorRevocationTarget,
  GridViewFilterGroup,
  GridViewSort,
  HubSpotContactsSourceConfiguration,
  WebhookPayload,
  WritebackDestinationRequest,
  WritebackPayload,
  WorkspacePurgeImpact,
  WorkspacePurgeReason,
} from '@byok-grid/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const workspaceRole = pgEnum('workspace_role', [
  'owner',
  'admin',
  'member',
]);
export const columnKind = pgEnum('column_kind', [
  'input',
  'formula',
  'connector',
  'function',
]);
export const cellValueType = pgEnum('cell_value_type', [
  'empty',
  'text',
  'number',
  'boolean',
  'timestamp',
  'json',
]);
export const cellStatus = pgEnum('cell_status', [
  'idle',
  'queued',
  'running',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
]);
export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const importJobStatus = pgEnum('import_job_status', [
  'staging',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const bulkRunMode = pgEnum('bulk_run_mode', ['pending', 'all']);
export const bulkRunStatus = pgEnum('bulk_run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const bulkRunItemStatus = pgEnum('bulk_run_item_status', [
  'pending',
  'queued',
  'skipped',
]);
export const sourceDefinitionStatus = pgEnum('source_definition_status', [
  'active',
  'paused',
]);
export const sourcePaginationMode = pgEnum('source_pagination_mode', [
  'none',
  'cursor',
]);
export const sourceMissingRecordMode = pgEnum('source_missing_record_mode', [
  'preserve',
  'archive',
]);
export const sourceRunStatus = pgEnum('source_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const sourceRunTrigger = pgEnum('source_run_trigger', [
  'manual',
  'schedule',
]);
export const ingestionBatchStatus = pgEnum('ingestion_batch_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const webhookDestinationStatus = pgEnum('webhook_destination_status', [
  'active',
  'paused',
]);
export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const webhookTriggerMode = pgEnum('webhook_trigger_mode', [
  'manual',
  'row_settled',
]);
export const writebackDestinationStatus = pgEnum(
  'writeback_destination_status',
  ['active', 'paused']
);
export const writebackDeliveryStatus = pgEnum('writeback_delivery_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const rowSettlementStatus = pgEnum('row_settlement_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);

export type SchemaLifecycleAction =
  | 'column_archived'
  | 'column_restored'
  | 'column_type_converted'
  | 'table_archived'
  | 'table_restored';

export type SchemaLifecycleSnapshot = Readonly<Record<string, unknown>>;

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)]
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('sessions_token_unique').on(table.token),
    index('sessions_user_idx').on(table.userId),
  ]
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (table) => [
    index('accounts_user_idx').on(table.userId),
    uniqueIndex('accounts_provider_account_unique').on(
      table.providerId,
      table.accountId
    ),
  ]
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)]
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('rate_limits_key_unique').on(table.key)]
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)]
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_members_user_idx').on(table.userId),
  ]
);

export const workspacePurgeHolds = pgTable(
  'workspace_purge_holds',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    placedBy: text('placed_by').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
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

export const workspacePurgeReceipts = pgTable(
  'workspace_purge_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason').$type<WorkspacePurgeReason>().notNull(),
    previewDigest: text('preview_digest').notNull(),
    impact: jsonb('impact').$type<WorkspacePurgeImpact>().notNull(),
    purgedAt: timestamp('purged_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    analyticsEraseClaimId: uuid('analytics_erase_claim_id'),
    analyticsEraseClaimedAt: timestamp('analytics_erase_claimed_at', {
      withTimezone: true,
    }),
    analyticsEraseAttempts: integer('analytics_erase_attempts')
      .notNull()
      .default(0),
    analyticsEraseNextAttemptAt: timestamp('analytics_erase_next_attempt_at', {
      withTimezone: true,
    }),
    analyticsEraseLastError: text('analytics_erase_last_error'),
    analyticsErasedAt: timestamp('analytics_erased_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    check(
      'workspace_purge_receipts_reason',
      sql`${table.reason} in ('duplicate_workspace', 'test_data', 'user_requested', 'other')`
    ),
    check(
      'workspace_purge_receipts_digest',
      sql`${table.previewDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'workspace_purge_receipts_impact_shape',
      sql`jsonb_typeof(${table.impact}) = 'object'`
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

export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: workspaceRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('workspace_invitations_no_owner', sql`${table.role} <> 'owner'`),
    check(
      'workspace_invitations_token_hash_length',
      sql`length(${table.tokenHash}) = 64`
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

export const connectorRevocations = pgTable(
  'connector_revocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    target: jsonb('target').$type<ConnectorRevocationTarget>().notNull(),
    targetKey: text('target_key').notNull(),
    reason: text('reason').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedByUserId: uuid('lifted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    check(
      'connector_revocations_target_shape',
      sql`jsonb_typeof(${table.target}) = 'object' and case ${table.target}->>'kind'
        when 'publisher' then ${table.targetKey} = 'publisher:' || (${table.target}->>'publisherKeyId') and (${table.target}->>'publisherKeyId') ~ '^[a-z][a-z0-9_-]{0,63}$'
        when 'connector' then ${table.targetKey} = 'connector:' || (${table.target}->>'connectorId') and (${table.target}->>'connectorId') ~ '^[a-z][a-z0-9_-]{0,63}$'
        when 'version' then ${table.targetKey} = 'version:' || (${table.target}->>'connectorId') || '@' || (${table.target}->>'connectorVersion') and (${table.target}->>'connectorId') ~ '^[a-z][a-z0-9_-]{0,63}$' and (${table.target}->>'connectorVersion') ~ '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$'
        when 'artifact' then ${table.targetKey} = 'artifact:' || (${table.target}->>'artifactSha256') and (${table.target}->>'artifactSha256') ~ '^[0-9a-f]{64}$'
        else false end`
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

export const dataTables = pgTable(
  'data_tables',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByUserId: uuid('archived_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
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

export const columns = pgTable(
  'columns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    name: text('name').notNull(),
    kind: columnKind('kind').notNull(),
    valueType: cellValueType('value_type').notNull(),
    position: text('position').notNull(),
    configuration: jsonb('configuration')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByUserId: uuid('archived_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
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

export const savedGridViews = pgTable(
  'saved_grid_views',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    name: text('name').notNull(),
    filters: jsonb('filters')
      .$type<GridViewFilterGroup>()
      .notNull()
      .default({ children: [], combinator: 'and' }),
    sort: jsonb('sort').$type<GridViewSort | null>(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    check(
      'saved_grid_views_filter_shape',
      sql`jsonb_typeof(${table.filters}) = 'object' and ${table.filters} ? 'combinator' and jsonb_typeof(${table.filters}->'children') = 'array'`
    ),
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

export const columnDependencies = pgTable(
  'column_dependencies',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    columnId: uuid('column_id').notNull(),
    dependsOnColumnId: uuid('depends_on_column_id').notNull(),
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

export const schemaLifecycleEvents = pgTable(
  'schema_lifecycle_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    columnId: uuid('column_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').$type<SchemaLifecycleAction>().notNull(),
    snapshot: jsonb('snapshot').$type<SchemaLifecycleSnapshot>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
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

export const rows = pgTable(
  'rows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    position: text('position').notNull(),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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

export const cells = pgTable(
  'cells',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    rowId: uuid('row_id').notNull(),
    columnId: uuid('column_id').notNull(),
    valueType: cellValueType('value_type').notNull().default('empty'),
    valueText: text('value_text'),
    valueNumber: numeric('value_number'),
    valueBoolean: boolean('value_boolean'),
    valueTimestamp: timestamp('value_timestamp', { withTimezone: true }),
    valueJson: jsonb('value_json'),
    searchText: text('search_text').notNull().default(''),
    status: cellStatus('status').notNull().default('idle'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
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
    index('cells_search_text_trgm_idx')
      .using('gin', table.searchText.asc().op('gin_trgm_ops'))
      .where(sql`${table.searchText} <> ''`),
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

export type CsvImportColumnMapping = ReadonlyArray<
  Readonly<{ columnId: string; header: string }>
>;

export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    filename: text('filename').notNull(),
    status: importJobStatus('status').notNull().default('staging'),
    headers: text('headers').array().notNull().default([]),
    columnMapping: jsonb('column_mapping').$type<CsvImportColumnMapping>(),
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' })
      .notNull()
      .default(0),
    stagedRowCount: integer('staged_row_count').notNull().default(0),
    importedRowCount: integer('imported_row_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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

export const importStagedRows = pgTable(
  'import_staged_rows',
  {
    importJobId: uuid('import_job_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    values: text('values').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.importJobId, table.rowNumber] }),
    check('import_staged_rows_positive_number', sql`${table.rowNumber} > 0`),
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

export const workspaceKeys = pgTable('workspace_keys', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  wrappedKey: jsonb('wrapped_key').$type<CryptoEnvelope>().notNull(),
  keyId: text('key_id').notNull(),
  ...timestamps,
});

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    connectorId: text('connector_id').notNull(),
    encryptedValue: jsonb('encrypted_value').$type<CryptoEnvelope>().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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

export const sourceDefinitions = pgTable(
  'source_definitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    adapterId: text('adapter_id').notNull().default('http_json'),
    adapterConfiguration: jsonb(
      'adapter_configuration'
    ).$type<HubSpotContactsSourceConfiguration>(),
    endpointUrl: text('endpoint_url').notNull(),
    credentialId: uuid('credential_id'),
    recordPath: text('record_path').notNull().default(''),
    recordKeyField: text('record_key_field').notNull(),
    maxRecords: integer('max_records').notNull().default(1_000),
    missingRecordMode: sourceMissingRecordMode('missing_record_mode')
      .notNull()
      .default('preserve'),
    paginationMode: sourcePaginationMode('pagination_mode')
      .notNull()
      .default('none'),
    cursorParameter: text('cursor_parameter'),
    nextCursorPath: text('next_cursor_path'),
    maxPages: integer('max_pages').notNull().default(1),
    fieldMapping: jsonb('field_mapping').$type<SourceFieldMapping>(),
    status: sourceDefinitionStatus('status').notNull().default('active'),
    scheduleIntervalMinutes: integer('schedule_interval_minutes'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    incrementalWatermark: timestamp('incremental_watermark', {
      withTimezone: true,
    }),
    ...timestamps,
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
      sql`(${table.adapterId} = 'http_json' and ${table.adapterConfiguration} is null and ${table.incrementalWatermark} is null) or (${table.adapterId} = 'hubspot_contacts' and jsonb_typeof(${table.adapterConfiguration}) = 'object' and ${table.credentialId} is not null and ${table.missingRecordMode} = 'preserve' and ${table.paginationMode} = 'cursor')`
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

export const sourceRuns = pgTable(
  'source_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    trigger: sourceRunTrigger('trigger').notNull(),
    status: sourceRunStatus('status').notNull().default('queued'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    attempt: integer('attempt').notNull().default(0),
    pageCount: integer('page_count').notNull().default(0),
    nextCursorEncrypted: jsonb('next_cursor_encrypted').$type<CryptoEnvelope>(),
    incrementalWindowStart: timestamp('incremental_window_start', {
      withTimezone: true,
    }),
    incrementalWindowEnd: timestamp('incremental_window_end', {
      withTimezone: true,
    }),
    receivedRecordCount: integer('received_record_count').notNull().default(0),
    createdRowCount: integer('created_row_count').notNull().default(0),
    updatedRowCount: integer('updated_row_count').notNull().default(0),
    archivedRowCount: integer('archived_row_count').notNull().default(0),
    restoredRowCount: integer('restored_row_count').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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

export const sourceRecords = pgTable(
  'source_records',
  {
    sourceId: uuid('source_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    recordKey: text('record_key').notNull(),
    rowId: uuid('row_id').notNull(),
    lastSeenRunId: uuid('last_seen_run_id').references(() => sourceRuns.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByRunId: uuid('archived_by_run_id').references(
      () => sourceRuns.id,
      { onDelete: 'restrict' }
    ),
    ...timestamps,
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

export const ingestionEndpoints = pgTable(
  'ingestion_endpoints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    recordKeyField: text('record_key_field').notNull(),
    fieldMapping: jsonb('field_mapping').$type<SourceFieldMapping>(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'ingestion_endpoints_token_hash_length',
      sql`length(${table.tokenHash}) = 64 and ${table.tokenHash} ~ '^[0-9a-f]{64}$'`
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

export const ingestionBatches = pgTable(
  'ingestion_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    endpointId: uuid('endpoint_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    status: ingestionBatchStatus('status').notNull().default('queued'),
    fields: text('fields').array().notNull(),
    recordCount: integer('record_count').notNull(),
    processedRecordCount: integer('processed_record_count')
      .notNull()
      .default(0),
    createdRowCount: integer('created_row_count').notNull().default(0),
    updatedRowCount: integer('updated_row_count').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'ingestion_batches_nonnegative_counts',
      sql`${table.recordCount} between 1 and 1000 and ${table.processedRecordCount} between 0 and ${table.recordCount} and ${table.createdRowCount} >= 0 and ${table.updatedRowCount} >= 0 and ${table.createdRowCount} + ${table.updatedRowCount} <= ${table.processedRecordCount} and ${table.attempt} >= 0`
    ),
    check(
      'ingestion_batches_request_digest_length',
      sql`length(${table.requestDigest}) = 64 and ${table.requestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'ingestion_batches_payload_shape',
      sql`cardinality(${table.fields}) between 1 and 100 and length(${table.idempotencyKey}) between 8 and 200`
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

export type IngestionStagedValues = Readonly<Record<string, string | null>>;

export const ingestionStagedRecords = pgTable(
  'ingestion_staged_records',
  {
    batchId: uuid('batch_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    recordKey: text('record_key').notNull(),
    values: jsonb('values').$type<IngestionStagedValues>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
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
      sql`jsonb_typeof(${table.values}) = 'object' and pg_column_size(${table.values}) <= 262144`
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

export const ingestionRecords = pgTable(
  'ingestion_records',
  {
    endpointId: uuid('endpoint_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    recordKey: text('record_key').notNull(),
    rowId: uuid('row_id').notNull(),
    lastBatchId: uuid('last_batch_id').references(() => ingestionBatches.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
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

export const webhookDestinations = pgTable(
  'webhook_destinations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    signingCredentialId: uuid('signing_credential_id').notNull(),
    status: webhookDestinationStatus('status').notNull().default('active'),
    triggerMode: webhookTriggerMode('trigger_mode').notNull().default('manual'),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    destinationId: uuid('destination_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    rowId: uuid('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    triggerMode: webhookTriggerMode('trigger_mode').notNull().default('manual'),
    payload: jsonb('payload').$type<WebhookPayload>().notNull(),
    status: webhookDeliveryStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    responseStatus: integer('response_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('webhook_deliveries_valid_attempt', sql`${table.attempt} >= 0`),
    check('webhook_deliveries_valid_row_version', sql`${table.rowVersion} > 0`),
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

export const writebackDestinations = pgTable(
  'writeback_destinations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    adapterId: text('adapter_id').notNull().default('hubspot_contact'),
    credentialId: uuid('credential_id').notNull(),
    recordIdColumnId: uuid('record_id_column_id').notNull(),
    fieldMappings: jsonb('field_mappings')
      .$type<WritebackDestinationRequest['fieldMappings']>()
      .notNull(),
    filterTree: jsonb('filter_tree')
      .$type<GridViewFilterGroup>()
      .notNull()
      .default({ children: [], combinator: 'and' }),
    status: writebackDestinationStatus('status').notNull().default('active'),
    triggerMode: webhookTriggerMode('trigger_mode').notNull().default('manual'),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'writeback_destinations_supported_adapter',
      sql`${table.adapterId} = 'hubspot_contact'`
    ),
    check(
      'writeback_destinations_filter_shape',
      sql`jsonb_typeof(${table.filterTree}) = 'object' and ${table.filterTree} ? 'combinator' and jsonb_typeof(${table.filterTree}->'children') = 'array'`
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

export const writebackDeliveries = pgTable(
  'writeback_deliveries',
  {
    id: uuid('id').primaryKey(),
    destinationId: uuid('destination_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    rowId: uuid('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    triggerMode: webhookTriggerMode('trigger_mode').notNull().default('manual'),
    filterTreeSnapshot: jsonb(
      'filter_tree_snapshot'
    ).$type<GridViewFilterGroup>(),
    payloadFingerprint: text('payload_fingerprint'),
    payload: jsonb('payload').$type<WritebackPayload>().notNull(),
    status: writebackDeliveryStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    responseStatus: integer('response_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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
      sql`${table.payloadFingerprint} is null or ${table.payloadFingerprint} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'writeback_deliveries_automatic_snapshot',
      sql`${table.triggerMode} = 'manual' or (${table.payloadFingerprint} is not null and jsonb_typeof(${table.filterTreeSnapshot}) = 'object')`
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

export const rowSettlements = pgTable(
  'row_settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    rowId: uuid('row_id').notNull(),
    rowVersion: integer('row_version').notNull(),
    changedColumnIds: uuid('changed_column_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    consumedById: uuid('consumed_by_id'),
    status: rowSettlementStatus('status').notNull().default('queued'),
    queuedDeliveryCount: integer('queued_delivery_count').notNull().default(0),
    queuedRunCount: integer('queued_run_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('row_settlements_valid_version', sql`${table.rowVersion} > 0`),
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

export const bulkRunBatches = pgTable(
  'bulk_run_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id').notNull(),
    columnId: uuid('column_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    mode: bulkRunMode('mode').notNull(),
    status: bulkRunStatus('status').notNull().default('queued'),
    selectedRowCount: integer('selected_row_count').notNull(),
    queuedRowCount: integer('queued_row_count').notNull().default(0),
    skippedRowCount: integer('skipped_row_count').notNull().default(0),
    estimatedProviderRequests: integer('estimated_provider_requests').notNull(),
    estimatedMaxOutputTokens: bigint('estimated_max_output_tokens', {
      mode: 'number',
    }),
    selectionSnapshot: jsonb('selection_snapshot')
      .$type<BulkRunSelectionSnapshot>()
      .notNull()
      .default({ kind: 'all_rows', searchQuery: null }),
    selectionDigest: text('selection_digest')
      .notNull()
      .default(
        '0000000000000000000000000000000000000000000000000000000000000000'
      ),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
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
      sql`jsonb_typeof(${table.selectionSnapshot}) = 'object' and ${table.selectionDigest} ~ '^[0-9a-f]{64}$'`
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

export const cellRuns = pgTable(
  'cell_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id').notNull(),
    credentialId: uuid('credential_id'),
    connectorId: text('connector_id').notNull(),
    connectorVersion: text('connector_version').notNull().default('1.0.0'),
    artifactSha256: text('artifact_sha256'),
    registrySha256: text('registry_sha256'),
    publisherKeyIds: text('publisher_key_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    actionId: text('action_id').notNull(),
    input: jsonb('input').$type<unknown>().notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    allowedHosts: text('allowed_hosts').array().notNull(),
    status: runStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    output: jsonb('output').$type<unknown>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check(
      'cell_runs_connector_digest_shape',
      sql`(${table.artifactSha256} is null or ${table.artifactSha256} ~ '^[0-9a-f]{64}$') and (${table.registrySha256} is null or ${table.registrySha256} ~ '^[0-9a-f]{64}$')`
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

export const bulkRunItems = pgTable(
  'bulk_run_items',
  {
    batchId: uuid('batch_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    tableId: uuid('table_id').notNull(),
    rowId: uuid('row_id').notNull(),
    sequence: integer('sequence').notNull(),
    status: bulkRunItemStatus('status').notNull().default('pending'),
    runId: uuid('run_id').references(() => cellRuns.id, {
      onDelete: 'set null',
    }),
    errorMessage: text('error_message'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.rowId] }),
    check('bulk_run_items_nonnegative_sequence', sql`${table.sequence} >= 0`),
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

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    connectorId: text('connector_id').notNull(),
    providerUnits: text('provider_units'),
    estimatedCostMicros: bigint('estimated_cost_micros', {
      mode: 'number',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
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

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    dispatchClaimId: uuid('dispatch_claim_id'),
    dispatchClaimedAt: timestamp('dispatch_claimed_at', {
      withTimezone: true,
    }),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    dispatchNextAttemptAt: timestamp('dispatch_next_attempt_at', {
      withTimezone: true,
    }),
    dispatchLastError: text('dispatch_last_error'),
    analyticsClaimId: uuid('analytics_claim_id'),
    analyticsClaimedAt: timestamp('analytics_claimed_at', {
      withTimezone: true,
    }),
    analyticsProjectedAt: timestamp('analytics_projected_at', {
      withTimezone: true,
    }),
    analyticsAttempts: integer('analytics_attempts').notNull().default(0),
    analyticsNextAttemptAt: timestamp('analytics_next_attempt_at', {
      withTimezone: true,
    }),
    analyticsLastError: text('analytics_last_error'),
  },
  (table) => [
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
