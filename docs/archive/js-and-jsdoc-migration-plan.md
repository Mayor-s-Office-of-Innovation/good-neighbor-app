# Plan: JavaScript + JSDoc (drop TypeScript syntax, keep type safety)

Status: **DONE (backend + repo config)** — landed 2026-08-12 as migration Step 1.
Date: 2026-08-11
Supersedes: the "Use TypeScript for frontend and backend code" standing choice in
[AGENTS.md](../../AGENTS.md). No ADR currently mandates TypeScript, so only AGENTS.md
needs to change.

> **Completion note (2026-08-12).** Step 1 of the 3-step migration is done and
> committed. What landed here: all 7 backend `.ts` → `.js` with JSDoc, both
> tsconfigs on `allowJs`/`checkJs`/`noEmit`, both workspaces switched to the
> JS-native ESLint flat config (`@eslint/js` + `eslint-plugin-jsdoc`, minus
> `@typescript-eslint/*`), CI Typecheck step added, and AGENTS.md updated. Backend
> **packaging** was resolved as **option 2 (no build step** — `build` is a no-op
> echo; deploy raw `src/*.js`); the esbuild option remains a possible follow-up, not
> a blocker. The **frontend half of this plan is executed by** the Step 2 doc, not
> here — see [gnp-frontend-migration-plan.md](gnp-frontend-migration-plan.md). The
> `strict: true` frontend tsconfig shown below is still the **end state**: Step 2
> landed at `strict: false` + `@ts-nocheck` baseline, ratcheting per file afterward.

## Decision

Write all application code in **JavaScript (ES modules)** and express types in
**JSDoc**, type-checked by the TypeScript compiler in `checkJs` mode. We stop
authoring `.ts` files and stop transpiling application source; we keep the
TypeScript compiler purely as a **checker** (`tsc --noEmit`).

## Why this still gives us type safety

The type safety comes from the TypeScript compiler, not from `.ts` syntax. Pointing
`tsc` at `.js` files with `checkJs: true` gives us the same inference, the same
`strict` checks, and the same editor experience — errors surface in the IDE and fail
CI exactly as they do today.

What we give up is the **transpile of our own source**, and that costs us almost
nothing here:

- **Frontend:** Vite/esbuild already strips TS types with _no_ checking; real
  checking was always a separate `tsc --noEmit` pass. Serving `.js` directly removes
  the strip step and changes nothing about checking.
- **Backend:** Lambda runs whatever JS we ship. Today `tsc` emits that JS; with
  JSDoc the authored `.js` _is_ the deployable, so the emit step goes away (see
  "Backend packaging" below).

What we keep paying: the `tsc --noEmit` checker in CI. That is the gate, and it does
not disappear — it just points at `.js`.

### Honest trade-offs

- More verbose annotations for generics (`@template`), unions, and overloads.
- A few TS features don't map cleanly (`enum`, some `as const`/`satisfies` nuances);
  workarounds exist (const objects, `@satisfies`).
- Shared types still live in a `types.d.ts` imported via `import('./types.js').Foo`.

For this app's simple domain (forms, tasks, IndexedDB, a few Lambda handlers) these
are minor. The incoming `gnp` frontend is already all JS (the "drop TS syntax" goal
is met there), but its JSDoc is thin — 6 of 22 files carry any annotations and the
other 16 (all 12 components, plus core infra like db/router/main) carry none — so
"keep type safety" is the part that does _not_
come for free. See "Review against the rebuilt `gnp` frontend" below.

## Review against the rebuilt `gnp` frontend (2026-08-11)

The `gnp` rebuild (adjacent `../gnp`) is now the intended frontend. Reviewing this
plan against it produced decisions that refine — but do not reverse — the approach.
The **backend half is unaffected**. The **frontend half changes shape**: it is no
longer a `.ts → .js` conversion (there is no TS left in `gnp`) but an _adoption of
`gnp` plus standing up the `checkJs` gate over an untyped JS component tree_.

Facts about `gnp`: 22 `.js` files, zero `.ts`, no tsconfig, no eslint, no `typescript`
dependency, and no `typecheck` script. JSDoc is thin (see above). So the gate this
plan is built around is exactly what's missing there and will not pass cleanly on
arrival.

1. **Sequencing — adopt first, ratchet the gate after.** Do _not_ block adopting
   `gnp` on a green `strict` + `checkJs` pass; that means annotating a still-moving
   prototype (its `analyzer`/`transcribe`/`onboarding` services are explicit swap
   points). Land `gnp` with the checker **on but lenient** — `checkJs: true`,
   `strict: false`, with `// @ts-nocheck` as an explicit, greppable baseline on the
   noisiest components — so CI is green from day one and obvious errors still surface.
   Then remove `@ts-nocheck` and tighten toward `strict` one file per PR. The gate
   exists immediately; the debt is visible and shrinking. (The `strict: true` target
   in the frontend tsconfig below is the end state, reached by ratchet, not the
   landing state.)

2. **Template files stay, and gain boundary type-safety.** `gnp`'s split of
   presentational markup into sibling `*.templates.js` files (identity-tag
   `` html`…` `` strings) is retained. Add a `@param` typedef to each exported
   template function; every call site is then checked for prop shape and types, and a
   field rename breaks both component and template. Share the typedef across the seam
   via `import('./foo.templates.js').Props`. The HTML _interior_ (attribute/tag
   correctness, escaping) stays unchecked — that would need `lit-html` +
   `lit-analyzer`, which is **rejected**: it adds a runtime dep and a framework layer
   against `gnp`'s no-framework / least-code ethos, and interior checking isn't
   wanted.

3. **Web Awesome + PWA toolchain come from `gnp`.** The current frontend here is
   scaffolding, so take `gnp`'s Web Awesome `^3.11.0` (dropping the `3.0.0-beta.4`
   pinned here) and its `vite-plugin-pwa`, retiring the raw `workbox-*` deps and the
   custom `frontend/scripts/generate-service-worker.mjs`. Net simplification.

4. **Formatting — Prettier defaults, semicolons required.** Drop `gnp`'s
   `.prettierrc.json`; this repo has no prettier config, so it uses defaults
   (`semi: true`, double quotes, `printWidth: 80`) — and "require semicolons" _is_ the
   default. Adoption reformats `gnp` once (adds semicolons, single→double quotes,
   rewrap to 80); afterward there is no prettier config to maintain.

## Configuration changes

### Keep these dependencies

`typescript` (the checker), `@types/node`, `@types/aws-lambda`, `@prisma/client`
(generated types). These are consumed through JSDoc `import('...')` types.

> _Historical:_ `@prisma/client` was kept for Step 1 but has since been **removed** in the
> DynamoDB cutover (Postgres/Prisma → DynamoDB) — see
> [ADR 0002](../adr/0002-datastore-dynamodb.md).

### Remove these dependencies

`@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser` from both workspaces
(replaced by JS-native lint config below).

### tsconfig — frontend (`frontend/tsconfig.json`)

Add `allowJs` + `checkJs`, retarget `include` to `.js`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "useDefineForClassFields": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
  },
  "include": ["src/**/*.js", "vite.config.js"],
}
```

### tsconfig — backend (`backend/tsconfig.json`)

Same idea; drop `outDir`/`rootDir` (no emit), add `allowJs`/`checkJs`/`noEmit`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
  },
  "include": ["src/**/*.js"],
}
```

### ESLint (both workspaces)

Replace the `@typescript-eslint` flat config with JS-native linting, targeting `.js`:

```js
import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc"; // optional: validates JSDoc syntax

export default [
  js.configs.recommended,
  jsdoc.configs["flat/recommended"],
  { files: ["src/**/*.js"] },
];
```

(`eslint-plugin-jsdoc` is optional but recommended — it flags malformed/broken
JSDoc before `tsc` does.)

## File migration inventory

All 9 `.ts` files → `.js`. Conversions are mechanical:
strip annotations, `import type X` → `@typedef`/`import('...').X`, `expr as T` →
`/** @type {T} */ (expr)`, `enum` → const object.

Frontend: **superseded** — the whole current frontend is scaffolding replaced
wholesale by adopting `gnp` (see "Review against the rebuilt `gnp` frontend" above).
`gnp` already ships `vite.config.js` and JS source, so the two conversions below are
no longer worth doing by hand:

- ~~`frontend/vite.config.ts` → `frontend/vite.config.js`~~ (comes from `gnp`)
- ~~`frontend/src/main.ts` → `frontend/src/main.js`~~ (replaced by `gnp`'s `main.js`)

Backend:

- `backend/src/http.ts` → `.js`
- `backend/src/config.ts` → `.js`
- `backend/src/config.test.ts` → `.js` (vitest)
- `backend/src/db.ts` → `.js`
- `backend/src/workers/process-submission.ts` → `.js`
- `backend/src/handlers/submissions.ts` → `.js` — `import type { APIGatewayProxyHandlerV2WithJWTAuthorizer }`
  becomes `@type {import('aws-lambda').APIGatewayProxyHandlerV2WithJWTAuthorizer}`
- `backend/src/handlers/health.ts` → `.js`

## CI changes ([.github/workflows/ci.yml](../../.github/workflows/ci.yml))

- **Add a Typecheck step** to the `app` job (between Lint and Test):
  ```yaml
  - name: Typecheck
    run: npm run typecheck
  ```
  This is the enforcement gate for the whole approach. It is currently missing — CI
  runs format/lint/test/build only — so type errors do **not** fail CI today.
- CodeQL `languages: javascript-typescript` is unchanged (that identifier already
  covers plain JS).

## Backend packaging (decision needed)

`backend/package.json` `build` is `tsc -p tsconfig.json`, which **emits** JS to
`dist/` for Lambda. With JSDoc there is nothing to transpile, so this must change to
one of:

1. **esbuild bundle per handler** (recommended) — produces minimal, dependency-
   bundled Lambda artifacts; keeps deploys small and cold starts low.
2. **No build step** — deploy raw `src/*.js` + `node_modules`. Simplest, but larger
   packages.

Recommendation: option 1, but it is independent of the type-safety goal and can land
as a follow-up. Until then, set backend `build` to a no-op or the esbuild command.

## AGENTS.md edit

Replace line 7:

> - Use TypeScript for frontend and backend code.

with:

> - Write application code in JavaScript (ES modules), not TypeScript. Get type
>   safety without a transpile step by type-checking `.js` files with the TypeScript
>   compiler in `checkJs` mode, expressing types in JSDoc. `tsc --noEmit` (run as
>   `npm run typecheck` in CI) is the type gate; source runs unmodified in the
>   browser and on Lambda. See [docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md).

## Suggested sequencing

1. AGENTS.md edit (records the decision before code changes).
2. Add `allowJs`/`checkJs` to both tsconfigs; add the CI Typecheck step.
3. Convert backend `.ts` → `.js` (+ ESLint config + drop `@typescript-eslint`).
4. Convert frontend `.ts` → `.js` (+ ESLint config).
5. Resolve backend packaging (esbuild vs no-op).
6. Run `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`
   green before merge.

## Out of scope

The larger `gnp` → frontend migration (auth model, backend contract, S3/CloudFront
deploy) is tracked separately. This plan only removes the TypeScript-syntax
requirement and converts the files that exist today.

```

```
