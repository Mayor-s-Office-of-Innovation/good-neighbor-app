import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const REASONS = {
  1: "Recurring or unresolved Good Neighbor concerns have been identified at this site.",
  2: "Site is a Permanent Supportive Housing property.",
  3: "Site is a Shelter.",
  4: "Site is a drop-in center characterized by frequent, high-volume visitor traffic (e.g., walk-in access, same-day/no-appointment services, or high daily visit counts), where continuous public-facing conditions make more frequent documentation reasonably necessary.",
  5: "The department has evidence of a pattern of undocumented or un-escalated conditions at the site.",
  6: "The provider is in Tiers 1-4 of corrective action.",
};

/**
 * Generate the one-page perimeter-check notice with embedded, subsetted Unicode
 * fonts so names are not transliterated or silently stripped.
 * @param {Record<string, any>} period
 * @returns {Promise<Buffer>}
 */
export async function generateComplianceLetterPdf(period) {
  const input = period.letterInputs || {};
  const selected = new Set(period.reasons || []);
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fonts = await embedFonts(document);
  const page = document.addPage([612, 792]);
  /** @param {unknown} value @param {number} x @param {number} y @param {number} [size] @param {boolean} [bold] */
  const text = (value, x, y, size = 10, bold = false) => {
    drawUnicodeText(page, String(value ?? ""), x, y, size, fonts, bold);
  };
  /** @param {unknown} value @param {number} x @param {number} y @param {number} width @param {number} [size] @param {number} [leading] */
  const paragraph = (value, x, y, width, size = 9.5, leading = 12) => {
    const lines = wrap(
      String(value ?? ""),
      Math.max(20, Math.floor(width / (size * 0.5))),
    );
    lines.forEach((line, index) => text(line, x, y - index * leading, size));
    return y - lines.length * leading;
  };
  const formattedStart = formatDate(period.effectiveStart);
  const formattedEnd = period.periodEnd
    ? formatDate(period.periodEnd)
    : "until further notice";

  text(input.departmentName || "", 54, 752, 12, true);
  text(formatDate(input.confirmedOn), 54, 724, 10);
  text(input.siteName, 54, 700, 10, true);
  text(`Attn: ${input.siteManagerName}`, 54, 685, 10);
  text(input.siteAddress, 54, 670, 10);
  text(
    "Re: Required Documented Perimeter Checks - Good Neighbor Policy",
    54,
    641,
    11,
    true,
  );
  text(`Dear ${input.siteManagerFirstName},`, 54, 615, 10);
  let y = paragraph(
    `${input.departmentName} is providing notice that ${input.siteName} is required to complete and document perimeter checks under the Good Neighbor Policy beginning ${formattedStart}.`,
    54,
    594,
    504,
  );
  y -= 4;
  text(
    "This requirement is based on the following criteria (check all that apply):",
    54,
    y,
    9.5,
  );
  y -= 18;
  for (const [reason, label] of Object.entries(REASONS)) {
    page.drawRectangle({
      x: 54,
      y: y - 2,
      width: 9,
      height: 9,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });
    if (selected.has(reason)) {
      page.drawLine({
        start: { x: 56, y: y + 1 },
        end: { x: 59, y: y - 2 },
        thickness: 1.2,
      });
      page.drawLine({
        start: { x: 59, y: y - 2 },
        end: { x: 64, y: y + 5 },
        thickness: 1.2,
      });
    }
    y = paragraph(label, 70, y, 488, 8.5, 10) - 5;
  }
  y -= 2;
  y = paragraph(
    `Beginning ${formattedStart} through ${formattedEnd}, the site must complete ${period.requiredChecksPerDay} documented perimeter checks per day using the Good Neighbor app and continue all other required Good Neighbor activities.`,
    54,
    y,
    504,
  );
  y -= 5;
  y = paragraph(
    `Questions may be directed to ${input.programManagerName} at ${input.programManagerPhone} or ${input.programManagerEmail}.`,
    54,
    y,
    504,
  );
  y -= 18;
  text("Sincerely,", 54, y, 10);
  text(input.programManagerName, 54, y - 27, 10);
  text(input.departmentName, 54, y - 42, 10);

  return Buffer.from(await document.save());
}

/**
 * Generate a browser-safe first-page preview using the same inputs and layout
 * as the PDF. Keeping this as an image avoids relying on inconsistent embedded
 * PDF viewers while preserving the PDF as the authoritative download.
 * @param {Record<string, any>} period
 * @returns {Buffer}
 */
export function generateComplianceLetterPreviewSvg(period) {
  const input = period.letterInputs || {};
  const selected = new Set(period.reasons || []);
  const elements = ['<rect width="612" height="792" fill="white"/>'];
  /** @param {unknown} value @param {number} x @param {number} y @param {number} [size] @param {boolean} [bold] */
  const text = (value, x, y, size = 10, bold = false) => {
    elements.push(
      `<text x="${x}" y="${792 - y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}"${bold ? ' font-weight="700"' : ""} fill="#111">${xmlText(value)}</text>`,
    );
  };
  /** @param {unknown} value @param {number} x @param {number} y @param {number} width @param {number} [size] @param {number} [leading] */
  const paragraph = (value, x, y, width, size = 9.5, leading = 12) => {
    const lines = wrap(
      String(value ?? ""),
      Math.max(20, Math.floor(width / (size * 0.5))),
    );
    lines.forEach((line, index) => text(line, x, y - index * leading, size));
    return y - lines.length * leading;
  };
  const formattedStart = formatDate(period.effectiveStart);
  const formattedEnd = period.periodEnd
    ? formatDate(period.periodEnd)
    : "until further notice";

  text(input.departmentName || "", 54, 752, 12, true);
  text(formatDate(input.confirmedOn), 54, 724);
  text(input.siteName, 54, 700, 10, true);
  text(`Attn: ${input.siteManagerName}`, 54, 685);
  text(input.siteAddress, 54, 670);
  text(
    "Re: Required Documented Perimeter Checks - Good Neighbor Policy",
    54,
    641,
    11,
    true,
  );
  text(`Dear ${input.siteManagerFirstName},`, 54, 615);
  let y = paragraph(
    `${input.departmentName} is providing notice that ${input.siteName} is required to complete and document perimeter checks under the Good Neighbor Policy beginning ${formattedStart}.`,
    54,
    594,
    504,
  );
  y -= 4;
  text(
    "This requirement is based on the following criteria (check all that apply):",
    54,
    y,
    9.5,
  );
  y -= 18;
  for (const [reason, label] of Object.entries(REASONS)) {
    elements.push(
      `<rect x="54" y="${785 - y}" width="9" height="9" fill="none" stroke="#111" stroke-width="0.8"/>`,
    );
    if (selected.has(reason)) {
      elements.push(
        `<path d="M56 ${791 - y} L59 ${794 - y} L64 ${787 - y}" fill="none" stroke="#111" stroke-width="1.2"/>`,
      );
    }
    y = paragraph(label, 70, y, 488, 8.5, 10) - 5;
  }
  y -= 2;
  y = paragraph(
    `Beginning ${formattedStart} through ${formattedEnd}, the site must complete ${period.requiredChecksPerDay} documented perimeter checks per day using the Good Neighbor app and continue all other required Good Neighbor activities.`,
    54,
    y,
    504,
  );
  y -= 5;
  y = paragraph(
    `Questions may be directed to ${input.programManagerName} at ${input.programManagerPhone} or ${input.programManagerEmail}.`,
    54,
    y,
    504,
  );
  y -= 18;
  text("Sincerely,", 54, y);
  text(input.programManagerName, 54, y - 27);
  text(input.departmentName, 54, y - 42);

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" role="img">${elements.join("")}</svg>`,
  );
}

const require = createRequire(import.meta.url);
const FONT_SUBSETS = [
  "latin",
  "latin-ext",
  "vietnamese",
  "greek",
  "greek-ext",
  "cyrillic",
  "cyrillic-ext",
];

/** @param {PDFDocument} document */
async function embedFonts(document) {
  /** @type {Record<string, {regular: import("pdf-lib").PDFFont, bold: import("pdf-lib").PDFFont}>} */
  const fonts = {};
  await Promise.all(
    FONT_SUBSETS.map(async (subset) => {
      const [regular, bold] = await Promise.all(
        [400, 700].map(async (weight) => {
          const path = require.resolve(
            `@fontsource/noto-sans/files/noto-sans-${subset}-${weight}-normal.woff`,
          );
          return document.embedFont(await readFile(path), { subset: true });
        }),
      );
      fonts[subset] = { regular, bold };
    }),
  );
  return fonts;
}

/**
 * @param {import("pdf-lib").PDFPage} page
 * @param {string} value
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {Awaited<ReturnType<typeof embedFonts>>} fonts
 * @param {boolean} bold
 */
function drawUnicodeText(page, value, x, y, size, fonts, bold) {
  let cursor = x;
  for (const run of fontRuns(value)) {
    const font = fonts[run.subset][bold ? "bold" : "regular"];
    page.drawText(run.text, { x: cursor, y, size, font });
    cursor += font.widthOfTextAtSize(run.text, size);
  }
}

/** @param {string} value */
function fontRuns(value) {
  /** @type {{subset: string, text: string}[]} */
  const runs = [];
  for (const character of value.normalize("NFC")) {
    const subset = fontSubset(character.codePointAt(0) ?? 0);
    const previous = runs.at(-1);
    if (previous?.subset === subset) previous.text += character;
    else runs.push({ subset, text: character });
  }
  return runs;
}

/** @param {number} codePoint */
function fontSubset(codePoint) {
  if (codePoint >= 0x1f00 && codePoint <= 0x1fff) return "greek-ext";
  if (codePoint >= 0x0370 && codePoint <= 0x03ff) return "greek";
  if (
    (codePoint >= 0x0460 && codePoint <= 0x052f) ||
    (codePoint >= 0x2de0 && codePoint <= 0x2dff) ||
    (codePoint >= 0xa640 && codePoint <= 0xa69f)
  ) {
    return "cyrillic-ext";
  }
  if (codePoint >= 0x0400 && codePoint <= 0x045f) return "cyrillic";
  if (
    (codePoint >= 0x1ea0 && codePoint <= 0x1ef9) ||
    [
      0x0102, 0x0103, 0x0110, 0x0111, 0x0128, 0x0129, 0x0168, 0x0169, 0x01a0,
      0x01a1, 0x01af, 0x01b0,
    ].includes(codePoint)
  ) {
    return "vietnamese";
  }
  if (codePoint > 0x00ff) return "latin-ext";
  return "latin";
}

/** @param {unknown} value */
function xmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** @param {string} value @param {number} limit */
function wrap(value, limit) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > limit) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** @param {string} value */
function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}
