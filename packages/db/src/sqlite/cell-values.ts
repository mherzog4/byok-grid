import { cellValueSchema, type CellValue } from '@byok-grid/domain';
import { cells } from './schema';

export function serializeSqliteCellValue(value: CellValue) {
  return {
    valueBoolean: value.type === 'boolean' ? value.value : null,
    valueJson: value.type === 'json' ? value.value : null,
    valueNumber: value.type === 'number' ? value.value : null,
    valueText: value.type === 'text' ? value.value : null,
    valueTimestamp: value.type === 'timestamp' ? new Date(value.value) : null,
    valueType: value.type,
  } as const;
}

export function deserializeSqliteCellValue(
  cell: typeof cells.$inferSelect
): CellValue {
  switch (cell.valueType) {
    case 'empty':
      return { type: 'empty', value: null };
    case 'text':
      return { type: 'text', value: cell.valueText ?? '' };
    case 'number':
      return { type: 'number', value: cell.valueNumber ?? 0 };
    case 'boolean':
      return { type: 'boolean', value: cell.valueBoolean ?? false };
    case 'timestamp':
      return {
        type: 'timestamp',
        value: (cell.valueTimestamp ?? new Date(0)).toISOString(),
      };
    case 'json':
      return cellValueSchema.parse({ type: 'json', value: cell.valueJson });
  }
}
