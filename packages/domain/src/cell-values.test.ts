import { describe, expect, it } from 'vitest';
import {
  editableCellValueSchema,
  formatEditableCellDraft,
  MAXIMUM_EDITABLE_CELL_BYTES,
  normalizeEditableTimestamp,
  parseEditableCellDraft,
} from './cell-values';

describe('editable cell values', () => {
  it('parses every editable draft into a typed cell value', () => {
    expect(parseEditableCellDraft('text', '  Acme  ')).toEqual({
      type: 'text',
      value: '  Acme  ',
    });
    expect(parseEditableCellDraft('number', '42.5')).toEqual({
      type: 'number',
      value: 42.5,
    });
    expect(parseEditableCellDraft('boolean', 'false')).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(
      parseEditableCellDraft('timestamp', '2026-07-31T12:30:00.000Z')
    ).toEqual({ type: 'timestamp', value: '2026-07-31T12:30:00.000Z' });
    expect(parseEditableCellDraft('json', '{"score":7}')).toEqual({
      type: 'json',
      value: { score: 7 },
    });
  });

  it('uses an empty cell for blank non-text drafts', () => {
    expect(parseEditableCellDraft('number', ' ')).toEqual({
      type: 'empty',
      value: null,
    });
    expect(parseEditableCellDraft('boolean', '')).toEqual({
      type: 'empty',
      value: null,
    });
  });

  it('rejects invalid coercions and oversized values', () => {
    expect(() => parseEditableCellDraft('number', 'Infinity')).toThrow(
      /finite number/i
    );
    expect(() => parseEditableCellDraft('boolean', 'yes')).toThrow(/choose/i);
    expect(() => parseEditableCellDraft('timestamp', 'not-a-date')).toThrow(
      /valid date/i
    );
    expect(() => parseEditableCellDraft('json', '{broken')).toThrow(
      /valid JSON/i
    );
    expect(
      editableCellValueSchema.safeParse({
        type: 'text',
        value: 'x'.repeat(MAXIMUM_EDITABLE_CELL_BYTES + 1),
      }).success
    ).toBe(false);
  });

  it('formats canonical values back into editor drafts', () => {
    expect(formatEditableCellDraft({ type: 'boolean', value: true })).toBe(
      'true'
    );
    expect(formatEditableCellDraft({ type: 'json', value: { ok: true } })).toBe(
      '{"ok":true}'
    );
  });

  it('normalizes timestamp instants and rejects invalid drafts', () => {
    expect(normalizeEditableTimestamp('2026-07-31T12:30:00.000Z')).toBe(
      '2026-07-31T12:30:00.000Z'
    );
    expect(() => normalizeEditableTimestamp('not-a-date')).toThrow(
      /valid date/i
    );
  });
});
