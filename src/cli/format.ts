export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printTable(rows: Array<Record<string, unknown>>): void {
  if (!rows.length) {
    console.log("(none)");
    return;
  }
  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length)));
  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  console.log(headers.map((_, index) => "-".repeat(widths[index])).join("  "));
  for (const row of rows) console.log(headers.map((header, index) => String(row[header] ?? "").padEnd(widths[index])).join("  "));
}
