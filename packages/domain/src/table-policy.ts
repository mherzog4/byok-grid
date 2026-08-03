import { z } from 'zod';
import { editableInputValueTypeSchema } from './cell-values';

export const MAXIMUM_WORKSPACE_TABLES = 100;
export const MAXIMUM_TABLE_COLUMNS = 256;

const displayNameSchema = z
  .string()
  .transform((value) => value.trim().normalize('NFKC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(120)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        'Names cannot contain control characters.'
      )
  );

export const createTableRequestSchema = z.strictObject({
  firstColumnName: displayNameSchema,
  firstColumnValueType: editableInputValueTypeSchema.default('text'),
  name: displayNameSchema,
});

export type CreateTableRequest = z.infer<typeof createTableRequestSchema>;

export const updateTableRequestSchema = z.strictObject({
  name: displayNameSchema,
});

export const createInputColumnRequestSchema = z.strictObject({
  name: displayNameSchema,
  valueType: editableInputValueTypeSchema.default('text'),
});

export const schemaArchiveRequestSchema = z.strictObject({
  confirmationName: displayNameSchema,
});

export type SchemaArchiveRequest = z.infer<typeof schemaArchiveRequestSchema>;

export const columnTypeConversionPreviewRequestSchema = z.strictObject({
  targetType: editableInputValueTypeSchema,
});

export const columnTypeConversionRequestSchema = z.strictObject({
  confirmationName: displayNameSchema,
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  targetType: editableInputValueTypeSchema,
});

export type ColumnTypeConversionRequest = z.infer<
  typeof columnTypeConversionRequestSchema
>;

/**
 * CONTRIBUTOR DECISION POINT: a generic table currently starts with "Name".
 * This seam can infer a singular label from the table name once that behavior
 * is specified without coupling table creation to company-centric defaults.
 */
export function defaultFirstColumnName(_tableName: string): string {
  return 'Name';
}
