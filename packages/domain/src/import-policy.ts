import type { CellValueType } from './cell-values';

export type ImportableColumn = Readonly<{
  id: string;
  kind: 'connector' | 'formula' | 'function' | 'input';
  name: string;
  valueType: CellValueType;
}>;

export type CsvColumnPlan = Readonly<{
  columnName: string;
  existingColumnId: string | null;
  header: string;
}>;

export class CsvImportDefinitionError extends Error {}

/**
 * Product policy seam for CSV header conflicts.
 *
 * TODO(product owner): decide whether a header colliding with a computed or
 * connector column should be suffixed (current behavior) or reject the import.
 */
export function planCsvColumns(
  headers: readonly string[],
  existingColumns: readonly ImportableColumn[]
): CsvColumnPlan[] {
  const normalizedHeaders = new Set<string>();
  const reservedNames = new Set(
    existingColumns.map((column) => normalizeHeader(column.name))
  );

  return headers.map((rawHeader) => {
    const header = rawHeader.trim();
    validateHeader(header);
    const normalized = normalizeHeader(header);
    if (normalizedHeaders.has(normalized)) {
      throw new CsvImportDefinitionError(
        `CSV header “${header}” appears more than once.`
      );
    }
    normalizedHeaders.add(normalized);

    const existing = existingColumns.find(
      (column) => normalizeHeader(column.name) === normalized
    );
    if (existing?.kind === 'input' && existing.valueType === 'text') {
      return {
        columnName: existing.name,
        existingColumnId: existing.id,
        header,
      };
    }
    if (!existing) {
      reservedNames.add(normalized);
      return { columnName: header, existingColumnId: null, header };
    }

    let suffix = 2;
    let candidate = `${header} (import ${suffix})`;
    while (reservedNames.has(normalizeHeader(candidate))) {
      suffix += 1;
      candidate = `${header} (import ${suffix})`;
    }
    if (candidate.length > 120) {
      candidate = `${header.slice(0, 100).trimEnd()} (import ${suffix})`;
    }
    reservedNames.add(normalizeHeader(candidate));
    return { columnName: candidate, existingColumnId: null, header };
  });
}

function validateHeader(header: string): void {
  if (!header) {
    throw new CsvImportDefinitionError('CSV headers cannot be empty.');
  }
  if (header.length > 120) {
    throw new CsvImportDefinitionError(
      `CSV header “${header.slice(0, 32)}…” exceeds 120 characters.`
    );
  }
  if (/\p{Cc}/u.test(header)) {
    throw new CsvImportDefinitionError(
      'CSV headers cannot contain control characters.'
    );
  }
}

function normalizeHeader(header: string): string {
  return header.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
