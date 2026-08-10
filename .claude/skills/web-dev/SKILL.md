---
name: web-dev
description: Apply the user's web development stack and standards to any frontend/web work — building a website, web app, web visualization, dashboard, component, or static site, and choosing how to run, host, or add a backend. Lightweight, Core-Web-Vitals-first, and accessible (WCAG AA) by default; web components + Web Awesome; modern CSS, never Tailwind; Svelte/Astro/Preact only when a framework is truly needed, never React; Vite/http-server; GitHub Pages via Actions; 11ty for static sites; AWS Lambda + DynamoDB for backend. Invoke at the START of web work, before choosing tools or scaffolding.
user-invocable: true
---

# Web development standards

These are the user's standing preferences for **all** web work. Apply them by default. If a request seems to require violating one (e.g. "use React"), stop and confirm before proceeding — don't silently comply or silently override.

## 1. Performance is the top constraint
- **Every build must be able to pass Core Web Vitals** (LCP, INP, CLS). Treat this as a hard requirement, not a nice-to-have.
- **Ship the least code possible.** Prefer zero-dependency solutions. Every dependency must earn its place — if you can do it with the platform, do that instead.
- Before adding any dependency, state in one line *why the web platform can't do it.* If you can't, don't add it.

## 2. Accessibility is the other hard requirement
- **Target WCAG 2.2 AA.** Treat it as a release gate, not a polish pass — a peer to performance, not an afterthought.
- **Semantic HTML first** — real headings, landmarks, lists, and buttons; reach for ARIA only to fill gaps the platform can't express, never to paper over non-semantic markup.
- **Every non-text visual needs a text alternative** — `alt` for meaningful images, an `aria-label` or visually-hidden description for charts/visualizations/icon-only controls, and labels for every form control.
- **Never encode meaning in color alone** — pair color with text, shape, or a label; keep text contrast ≥ 4.5:1 (≥ 3:1 for large text and UI elements).
- **Keyboard-operable with visible focus** — everything interactive is reachable and operable by keyboard, in a logical tab/reading order, with a clear focus indicator (don't remove outlines without replacing them).
- **Respect user settings** — honor `prefers-reduced-motion` (gate non-essential animation), don't disable zoom, and use relative units so text scales.
- Verify before shipping: a **keyboard-only pass** and an **accessibility-tree + contrast check**.

## 3. Frameworks: avoid by default
- **Default to no framework.** Use the web platform directly (see §4).
- When a framework is genuinely warranted (real app-scale state/routing/SSR needs), the **only acceptable choices are Svelte, Astro, or Preact.**
- **Never use React.** Not Next.js, not CRA, not React under any wrapper. This is absolute.

## 4. Use the web platform; web components are the component model
- Reach for **native web platform APIs first** (Custom Elements, Shadow DOM, templates, `<dialog>`, popover API, `fetch`, view transitions, form-associated elements, etc.).
- **The component model is Web Components** (Custom Elements). Build reusable UI as web components rather than pulling in a framework's component system.
- Progressive enhancement and semantic HTML by default.

## 5. Component library: Web Awesome
- **Web Awesome is the preferred component library** — framework-agnostic web components (the Shoelace successor from the Font Awesome team), which fits §4 perfectly. Use it for ready-made components instead of hand-rolling or pulling another kit.
- **Package & install:** `npm i @awesome.me/webawesome` (package name `@awesome.me/webawesome`).
- **It ships its own AI resources in `node_modules` after install** (see https://webawesome.com/docs/ai) — use these instead of guessing component APIs:
  - **Agent Skill** (recommended; Claude Code-compatible): a progressively-loaded skill directory inside `node_modules/@awesome.me/webawesome/`. After installing, locate it (e.g. `find node_modules/@awesome.me/webawesome -iname 'SKILL.md'`) and use it for component props/events/slots/theming.
  - **llms.txt** (fallback): a single-file complete API reference, also generated into `node_modules` on build. Attach/paste it when the agent skill isn't auto-loaded.
  - Note: there is **no hosted llms.txt and no MCP** — these are install-time artifacts, so install the package first.
- Never guess Web Awesome component APIs — pull them from the shipped agent skill or llms.txt.

## 6. CSS: do it in CSS
- **Never do in JavaScript what CSS can do.** Layout, transitions, animations, theming, responsive behavior, scroll effects, state-driven styling (`:has()`, container queries, `:checked`, etc.) belong in CSS.
- **Use modern CSS features** when they fit: nesting, container queries, `:has()`, cascade layers, custom properties, `color-mix()`, view transitions, subgrid, logical properties, `clamp()`/fluid type.
- **Never use Tailwind.** Use plain modern CSS (custom properties + nesting), or CSS modules / scoped styles where a tool provides them. No utility-class frameworks.

## 7. Running locally
- Use **Vite** for anything needing a dev server/bundling, or **`http-server`** for plain static files. Pick the lighter of the two that does the job.
- **Don't run package-install commands yourself.** The user runs `npm install` / `npm i <pkg>` themselves — **print the exact command** and wait for them to run it before continuing.

## 8. Static sites
- When a static-site generator is warranted, use **11ty (Eleventy)**. (Astro is also fine per §3 if a component-driven build is wanted.)

## 9. Hosting & deployment
- Host on **GitHub Pages**.
- Deploy via a **GitHub Actions** workflow (build → publish to Pages). Set this up as part of the work, don't leave deployment manual.

## 10. Backend / data (only when actually needed)
- Default to **static / client-side** — add a backend only when the task truly requires server-side logic or persistence.
- When it does: **AWS Lambda** for compute and **DynamoDB** for data. Don't reach for a heavier stack without confirming.

## Quick decision checklist
1. Can this be static + client-side? → yes: no backend.
2. Can the platform do it without a dependency? → yes: no dependency.
3. Can CSS do it without JS? → yes: do it in CSS.
4. Do I actually need a framework? → only if yes, pick Svelte / Astro / Preact (never React).
5. Components? → web components, prefer Web Awesome.
6. Run with Vite or http-server; host on GitHub Pages via Actions.
7. Sanity-check the result against **Core Web Vitals and WCAG AA** (keyboard pass, contrast, text alternatives).
