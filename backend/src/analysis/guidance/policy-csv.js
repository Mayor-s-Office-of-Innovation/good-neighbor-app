/** Strict RFC-style CSV reader; preserves quoted newlines and rejects malformed quotes.
 * @param {string} text
 */
export function readPolicyCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
    } else if (ch === '"') {
      if (field || closed) throw new Error("invalid_csv");
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed) throw new Error("invalid_csv");
      field += ch;
    }
  }
  if (quoted) throw new Error("invalid_csv");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  const width = rows[0]?.length;
  if (!width || rows.some((r) => r.length !== width))
    throw new Error("invalid_csv");
  return rows;
}

/** CSV exports are data, but spreadsheet programs may execute leading formula characters.
 * Escape those cells on export only; canonical policy text remains unmodified.
 * @param {string[][]} rows
 */
export function writePolicyCsv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const cell = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
            return `"${cell.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}
