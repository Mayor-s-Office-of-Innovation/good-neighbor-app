# ADR 0004: JavaScript + JSDoc instead of TypeScript syntax

## Status

Accepted (2026-08-12). Supersedes the "use TypeScript for frontend and backend code"
standing choice in [AGENTS.md](../../AGENTS.md); no prior ADR mandated TypeScript.

## Context

Type safety comes from the TypeScript compiler, not from `.ts` syntax. Pointing `tsc` at
`.js` files with `checkJs: true` gives the same inference, `strict` checks, and editor
experience while removing the transpile of our own source: Vite/esbuild already strips types
without checking (checking was always a separate `tsc --noEmit` pass), and Lambda runs
whatever JS we ship — with JSDoc the authored `.js` *is* the deployable. The incoming `gnp`
frontend was already all JS, so this also matched the code we were adopting.

## Decision

Write all application code in **JavaScript (ES modules)** and express types in **JSDoc**,
type-checked by `tsc --noEmit` in `checkJs` mode (run as `npm run typecheck`, enforced in CI).
Keep the TypeScript compiler purely as a checker; stop authoring `.ts` files and stop
transpiling application source. Shared types live in `types.d.ts`, imported via
`import('./types.js').Foo`. Backend ships raw `src/*.js` (no build step). Presentational
`*.templates.js` seams get a `@param` typedef so prop shape is checked at call sites; the HTML
interior stays unchecked (no `lit-html`/`lit-analyzer`).

## Consequences

- One type gate (`tsc --noEmit` over `.js`) instead of a transpile + separate check; no emit
  step on either workspace.
- More verbose annotations for generics/unions/overloads; a few TS features (`enum`, some
  `as const`/`satisfies`) need workarounds (const objects, `@satisfies`).
- ESLint uses the JS-native flat config (`@eslint/js` + `eslint-plugin-jsdoc`); the
  `@typescript-eslint/*` packages are removed.
- Adopting an untyped tree is done under a **lenient, ratcheting** gate: `checkJs: true` with
  `strict: false` and greppable `// @ts-nocheck` on the noisiest files, tightened toward
  `strict` one file per PR.
