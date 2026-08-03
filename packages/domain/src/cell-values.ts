import { z } from 'zod';

export const MAXIMUM_EDITABLE_CELL_BYTES = 256 * 1_024;

export const editableInputValueTypeSchema = z.enum([
  'text',
  'number',
  'boolean',
  'timestamp',
  'json',
]);

export type EditableInputValueType = z.infer<
  typeof editableInputValueTypeSchema
>;

export const cellValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('empty'), value: z.null() }),
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('number'), value: z.number().finite() }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({ type: z.literal('timestamp'), value: z.iso.datetime() }),
  z.object({ type: z.literal('json'), value: z.json() }),
]);

export type CellValue = z.infer<typeof cellValueSchema>;
export type CellValueType = CellValue['type'];

export const editableCellValueSchema = cellValueSchema.refine(
  (value) => editableCellByteLength(value) <= MAXIMUM_EDITABLE_CELL_BYTES,
  `Cell values cannot exceed ${MAXIMUM_EDITABLE_CELL_BYTES} bytes.`
);

export function parseEditableCellDraft(
  valueType: EditableInputValueType,
  draft: string
): CellValue {
  if (utf8ByteLength(draft) > MAXIMUM_EDITABLE_CELL_BYTES) {
    throw new TypeError(
      `Cell values cannot exceed ${MAXIMUM_EDITABLE_CELL_BYTES} bytes.`
    );
  }
  if (draft === '' || (valueType !== 'text' && draft.trim() === '')) {
    return { type: 'empty', value: null };
  }

  let candidate: CellValue;
  switch (valueType) {
    case 'text':
      candidate = { type: 'text', value: draft };
      break;
    case 'number': {
      const value = Number(draft);
      if (!Number.isFinite(value)) {
        throw new TypeError('Enter a finite number.');
      }
      candidate = { type: 'number', value };
      break;
    }
    case 'boolean':
      if (draft !== 'true' && draft !== 'false') {
        throw new TypeError('Choose true, false, or empty.');
      }
      candidate = { type: 'boolean', value: draft === 'true' };
      break;
    case 'timestamp': {
      candidate = {
        type: 'timestamp',
        value: normalizeEditableTimestamp(draft),
      };
      break;
    }
    case 'json':
      try {
        candidate = {
          type: 'json',
          value: z.json().parse(JSON.parse(draft)),
        };
      } catch (error) {
        throw new TypeError('Enter valid JSON.', { cause: error });
      }
      break;
  }
  return editableCellValueSchema.parse(candidate);
}

export function normalizeEditableTimestamp(draft: string): string {
  // CONTRIBUTOR DECISION POINT: offset-free drafts use the runtime's local zone.
  const value = new Date(draft);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Enter a valid date and time.');
  }
  return value.toISOString();
}

export function formatEditableCellDraft(value: CellValue | undefined): string {
  if (!value || value.type === 'empty') return '';
  if (value.type === 'json') return JSON.stringify(value.value);
  return String(value.value);
}

function editableCellByteLength(value: CellValue): number {
  if (value.type === 'empty') return 0;
  const serialized =
    value.type === 'json' ? JSON.stringify(value.value) : String(value.value);
  return utf8ByteLength(serialized);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}
