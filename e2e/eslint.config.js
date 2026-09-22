import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        // Browser globals referenced inside page.evaluate() callbacks.
        document: "readonly",
        window: "readonly",
      },
    },
  },
  { ignores: ["test-results/", "playwright-report/", "node_modules/"] },
];
