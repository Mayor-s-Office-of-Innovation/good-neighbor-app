import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const REASONS = {
  1: "Recurring or unresolved Good Neighbor (GN) concerns have been identified at this site.",
  2: "Site is a Permanent Supportive Housing property;",
  3: "Site is a Shelter;",
  4: "Site is a drop-in center characterized by frequent, high-volume visitor traffic (e.g., walk-in access, same-day/no-appointment services, or high daily visit counts), where continuous public-facing conditions make more frequent documentation reasonably necessary.",
  6: "This site is under enhanced monitoring for GNP concerns.",
};

/** English number words for the supported daily check range (1–100).
 * @param {number} count
 */
function checkCountWords(count) {
  const small = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  if (count < 20) return small[count];
  if (count === 100) return "one hundred";
  const tens = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ];
  return (
    tens[Math.floor(count / 10)] + (count % 10 ? `-${small[count % 10]}` : "")
  );
}

/** Shared layout keeps the PDF and browser preview identical.
 * @param {Record<string, any>} period
 */
function letterLayout(period) {
  const input = period.letterInputs || {};
  /** @type {{text: string, x: number, y: number, size: number, bold: boolean}[]} */
  const lines = [];
  let y = 750;
  /** @param {string} value @param {number} [size] @param {boolean} [bold] */
  const paragraph = (value, size = 9, bold = false) => {
    for (const line of wrap(value, Math.floor(504 / (size * 0.52)))) {
      lines.push({ text: line, x: 54, y, size, bold });
      y -= size + 3;
    }
    y -= 6;
  };
  const count = Number(period.requiredChecksPerDay);
  const cadence =
    Number.isInteger(count) && count >= 1 && count <= 100
      ? `${checkCountWords(count)} (${count})`
      : String(period.requiredChecksPerDay);
  const start = formatDate(period.effectiveStart);
  const end = period.periodEnd ? formatDate(period.periodEnd) : "";
  const managers = [
    input.siteManagerName,
    ...(input.providerManagerNames || []),
  ].filter(Boolean);
  paragraph(input.departmentName || "", 12, true);
  paragraph(formatDate(input.confirmedOn));
  paragraph(`Attn: ${managers.join(", ")}`);
  paragraph(`Re: ${input.siteName}: ${input.siteAddress}`);
  paragraph(
    "Re: Required Documented Perimeter Checks — Good Neighbor Policy",
    10,
    true,
  );
  paragraph(`Dear ${input.siteManagerFirstName},`);
  paragraph(
    `This letter is to notify you that, in accordance with the Good Neighbor Policy (GNP), the City has determined that ${input.siteName} at ${input.siteAddress} is required to conduct and document perimeter checks at least ${cadence} ${count === 1 ? "time" : "times"} per day, effective ${start}. ${input.leadProgramName ? `Based on our records, the GNP primary operator for this address is ${input.leadProgramName}. ` : ""}City records reflect ${new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(managers)} ${managers.length > 1 ? "oversee" : "oversees"} GNP compliance for this address.`,
  );
  paragraph(
    `The requirement for ${input.siteAddress} to conduct documented perimeter checks is based on the following threshold criteria:`,
  );
  for (const [reason, label] of Object.entries(REASONS)) {
    paragraph(
      `${(period.reasons || []).includes(reason) ? "[X]" : "[ ]"} ${label}`,
      8.5,
    );
  }
  paragraph(
    `Beginning ${start}${end ? ` through ${end}` : ", until further notice"}, your site must:`,
  );
  paragraph(
    `1. Conduct at least ${cadence} perimeter ${count === 1 ? "check" : "checks"} per day covering the immediate area surrounding the site (IASS);`,
  );
  paragraph("2. Document each check in the GN application; and");
  paragraph(
    "3. Continue to follow all other applicable GN required activities.",
  );
  paragraph(
    "If you have questions about this notice or need support meeting this requirement, please contact me.",
  );
  paragraph("Sincerely,");
  paragraph(input.programManagerName || "");
  paragraph(input.departmentName || "");
  // Long names/addresses retain all text; scale the entire layout to fit.
  if (y < 42) {
    const scale = (750 - 42) / (750 - y);
    for (const line of lines) {
      line.y = 750 - (750 - line.y) * scale;
      line.size *= scale;
    }
  }
  return lines;
}

/** @param {Record<string, any>} period @returns {Promise<Buffer>} */
export async function generateComplianceLetterPdf(period) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fonts = await embedFonts(document);
  const page = document.addPage([612, 792]);
  for (const line of letterLayout(period)) {
    drawUnicodeText(
      page,
      line.text,
      line.x,
      line.y,
      line.size,
      fonts,
      line.bold,
    );
  }
  return Buffer.from(await document.save());
}

/** @param {Record<string, any>} period @returns {Buffer} */
export function generateComplianceLetterPreviewSvg(period) {
  const elements = ['<rect width="612" height="792" fill="white"/>'];
  for (const line of letterLayout(period)) {
    elements.push(
      `<text x="${line.x}" y="${792 - line.y}" font-family="Arial, Helvetica, sans-serif" font-size="${line.size}"${line.bold ? ' font-weight="700"' : ""} fill="#111">${xmlText(line.text)}</text>`,
    );
  }
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
  // The Latin font subset includes general punctuation, including em dashes.
  if (codePoint >= 0x2000 && codePoint <= 0x206f) return "latin";
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
