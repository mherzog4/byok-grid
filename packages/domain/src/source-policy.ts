import { z } from 'zod';
import { vaultSafeHttpsUrlSchema } from './endpoint-policy';

export const sourceScheduleSchema = z.enum([
  'manual',
  'every_15_minutes',
  'hourly',
  'every_6_hours',
  'daily',
]);

export type SourceSchedule = z.infer<typeof sourceScheduleSchema>;

export const sourceMissingRecordModeSchema = z.enum(['preserve', 'archive']);
export type SourceMissingRecordMode = z.infer<
  typeof sourceMissingRecordModeSchema
>;

export const SOURCE_SCHEDULE_MINUTES: Readonly<
  Record<Exclude<SourceSchedule, 'manual'>, number>
> = {
  every_15_minutes: 15,
  hourly: 60,
  every_6_hours: 360,
  daily: 1_440,
};

const sourceFieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    'Field names cannot contain control characters.'
  );

const responsePathSchema = z
  .string()
  .trim()
  .max(240)
  .refine(
    (value) =>
      value === '' ||
      value
        .split('.')
        .every(
          (segment) =>
            /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) &&
            !['__proto__', 'constructor', 'prototype'].includes(segment)
        ),
    'The record path must be a dot-separated property path.'
  );

const httpsSourceUrlSchema = vaultSafeHttpsUrlSchema('Source');

const cursorParameterSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
  .refine(
    (value) =>
      !['access_token', 'api_key', 'apikey', 'key', 'secret', 'sig', 'token']
        .map((item) => item.replace(/[_.-]/g, ''))
        .includes(value.toLocaleLowerCase('en-US').replace(/[_.-]/g, '')),
    'Cursor parameter names cannot look like credential fields.'
  );

export const sourcePaginationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    cursorParameter: cursorParameterSchema.default('cursor'),
    maxPages: z.number().int().min(2).max(25).default(10),
    mode: z.literal('cursor'),
    nextCursorPath: responsePathSchema.refine(
      (value) => value.length > 0,
      'A cursor response path is required.'
    ),
  }),
]);

export type SourcePagination = z.infer<typeof sourcePaginationSchema>;

export const httpJsonSourceRequestSchema = z
  .strictObject({
    credentialId: z.string().uuid().nullable().default(null),
    maxRecords: z.number().int().min(1).max(5_000).default(1_000),
    missingRecordMode: sourceMissingRecordModeSchema.default('preserve'),
    name: z.string().trim().min(1).max(120),
    pagination: sourcePaginationSchema.default({ mode: 'none' }),
    recordKeyField: sourceFieldNameSchema,
    recordPath: responsePathSchema.default(''),
    schedule: sourceScheduleSchema.default('manual'),
    url: httpsSourceUrlSchema,
  })
  .superRefine((source, context) => {
    if (
      source.pagination.mode === 'cursor' &&
      hasQueryParameter(source.url, source.pagination.cursorParameter)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The source URL already contains the cursor parameter.',
        path: ['url'],
      });
    }
  });

export type HttpJsonSourceRequest = z.infer<typeof httpJsonSourceRequestSchema>;

export const HUBSPOT_CONTACT_ID_FIELD = 'hubspot_contact_id';
export const HUBSPOT_CONTACT_CREATED_AT_FIELD = 'hubspot_created_at';
export const HUBSPOT_CONTACT_UPDATED_AT_FIELD = 'hubspot_updated_at';
export const HUBSPOT_CONTACT_ARCHIVED_FIELD = 'hubspot_archived';
export const HUBSPOT_INCREMENTAL_SAFETY_LAG_MS = 5 * 60_000;

const hubSpotPropertyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'HubSpot property names must use lowercase letters, numbers, and underscores.'
  )
  .refine(
    (value) =>
      ![
        HUBSPOT_CONTACT_ID_FIELD,
        HUBSPOT_CONTACT_CREATED_AT_FIELD,
        HUBSPOT_CONTACT_UPDATED_AT_FIELD,
        HUBSPOT_CONTACT_ARCHIVED_FIELD,
      ].includes(value.toLocaleLowerCase('en-US')),
    'HubSpot properties cannot use a reserved source field name.'
  );

export const hubSpotContactsSourceConfigurationSchema = z.strictObject({
  initialSyncFrom: z.iso.datetime(),
  properties: z.array(hubSpotPropertyNameSchema).min(1).max(50),
});

export const hubSpotContactsSourceRequestSchema = z
  .strictObject({
    credentialId: z.string().uuid(),
    initialSyncFrom:
      hubSpotContactsSourceConfigurationSchema.shape.initialSyncFrom,
    maxPages: z.number().int().min(2).max(25).default(10),
    maxRecords: z.number().int().min(1).max(5_000).default(1_000),
    name: z.string().trim().min(1).max(120),
    properties: hubSpotContactsSourceConfigurationSchema.shape.properties,
    schedule: sourceScheduleSchema.default('manual'),
  })
  .superRefine((source, context) => {
    const normalized = source.properties.map((property) =>
      property.toLocaleLowerCase('en-US')
    );
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: 'custom',
        message: 'HubSpot properties must be unique.',
        path: ['properties'],
      });
    }
  });

export type HubSpotContactsSourceRequest = z.infer<
  typeof hubSpotContactsSourceRequestSchema
>;

export type HubSpotContactsSourceConfiguration = z.infer<
  typeof hubSpotContactsSourceConfigurationSchema
>;

export function shouldArchiveMissingSourceRecords(input: {
  completed: boolean;
  mode: SourceMissingRecordMode;
}): boolean {
  return input.completed && input.mode === 'archive';
}

export const sourceRunInputSchema = z.strictObject({
  sourceId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  tableId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

export type SourceRunInput = z.infer<typeof sourceRunInputSchema>;

export type NormalizedSourceRecord = Readonly<{
  key: string;
  values: Readonly<Record<string, string | null>>;
}>;

export type NormalizedSourceBatch = Readonly<{
  fields: readonly string[];
  records: readonly NormalizedSourceRecord[];
}>;

export type NormalizedHubSpotContactsPage = Readonly<{
  batch: NormalizedSourceBatch;
  nextCursor: string | null;
}>;

export class SourceResponseError extends Error {}

export type SourcePageRequestDecision =
  | { kind: 'continue' }
  | { kind: 'blocked'; reason: 'page_limit' | 'record_limit' };

export function decideSourcePageRequest(input: {
  maxPages: number;
  maxRecords: number;
  pageCount: number;
  receivedRecordCount: number;
}): SourcePageRequestDecision {
  // CONTRIBUTOR DECISION POINT: the safe default fails a partially applied run
  // instead of presenting truncated data as a successful full synchronization.
  if (input.pageCount >= input.maxPages) {
    return { kind: 'blocked', reason: 'page_limit' };
  }
  if (input.receivedRecordCount >= input.maxRecords) {
    return { kind: 'blocked', reason: 'record_limit' };
  }
  return { kind: 'continue' };
}

export function scheduleIntervalMinutes(
  schedule: SourceSchedule
): number | null {
  return schedule === 'manual' ? null : SOURCE_SCHEDULE_MINUTES[schedule];
}

/**
 * Coalesces missed intervals into one future occurrence. This prevents a
 * deployment that was offline from replaying a costly backlog on startup.
 *
 * TODO(product owner): decide whether enterprise operators need an opt-in
 * catch-up mode that queues a bounded number of missed runs instead.
 */
export function nextScheduledSourceRun(
  scheduledFor: Date,
  intervalMinutes: number,
  now: Date
): Date {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new RangeError('Source schedules must be at least five minutes.');
  }
  const intervalMs = intervalMinutes * 60_000;
  const elapsed = now.getTime() - scheduledFor.getTime();
  const intervals = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(scheduledFor.getTime() + intervals * intervalMs);
}

export function normalizeHttpJsonSourceResponse(
  body: unknown,
  input: { maxRecords: number; recordKeyField: string; recordPath: string }
): NormalizedSourceBatch {
  const recordsValue = resolveRecordPath(body, input.recordPath);
  if (!Array.isArray(recordsValue)) {
    throw new SourceResponseError(
      'The configured record path is not an array.'
    );
  }
  if (recordsValue.length > input.maxRecords) {
    throw new SourceResponseError(
      `The source returned more than ${input.maxRecords} records.`
    );
  }

  const fields: string[] = [];
  const knownFields = new Set<string>();
  const canonicalFieldByNormalized = new Map<string, string>();
  const keys = new Set<string>();
  const records = recordsValue.map((value, index) => {
    if (!isRecord(value)) {
      throw new SourceResponseError(
        `Source record ${index + 1} is not an object.`
      );
    }
    const normalizedValues: Record<string, string | null> = {};
    const recordFields = new Set<string>();
    for (const [field, fieldValue] of Object.entries(value)) {
      const parsedField = sourceFieldNameSchema.safeParse(field);
      if (!parsedField.success) {
        throw new SourceResponseError(
          `Source record ${index + 1} contains an invalid field name.`
        );
      }
      const normalizedField = normalizeFieldName(field);
      if (recordFields.has(normalizedField)) {
        throw new SourceResponseError(
          `Source record ${index + 1} repeats a field with different casing.`
        );
      }
      recordFields.add(normalizedField);
      if (!knownFields.has(normalizedField)) {
        if (fields.length >= 100) {
          throw new SourceResponseError(
            'A source cannot expose more than 100 fields.'
          );
        }
        fields.push(field);
        knownFields.add(normalizedField);
        canonicalFieldByNormalized.set(normalizedField, field);
      }
      normalizedValues[canonicalFieldByNormalized.get(normalizedField)!] =
        normalizeScalar(fieldValue, index);
    }

    const keyField = canonicalFieldByNormalized.get(
      normalizeFieldName(input.recordKeyField)
    );
    const keyValue = keyField ? normalizedValues[keyField] : undefined;
    if (keyValue === null || keyValue === undefined || keyValue.trim() === '') {
      throw new SourceResponseError(
        `Source record ${index + 1} has no usable ${input.recordKeyField} key.`
      );
    }
    const key = keyValue.trim();
    if (key.length > 500) {
      throw new SourceResponseError(
        'Source record keys cannot exceed 500 characters.'
      );
    }
    if (keys.has(key)) {
      throw new SourceResponseError(
        `The source returned duplicate record key “${key}”.`
      );
    }
    keys.add(key);
    return { key, values: normalizedValues };
  });

  return { fields, records };
}

export function normalizeHubSpotContactsSourceResponse(
  body: unknown,
  input: { maxRecords: number; properties: readonly string[] }
): NormalizedHubSpotContactsPage {
  const response = hubSpotContactsPageSchema.safeParse(body);
  if (!response.success) {
    throw new SourceResponseError(
      'HubSpot returned an invalid contacts search response.'
    );
  }
  if (response.data.results.length > input.maxRecords) {
    throw new SourceResponseError(
      `HubSpot returned more than ${input.maxRecords} contacts.`
    );
  }
  const keys = new Set<string>();
  const records = response.data.results.map((contact) => {
    if (keys.has(contact.id)) {
      throw new SourceResponseError(
        `HubSpot returned duplicate contact ID “${contact.id}”.`
      );
    }
    keys.add(contact.id);
    const values: Record<string, string | null> = {
      [HUBSPOT_CONTACT_ID_FIELD]: contact.id,
    };
    for (const property of input.properties) {
      values[property] = contact.properties[property] ?? null;
    }
    values[HUBSPOT_CONTACT_CREATED_AT_FIELD] = contact.createdAt;
    values[HUBSPOT_CONTACT_UPDATED_AT_FIELD] = contact.updatedAt;
    values[HUBSPOT_CONTACT_ARCHIVED_FIELD] = contact.archived
      ? 'true'
      : 'false';
    return { key: contact.id, values };
  });
  const nextCursor = response.data.paging?.next?.after ?? null;
  if (
    nextCursor !== null &&
    (nextCursor.length === 0 ||
      nextCursor.length > 1_024 ||
      /\p{Cc}/u.test(nextCursor))
  ) {
    throw new SourceResponseError('HubSpot returned an invalid paging cursor.');
  }
  return {
    batch: {
      fields: [
        HUBSPOT_CONTACT_ID_FIELD,
        ...input.properties,
        HUBSPOT_CONTACT_CREATED_AT_FIELD,
        HUBSPOT_CONTACT_UPDATED_AT_FIELD,
        HUBSPOT_CONTACT_ARCHIVED_FIELD,
      ],
      records,
    },
    nextCursor,
  };
}

export function extractNextSourceCursor(
  body: unknown,
  path: string
): string | null {
  const rawCursor = resolveResponsePath(body, path, 'cursor');
  if (rawCursor === null || rawCursor === undefined || rawCursor === '') {
    return null;
  }
  const cursor =
    typeof rawCursor === 'string'
      ? rawCursor
      : typeof rawCursor === 'number' && Number.isFinite(rawCursor)
        ? String(rawCursor)
        : null;
  if (cursor === null || cursor.trim() === '') {
    throw new SourceResponseError(
      'The configured next-cursor value is not a string or finite number.'
    );
  }
  if (cursor.length > 1_024 || /\p{Cc}/u.test(cursor)) {
    throw new SourceResponseError('The next cursor is invalid or too large.');
  }
  return cursor;
}

function resolveRecordPath(body: unknown, path: string): unknown {
  if (!path) return body;
  return resolveResponsePath(body, path, 'record');
}

function resolveResponsePath(
  body: unknown,
  path: string,
  subject: 'cursor' | 'record'
): unknown {
  let value = body;
  for (const segment of path.split('.')) {
    if (
      !isRecord(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      throw new SourceResponseError(
        `The source response has no “${path}” ${subject} path.`
      );
    }
    value = value[segment];
  }
  return value;
}

function normalizeScalar(value: unknown, recordIndex: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new SourceResponseError(
    `Source record ${recordIndex + 1} contains a nested or unsupported value.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFieldName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function hasQueryParameter(url: string, expectedName: string): boolean {
  const query = url.split('?', 2)[1];
  if (!query) return false;
  return query.split('&').some((parameter) => {
    try {
      return (
        decodeURIComponent(parameter.split('=', 1)[0] ?? '') === expectedName
      );
    } catch {
      return true;
    }
  });
}

const hubSpotContactsPageSchema = z.looseObject({
  paging: z
    .looseObject({
      next: z.looseObject({ after: z.string().max(1_024) }).optional(),
    })
    .optional(),
  results: z.array(
    z.looseObject({
      archived: z.boolean(),
      createdAt: z.iso.datetime(),
      id: z.string().trim().min(1).max(128),
      properties: z.record(z.string(), z.string().nullable()),
      updatedAt: z.iso.datetime(),
    })
  ),
});
