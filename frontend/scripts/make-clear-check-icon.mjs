#!/usr/bin/env node
/*
  Regenerate the "all clear" illustration shown on the home screen and the
  clear-check card.

    node scripts/make-clear-check-icon.mjs

  Source: scripts/assets/clear-check-icon-source.png (472×478 RGBA). Output:
  public/clear-check-icon.webp at 288 px wide — 3× the 96×98 CSS slot — a few
  KB instead of the 162 KB PNG it replaces (which took 3.4 s on slow 4G).
  `sharp` is a backend dependency hoisted to the workspace root; run from any
  workspace directory and commit the output — nothing here runs at build time.
*/
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "assets/clear-check-icon-source.png");
const out = join(here, "../public/clear-check-icon.webp");

const data = await sharp(source)
  .resize({ width: 288, withoutEnlargement: true })
  .webp({ quality: 82, alphaQuality: 90 })
  .toBuffer();
writeFileSync(out, data);
console.log(`wrote public/clear-check-icon.webp (${data.length} bytes)`);
