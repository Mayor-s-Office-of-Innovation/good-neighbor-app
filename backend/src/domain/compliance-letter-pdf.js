const REASONS = {
  1: "Recurring or unresolved Good Neighbor concerns have been identified at this site.",
  2: "Site is a Permanent Supportive Housing property.",
  3: "Site is a Shelter.",
  4: "Site is a drop-in center characterized by frequent, high-volume visitor traffic (e.g., walk-in access, same-day/no-appointment services, or high daily visit counts), where continuous public-facing conditions make more frequent documentation reasonably necessary.",
  5: "The department has evidence of a pattern of undocumented or un-escalated conditions at the site.",
  6: "The provider is in Tiers 1-4 of corrective action.",
};

/**
 * Generate the one-page perimeter-check notice without a runtime PDF dependency.
 * The output uses PDF's built-in Helvetica font and simple vector checkboxes.
 * @param {Record<string, any>} period
 * @returns {Buffer}
 */
export function generateComplianceLetterPdf(period) {
  const input = period.letterInputs || {};
  const selected = new Set(period.reasons || []);
  const commands = [];
  /** @param {unknown} value @param {number} x @param {number} y @param {number} [size] @param {boolean} [bold] */
  const text = (value, x, y, size = 10, bold = false) => {
    commands.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`,
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
    commands.push(`0.8 w 54 ${y - 2} 9 9 re S`);
    if (selected.has(reason)) {
      commands.push(`1.2 w 56 ${y + 1} m 59 ${y - 2} l 64 ${y + 5} l S`);
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

  return buildPdf(commands.join("\n"));
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

/** @param {string} content */
function buildPdf(content) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let output = "%PDF-1.4\n%GNP\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, "latin1");
}

/** @param {unknown} value */
function pdfText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/([\\()])/g, "\\$1");
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
