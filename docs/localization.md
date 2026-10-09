# Localization

The field app ships in English, Spanish, Filipino, Vietnamese, and Traditional
Chinese. English is the source of truth; the other four are translation
catalogs. The admin console, 311 ticket text, and the setup-code email stay
English by design.

## How it works

- **Catalogs:** `frontend/src/i18n/catalogs/<locale>.json`, flat `{ "key": "text" }`
  files with identical key sets. Locale ids: `en`, `es`, `fil`, `vi`, `zh-Hant`.
  English is bundled; the others load as separate chunks when selected.
- **Lookup:** `t("key", params)` from `frontend/src/i18n/i18n.js`. `{name}`
  placeholders interpolate; `params.count` selects `key.one` / `key.other`
  (and `few` / `many` where a language needs them) through `Intl.PluralRules`.
  A key missing from a language falls back to English.
- **Switching:** the settings menu's Language item. The choice is stored per
  device in `localStorage` (`locale`), applied to `<html lang>`, and the app
  re-renders on the `localechange` window event. Default is English; the
  browser language is not auto-detected.
- **Dates:** `frontend/src/i18n/dates.js`. US conventions (month-day order,
  12-hour clock, Pacific time) with month and weekday names in the active
  language. It is the only module that may construct an `Intl` formatter with
  a fixed locale, and only for calendar arithmetic (`pacificDaysAgo`,
  `pacificWeekdayIndex`), never for text a user sees.
- **Text that arrives as data:** rulebook strings on task items (labels,
  guidance, buttons, cannot-do reasons, questions, categories, agencies) and
  the backend's 311 vocabulary and timeline labels are translated by looking
  the stored English up in the `rulebook.*` / `server.*` namespaces
  (`frontend/src/i18n/rulebook.js`, `rulebookText(text, scope)`). The same
  English can exist under several keys ("Resolved" is both a 311 closure
  reason and a task-update label), so callers pass a key-prefix `scope` such as
  `"server.sf311"` where the context is known. The API wire format is
  unchanged: the UI still submits and compares the stored English.
- **Analyzer text:** the two model-written fields (`user_friendly_label`,
  `description`) are stored with a per-locale `translations` map
  (`{ es: { user_friendly_label, description }, vi: {…}, … }`) on the
  ANALYSIS# concern and on the CONDITION and TASK copies
  (`backend/src/analysis/translations.js` owns the shape; it also upgrades
  records stored in the earlier single-block form on read, so nothing needs a
  backfill). Two sources fill the map:
  - **Capture time, one locale.** The analyze request carries the capturing
    device's locale (stamped at `registerArtifact`), and the service returns
    that one translation in the same call, so the card appears at today's
    speed in the user's language.
  - **Background, every other locale.** After the analysis is persisted, the
    analyze worker enqueues a `translate_artifact` message on the shared
    worker queue; `assessments:evaluate` enqueues one too for the condition
    copies it stores (covering edited, added, and described conditions). The
    translate worker (`backend/src/workers/translate-artifact.js`) asks the
    service's text-only `POST /v1/translations` for the locales still
    missing — one call per locale per chunk of 10 items, in parallel, since
    output tokens dominate the service's latency behind its 29 s gateway
    budget — and writes the merged map onto every stored copy of that exact
    English text — the concern, the conditions, and their tasks — whether the
    user has evaluated yet or not. Items over the service's text caps are
    skipped (they keep English) rather than failing their batch; a locale the
    service rejects permanently is skipped the same way, while a transient
    failure writes what did succeed and then redelivers for the rest. It is
    idempotent (a redelivery finds nothing missing), best-effort (a failed
    enqueue leaves English), and never retries into the analysis idempotency
    gate.
  A locale counts as filled only when both fields are present; a half answer
  is requested again by the next job, and maps merge per field.
  The UI reads `translations[activeLocale]` through
  `frontend/src/i18n/analyzer-text.js` — card titles (`h3`),
  in-progress/completed card descriptions, the ticket detail and task-update
  dialogs — and falls back to the canonical English field. Cards in an
  active capture render from session state captured when the analysis
  landed, so a language switch also refetches the check once (and once more
  a few seconds later if the worker is still running) and merges the new
  locales into the session's concerns, conditions, and tasks by text
  (`frontend/src/services/session-translations.js`). On amendment
  refreshes, conditions the rulebase considers unchanged keep their stored
  answers and tasks and the maps merge per locale (one DynamoDB `Update` per
  task that differs); a condition whose English text changed is a new
  condition with only the locales its edit call returned, and the background
  job fills the rest.

## Key naming

`<area>.<element>[.<part>]`, lowerCamel segments joined by dots. Areas are the
screen or component (`today`, `check`, `siteAdmin`, `toast`, …) plus `common`.
Parts: `.aria` for accessible labels, `.placeholder`, `.title` / `.message` /
`.text`, `.one` / `.other` for plurals. Keys are stable ids, never the English
text. Generated namespaces (`rulebook.*`, `server.*`) are content-addressed and
are never referenced from code.

## Scripts (`frontend/scripts/`)

| Command | Purpose |
| --- | --- |
| `npm run i18n:check -w frontend` | Key parity, placeholder parity, naming, sorted keys; reports untranslated strings. Runs in CI. |
| `node scripts/i18n-rulebook.mjs [--all]` | Regenerate `rulebook.*` and `server.*` from the backend catalog and display tables. Run after the policy rows or 311 tables change. |
| `node scripts/i18n-merge.mjs <fragment.json>` | Add new English keys (and placeholders in every other catalog). |
| `node scripts/i18n-rename.mjs old new …` | Rename or consolidate keys, updating call sites. |
| `node scripts/i18n-apply.mjs <locale> <overlay.json…>` | Apply translations to one catalog; validates keys and placeholders. |
| `node scripts/i18n-literals.mjs <file…>` | Heuristic scan for English literals still in source. |

## Adding or changing copy

1. Add the English text under a new key via a fragment and `i18n-merge.mjs`.
2. Use `t("key")` at the call site; in `html` templates wrap with `escapeHtml`
   or `escapeAttr` as for any string.
3. Tests assert through `t()` (unit tests import it; e2e specs use
   `e2e/helpers/i18n.js`) and locate elements by ids or data attributes.
4. Translations for the other languages arrive as overlays through
   `i18n-apply.mjs`; until then the new key shows English, and `i18n:check`
   reports it as untranslated.

## Translation glossary

Current status: all four languages are machine first passes pending community
review (Spanish and Filipino drafted 2026-10-02, Vietnamese and Traditional
Chinese 2026-10-04).

Cross-language rules:

- Register: formal, addressed to a site staff member.
- Keep in English: "311", "911", the app name "Good Neighbor", product names
  (Recology, PG&E, AT&T, Shared Spaces), and agency acronyms in parentheses
  (DPW, SFPD, SFFD, SFMTA, DPH, SFACC, HSH, DEM, HSA, RPD, SFPUC, DT, MONS,
  MOD, USPS). Full agency names may be translated; acronyms stay so they match
  311 correspondence.
- Placeholders `{like_this}` are never translated or changed inside the
  braces; they may move within the sentence.
- `.aria` keys are screen-reader labels: short, no trailing period.
- `rulebook.*` and `server.*` are policy wording and 311 vocabulary; changes
  there need the policy team's review as well as a linguist's.

Spanish (es-US), "usted":

| English | Spanish |
| --- | --- |
| site | sitio |
| perimeter check / check | revisión del perímetro / revisión |
| issue / problem | problema |
| task | tarea |
| 311 request / ticket | solicitud 311 (action: presentar una solicitud al 311) |
| escalate | escalar |
| log action | registrar acción |
| the City | la Ciudad |
| settings / logout / attributions | configuración / cerrar sesión / atribuciones |
| to do / in progress / history | pendientes / en curso / historial |

Filipino (fil-PH), polite "kayo / ninyo", no "po"; common workplace loanwords
(site, update, email, app) stay English:

| English | Filipino |
| --- | --- |
| perimeter check / check | pagsuri sa paligid / pagsuri |
| issue / problem | problema |
| task | gawain |
| 311 request / ticket | tiket sa 311 (action: mag-file ng tiket sa 311) |
| escalate | i-escalate |
| log action | itala ang aksyon |
| the City | ang Lungsod |
| settings / logout / attributions | mga setting / mag-log out / mga pagkilala |
| to do / in progress / history | gagawin / isinasagawa / kasaysayan |

Vietnamese (vi-VN), "bạn", full diacritics; "Email" stays as the loanword:

| English | Vietnamese |
| --- | --- |
| site | địa điểm |
| perimeter check / check | kiểm tra quanh tòa nhà / đợt kiểm tra |
| issue / problem | vấn đề |
| task | nhiệm vụ |
| 311 request / ticket | yêu cầu 311 (action: gửi yêu cầu 311) |
| escalate | báo lên cấp trên |
| log action | ghi lại hành động |
| the City | Thành phố |
| client / resident | khách hàng / cư dân |
| settings / logout / attributions | cài đặt / đăng xuất / ghi nhận nguồn |
| to do / in progress / history | cần làm / đang xử lý / lịch sử |

Traditional Chinese (zh-Hant), "您", San Francisco Cantonese-community
wording (三藩市, not 舊金山), full-width punctuation in sentences:

| English | Traditional Chinese |
| --- | --- |
| site | 站點 |
| perimeter check / check | 周邊巡檢 / 巡檢 |
| issue / problem | 問題 |
| task | 任務 |
| 311 request / ticket | 311 工單 (action: 提交 311 工單) |
| escalate | 上報 |
| log action | 記錄行動 |
| the City | 市政府 |
| client / resident | 服務對象 / 住戶 |
| settings / logout / attributions | 設定 / 登出 / 資料出處 |
| to do / in progress / history | 待辦 / 處理中 / 歷史記錄 |
