/**
 * Icons story — our self-hosted icon set (frontend/public/icons/*.svg),
 * registered in main.js as the "default" wa-icon library. Icons are presentational
 * here (aria-hidden) — every meaningful one must be paired with a text label.
 */

export default {
  title: "Web Awesome/Icons",
  parameters: { renderer: "html" },
  source: '<wa-icon name="camera"></wa-icon>',
};

const names = [
  "arrow-down",
  "camera",
  "chevron-left",
  "chevron-right",
  "circle-check",
  "circle-plus",
  "circle-stop",
  "circle-xmark",
  "comment",
  "ellipsis",
  "file-lines",
  "flag",
  "gear",
  "image",
  "list-check",
  "location-dot",
  "microphone",
  "moon",
  "pen",
  "pen-clip",
  "repeat",
  "rotate",
  "sparkles",
  "spinner",
  "star",
  "sun",
  "trash",
  "triangle-exclamation",
  "xmark",
];

export const Default = {
  name: "Self-hosted set",
  render: () => `
    <p class="story-label">Resolved from /public/icons — no Font Awesome CDN</p>
    <div class="story-row" style="max-width:560px">
      ${names
        .map(
          (n) => `<div class="story-stack" style="gap:0.3rem">
        <wa-icon name="${n}" style="font-size:1.25rem"></wa-icon>
        <code style="font-size:0.62rem; color:var(--text-faint)">${n}</code>
      </div>`,
        )
        .join("")}
    </div>`,
  source: () => `<!-- Icons resolve locally via registerIconLibrary("default", ...)
     in main.js; add a new icon by dropping its SVG into frontend/public/icons/ -->
<wa-icon name="camera"></wa-icon>`,
};