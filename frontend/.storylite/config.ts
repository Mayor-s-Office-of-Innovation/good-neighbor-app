import { defineConfig } from "@storylite/storylite";

/*
  StoryLite config — component workbench for the Good Neighbor frontend.
  Run: npm run storylite (in the frontend workspace). Static: npm run storylite:build.

  Stories are plain JS with JSDoc types (ADR 0004). They render our REAL markup
  classes (see docs/frontend-design-system.md) inside the real design system:
  the `css` list below injects tokens.css + app.css + a Web Awesome shim into
  the isolated preview iframe, so every story is themed exactly like the app —
  including dark mode via the "Dark mode" toolbar toggle (flips .wa-dark on the
  preview body, which is the same mechanism the app itself uses).

  The toolbar "Dark mode" toggle and the phone/tablet viewports are the two QA
  levers the design doc's eyeball pass asks for (light/dark + mobile widths).
*/
export default defineConfig({
  stories: ["./src/**/*.stories.js"],
  css: [
    "./src/styles/tokens.css",
    "./src/styles/app.css",
    "./.storylite/story.css",
  ],
  setup: "./.storylite/setup.js",
  storySort: {
    order: [
      "Foundations",
      ["Tokens", "Buttons", "Status pills"],
      "Components",
      "Web Awesome",
    ],
  },
  ui: {
    brand: {
      titleHtml: "Good Neighbor UI",
      subtitle: "Component workbench",
    },
    viewports: (defaults) => [
      { label: "Phone", width: 390, icon: "mobile" },
      { label: "Phone XL", width: 430, icon: "mobile" },
      ...defaults,
    ],
    toolbar: [
      {
        type: "toggle",
        id: "dark-mode",
        label: "Dark mode (.wa-dark)",
        icon: "moon",
        defaultValue: false,
        target: { type: "preview-class", name: "wa-dark" },
      },
      {
        type: "toggle",
        id: "a11y-outlines",
        label: "Focus outlines on interactive elements",
        icon: "accessibility",
        defaultValue: false,
        target: { type: "preview-class", name: "show-a11y-outlines" },
      },
    ],
  },
});