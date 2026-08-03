import {
  editableCellValueSchema,
  type CellValue,
  type EditableInputValueType,
} from './cell-values';

export type ColumnCellConversionErrorCode =
  | 'ambiguous_conversion'
  | 'invalid_boolean'
  | 'invalid_json'
  | 'invalid_number'
  | 'invalid_timestamp'
  | 'value_too_large';

export class ColumnCellConversionError extends Error {
  constructor(
    public readonly code: ColumnCellConversionErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function convertColumnCellValue(
  source: CellValue,
  targetType: EditableInputValueType
): CellValue {
  if (source.type === 'empty' || source.type === targetType) return source;

  if (targetType === 'text') {
    return validateConvertedValue({
      type: 'text',
      value:
        source.type === 'json'
          ? JSON.stringify(source.value)
          : String(source.value),
    });
  }

  if (targetType === 'json') {
    if (source.type === 'text') {
      try {
        return validateConvertedValue({
          type: 'json',
          value: JSON.parse(source.value),
        });
      } catch (error) {
        if (error instanceof ColumnCellConversionError) throw error;
        throw conversionError('invalid_json', 'The text is not valid JSON.');
      }
    }
    return validateConvertedValue({ type: 'json', value: source.value });
  }

  if (source.type === 'json') {
    if (typeof source.value === 'string') {
      return convertColumnCellValue(
        { type: 'text', value: source.value },
        targetType
      );
    }
    if (targetType === 'number' && typeof source.value === 'number') {
      return validateConvertedValue({ type: 'number', value: source.value });
    }
    if (targetType === 'boolean' && typeof source.value === 'boolean') {
      return { type: 'boolean', value: source.value };
    }
    throw conversionError(
      'ambiguous_conversion',
      `This JSON value cannot be converted safely to ${targetType}.`
    );
  }

  if (source.type !== 'text') {
    throw conversionError(
      'ambiguous_conversion',
      `${source.type} cannot be converted safely to ${targetType}.`
    );
  }

  switch (targetType) {
    case 'number': {
      if (source.value.trim() === '') {
        throw conversionError('invalid_number', 'Blank text is not a number.');
      }
      const value = Number(source.value);
      if (!Number.isFinite(value)) {
        throw conversionError(
          'invalid_number',
          'The text is not a finite number.'
        );
      }
      return { type: 'number', value };
    }
    case 'boolean':
      // TODO(product owner): decide whether case-insensitive true/false is safe.
      if (source.value !== 'true' && source.value !== 'false') {
        throw conversionError(
          'invalid_boolean',
          'The text must be exactly true or false.'
        );
      }
      return { type: 'boolean', value: source.value === 'true' };
    case 'timestamp': {
      const value = source.value.trim();
      if (!/(?:z|[+-]\d{2}:\d{2})$/iu.test(value)) {
        throw conversionError(
          'invalid_timestamp',
          'The timestamp must include Z or an explicit UTC offset.'
        );
      }
      const milliseconds = Date.parse(value);
      if (!Number.isFinite(milliseconds)) {
        throw conversionError(
          'invalid_timestamp',
          'The text is not a valid timestamp.'
        );
      }
      return { type: 'timestamp', value: new Date(milliseconds).toISOString() };
    }
    default: {
      const unreachable: never = targetType;
      throw new Error(`The conversion branch ${unreachable} is unreachable.`);
    }
  }
}

function validateConvertedValue(value: CellValue): CellValue {
  const parsed = editableCellValueSchema.safeParse(value);
  if (!parsed.success) {
    throw conversionError(
      'value_too_large',
      'The converted value exceeds the editable cell limit.'
    );
  }
  return parsed.data;
}

function conversionError(
  code: ColumnCellConversionErrorCode,
  message: string
): ColumnCellConversionError {
  return new ColumnCellConversionError(code, message);
}
