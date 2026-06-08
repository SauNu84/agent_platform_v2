/**
 * Minimal RFC-4180 CSV serializer for the History / Analytics "Export CSV" actions.
 * Quotes fields containing comma/quote/newline and doubles embedded quotes.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null>>): string {
  const cell = (v: string | number | boolean | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return lines.join('\r\n');
}
