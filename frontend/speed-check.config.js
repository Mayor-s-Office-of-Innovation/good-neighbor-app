// Lab performance budgets, run by `npm run perf` locally and by the CI `perf`
// job. Tool: https://github.com/Mayor-s-Office-of-Innovation/speed-check
// (docs/config.md lists every option). Paths are relative to this file.
export default {
  // Same server the previous in-repo scripts used: Vite's preview of dist/.
  // Build first (`npm run build`).
  serve: {
    command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
  },
  baseURL: "http://127.0.0.1:4173",

  // Only the code-entry front door is public, and it is the right page: it
  // is what loads on a cold device. App states behind the site binding stay
  // with the Playwright suite.
  pages: ["/"],
  runs: 3,

  // Lighthouse's default mobile profile: mid-range phone, slow 4G, 4x CPU
  // slowdown. That is the "older iPads and cheap phones" population in the
  // README, measured by not overriding the defaults.
  formFactor: "mobile",

  // uses-http2 is a false positive behind vite preview and S3/CloudFront alike.
  skipAudits: ["uses-http2"],

  // Warn-only until the noise floor is measured; promote to "gate" once two
  // weeks pass without a false alarm. size-limit stays the hard gate on
  // bundle size throughout.
  mode: "warn",

  // Medians across runs are compared with these. Thresholds carried over from
  // the previous lighthouse-budgets.json: noise-floor numbers, not goals.
  budgets: {
    "*": {
      performance: 0.8,
      lcp: 4000,
      tbt: 500,
      cls: 0.1,
      scriptKB: 400,
      stylesheetKB: 250,
    },
  },
};
