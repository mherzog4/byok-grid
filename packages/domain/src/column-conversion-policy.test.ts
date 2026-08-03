import { describe, expect, it } from 'vitest';
import {
  ColumnCellConversionError,
  convertColumnCellValue,
} from './column-conversion-policy';

describe('column type conversion policy', () => {
  it('preserves empty cells and creates canonical text', () => {
    expect(
      convertColumnCellValue({ type: 'empty', value: null }, 'number')
    ).toEqual({ type: 'empty', value: null });
    expect(
      convertColumnCellValue({ type: 'json', value: { b: 2 } }, 'text')
    ).toEqual({ type: 'text', value: '{"b":2}' });
    expect(
      convertColumnCellValue(
        { type: 'timestamp', value: '2026-08-01T12:00:00.000Z' },
        'text'
      )
    ).toEqual({ type: 'text', value: '2026-08-01T12:00:00.000Z' });
  });

  it('parses strict text and JSON primitive conversions', () => {
    expect(
      convertColumnCellValue({ type: 'text', value: ' 42.5 ' }, 'number')
    ).toEqual({ type: 'number', value: 42.5 });
    expect(
      convertColumnCellValue({ type: 'text', value: 'false' }, 'boolean')
    ).toEqual({ type: 'boolean', value: false });
    expect(
      convertColumnCellValue({ type: 'json', value: 7 }, 'number')
    ).toEqual({ type: 'number', value: 7 });
    expect(
      convertColumnCellValue({ type: 'text', value: '{"ok":true}' }, 'json')
    ).toEqual({ type: 'json', value: { ok: true } });
  });

  it('requires deterministic timestamp offsets', () => {
    expect(
      convertColumnCellValue(
        { type: 'text', value: '2026-08-01T08:00:00-04:00' },
        'timestamp'
      )
    ).toEqual({ type: 'timestamp', value: '2026-08-01T12:00:00.000Z' });
    expect(() =>
      convertColumnCellValue(
        { type: 'text', value: '2026-08-01T08:00:00' },
        'timestamp'
      )
    ).toThrow(/explicit UTC offset/);
  });

  it('rejects lossy or ambiguous coercions', () => {
    for (const [source, target] of [
      [{ type: 'number', value: 1 }, 'boolean'],
      [{ type: 'text', value: 'TRUE' }, 'boolean'],
      [{ type: 'json', value: [1, 2] as number[] }, 'number'],
      [{ type: 'text', value: 'Infinity' }, 'number'],
    ] as const) {
      expect(() => convertColumnCellValue(source, target)).toThrow(
        ColumnCellConversionError
      );
    }
  });
});
