import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";

export default [
  js.configs.recommended,
  jsdoc.configs["flat/recommended"],
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Build-time Vite define (vite.config.js), not a runtime global.
        __RELEASE__: "readonly",
      },
    },
    settings: {
      jsdoc: { mode: "typescript" },
    },
    rules: {
      // Types carry the meaning here; prose descriptions would be boilerplate.
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-property-description": "off",
      // Ambient NodeJS.* types resolve under tsc, not eslint's type table.
      "jsdoc/no-undefined-types": ["warn", { definedTypes: ["NodeJS"] }],
      // The ported gnp sources land under `@ts-nocheck` (lenient checkJs baseline
      // — see tsconfig.json / memory step2-gnp-port-scope). Requiring JSDoc blocks
      // while types are off is contradictory, so these are relaxed for the port and
      // re-enabled per file as it's ratcheted to typed + checkJs-clean. (The backend
      // keeps them on — it's fully typed.)
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-returns": "off",
    },
  },
];
