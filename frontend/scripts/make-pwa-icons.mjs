#!/usr/bin/env node
/*
  Regenerate the favicon + PWA icon set from the brand logo.

    node scripts/make-pwa-icons.mjs

  Source: public/img/gn-logo.png (480×480 RGBA — navy rounded square with
  transparent corners). Outputs, all under public/:

    favicon.ico                 16/32/48 PNG-in-ICO (browser tab, bookmarks)
    img/icon-192.png            purpose "any": the logo as drawn, transparent
    img/icon-512.png            corners intact (launchers that don't mask)
    img/icon-maskable-192.png   purpose "maskable": full-bleed navy, logo
    img/icon-maskable-512.png   scaled into the safe zone (inner 80% circle)
    img/apple-touch-icon.png    180×180, full-bleed navy (iOS paints
                                transparent corners black and applies its
                                own rounded mask)

  `sharp` is a backend dependency hoisted to the workspace root; run from any
  workspace directory. Re-run whenever gn-logo.png changes, then commit the
  outputs — nothing here runs at build time.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const pub = join(dirname(fileURLToPath(import.meta.url)), "../public");
const source = join(pub, "img/gn-logo.png");
// Sampled from the logo's flat fill; keep in step with manifest.webmanifest.
const NAVY = { r: 0, g: 29, b: 78, alpha: 1 };

const png = (size) => sharp(source).resize(size, size).png().toBuffer();

/** Logo flattened onto a solid navy square, scaled by `scale` and centered. */
async function fullBleed(size, scale = 1) {
  const inner = Math.round(size * scale);
  const logo = await sharp(source).resize(inner, inner).png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: NAVY },
  })
    .composite([{ input: logo, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** ICO container with PNG-compressed entries (every modern browser reads it). */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

mkdirSync(join(pub, "img"), { recursive: true });
const out = (file, data) => {
  writeFileSync(join(pub, file), data);
  console.log(`wrote public/${file} (${data.length} bytes)`);
};

for (const size of [192, 512]) {
  out(`img/icon-${size}.png`, await png(size));
  // The GN mark spans ~64% of the logo; at 0.9 its corners sit comfortably
  // inside the maskable safe zone (radius 40% of the icon).
  out(`img/icon-maskable-${size}.png`, await fullBleed(size, 0.9));
}
out("img/apple-touch-icon.png", await fullBleed(180));
out(
  "favicon.ico",
  ico(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({ size, data: await png(size) })),
    ),
  ),
);
