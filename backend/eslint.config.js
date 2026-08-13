import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";

export default [
  js.configs.recommended,
  jsdoc.configs["flat/recommended"],
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
      },
    },
    settings: {
      // NodeJS namespace types (e.g. NodeJS.ProcessEnv) are ambient, not importable.
      jsdoc: { mode: "typescript" },
    },
    rules: {
      // Types carry the meaning here; prose descriptions would be boilerplate.
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-property-description": "off",
      // Ambient NodeJS.* types resolve under tsc, not eslint's type table.
      "jsdoc/no-undefined-types": ["warn", { definedTypes: ["NodeJS"] }],
    },
  },
];
