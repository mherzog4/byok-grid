export function formatCsvField(value: string): string {
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}
