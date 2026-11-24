// Site names and categories are typed by people, so a formula-like cell gets an apostrophe.

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {string[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {string}
 */
export function toCsv(columns, rows) {
  const lines = [columns.map(cell).join(",")];
  for (const row of rows)
    lines.push(columns.map((c) => cell(row[c])).join(","));
  // The byte-order mark makes Excel read UTF-8, so "Misión" isn't garbled.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
