# Admin Interface Simplification Plan

**Status:** Approved for execution — companion to
[legacy-submit-path-retirement-plan.md](./legacy-submit-path-retirement-plan.md)
**Date:** 2026-09-11
**Scope:** post-#201 admin/setup-code code (auth updates + admin API + setup-code lifecycle)

## 0. Session context (regain context fast)

- **Branch:** `docs/dataflow`, same as the retirement plan (see its § 0). Both docs were
  written in the same working session on that branch.
- **Origin:** after the dev merge (5a95342, PR #201 feature/180-login-auth-updates), a
  second agent's complexity notes on the new admin code were **validated item-by-item
  against the merged tree** before being folded in — verdicts in § 2 include two
  corrections to that agent's framing (§ 2.2 imprecise duplication claim, § 2.5
  prescription disagreement). Trust the § 2 verdicts, not the original notes.
- **The owner approved:** sibling plan to the retirement plan, sharing its PR lettering
  (PR-B/C/D extensions). Nothing here is scheduled yet; execution order follows the
  retirement plan's § 6 sequencing.
- **Companion findings beyond the second agent's list:** `codeId` stored-but-never-read
  (stronger than the naming complaint — deletable entirely); `"expired"` status never
  settable (dead enum value).
- **Key code anchors:** setup-codes.js 640 lines (issue/validate/revoke/CAS), admin.js
  867 lines, api.tf:139-140 (the ternaries), main.tf:478-495 (GSI6/7), main.tf:511-514
  (TTL wired-but-inactive), site-code-lifecycle-plan.md:169 (the drift line).

## 1. Context

The admin interface (PR #201, feature/180-login-auth-updates) added an admin API
(handlers/admin.js), dynamic setup codes (handlers/setup-codes.js + GSI6/GSI7 + a
`SETUP_CODE_CURRENT#` reference item), an admin JWT authorizer, and 20+ new routes across
three hand-synced route tables. A review pass found six complexity items. Each was
verified against the merged tree; verdicts and corrections below.

Character of this plan differs from the retirement plan: the retirement deletes
**unreachable** code; most of this plan simplifies **reachable** code (dead-loop collapse,
attribute dedup, file split) or removes real drift. Two items are deliberate trade-offs
recorded as declined rather than changed (§ 6).

## 2. Validated findings

### 2.1 Route tables triplicated — real; fix the terraform legibility + drift risk

Three lists must stay in sync by hand, and all three admit it:

- `backend/src/lambda/api.js:69` — 45 routes ("keep all three in step", :6)
- `backend/scripts/local-api.mjs:139-207` — 46 entries ("Terraform stays the source of
  truth", :9-10)
- `infra/modules/app/api.tf:8-57` — 45 routes

The authorizer-selection at api.tf:139-140 nests four `startswith()` calls per attribute,
duplicated across both `authorization_type` and `authorizer_id`, gated on the
`route_is_open` map. Near-illegible and easy to get wrong when adding an admin route.

**Fix (PR-C):** replace `route_is_open` + both ternaries with one declarative local:

```hcl
# Per-route authorization: "open" (no authorizer), "admin" (Cognito JWT),
# "device" (device-token CUSTOM). Absent key ⇒ device, fail-closed.
route_authorization = {
  "POST /site-code" = "open"
  "POST /v1/devices" = "open"
  ...
}
authorization_type = try(local.route_authorization[each.value], "device") == "open" ? null : ...
authorizer_id      = ... aws_apigatewayv2_authorizer.admin_jwt.id : aws_apigatewayv2_authorizer.device_token.id
```

(Exact shape at implementation time; the point is one map, no startswith chains.)

**Full triplication collapse (generation from one table) is out of scope** — local-api.mjs
is a plain-HTTP dev stand-in with stub events and can't share the Lambda's route map
verbatim. Recorded as a declined item (§ 6) with the existing "keep in step" comments as
the mitigation.

### 2.2 Setup-code lookup structures — partially valid; one consolidation declined

Current structures per code: verifier item (`pk = SETUP_CODE#<hmac(code)>`), a
`SETUP_CODE_CURRENT#<siteId>#<contactHash>` reference item, GSI6 (pending codes by
site+contact), GSI7 (pending codes by site).

The "CURRENT and GSI6 largely duplicate" framing is imprecise: they serve different access
patterns — CURRENT is a single consistent `Get` for CAS-guarded issuance and
`isCurrentSetupCode` (setup-codes.js:556); GSI6 is a set scan for per-contact revocation
(admin.js:633), GSI7 for site-wide deactivation (admin.js:722). CURRENT is derivable as
"newest GSI6 entry" (revoked items are stripped from GSI6, so GSI6 = pending set), but
that trades one consistent read for a query+sort on the issuance hot path. **Declined for
now** (§ 6); revisit if the code-issuance volume ever makes the extra item a cost.

### 2.3 Dead retry loop in code issuance — collapse to single-shot

`reserveCurrentSetupCode` (setup-codes.js:375-388) loops 5× but calls
`writeCurrentSetupCode` unguarded and `return`s immediately — any
`ConditionalCheckFailedException` (verifier-pk collision or CAS loss on CURRENT) propagates
to `issueSetupCode`'s outer loop (setup-codes.js:156). The inner loop body can never
execute twice. `SETUP_CODE_GENERATION_ATTEMPTS` is a no-op constant.

**Fix (PR-B):** make `reserveCurrentSetupCode` single-shot; the outer
`SETUP_CODE_ISSUANCE_ATTEMPTS` loop already regenerates a code and re-runs the CAS — which
is the collision-retry behavior the inner loop claimed to provide. Net: dead code removed
**and** a real bug fixed (today a collision aborts issuance to the user instead of
regenerating; after the fix the outer loop handles it).

### 2.4 Small dead weights in setup-codes.js

All confirmed; fix in PR-B:

- **`codeId` is stored but never read.** Only consumer is `currentSetupCodeReferenceItem`
  (:503) copying it as `currentCodeId` — and nothing reads `currentCodeId` either. Delete
  the attribute, the `codeId` typedef field, and `currentCodeId`.
- **`randomCodeId`/`cryptoRandomFallback`** (setup-codes.js:583-595) — an indirection pair
  for 16 random alphabet chars, named as if it were a fallback. With `codeId` deleted both
  functions go.
- **`codeVerifier` stored next to a pk that embeds it** (:452-453). Keep the pk
  (`SETUP_CODE#<hmac>` is what makes cross-site `attribute_not_exists` uniqueness work),
  drop the duplicate ~64-byte attribute — or keep it if a read ever needs the verifier
  without key access; simplest is to drop it and note the pk *is* the verifier in the
  item doc.
- **`setupCodePk` export unused externally** (:228) — unexport; `setupCodePkFromVerifier`
  remains the internal builder.

### 2.5 admin.js — split per entity; HOFs judged a wash

`handlers/admin.js` is 867 lines mixing providers, sites, master/code contacts, devices,
search plumbing, and the `adminOnly` gate. The `contactLister/Creator/Deactivator` HOF
factories (:551, :576, :612) save ~100 lines over six explicit handlers but cost
greppability; each is called only 2-3 times.

**Fix (PR-B):** split per entity — `admin-providers.js`, `admin-sites.js`,
`admin-contacts.js` (+ keep `admin.js` as the `adminOnly` gate + issue-code/device
handlers, or fold those into sites/devices files). While splitting, inline the three
factories into explicit handlers (~+30 lines, real readability gain). Update
`lambda/api.js` + `local-api.mjs` imports; admin.test.js moves per entity.

### 2.6 Doc/impl drift in site-code-lifecycle-plan.md — deviation notes

- **Keying deviation:** plan line 169 specifies `pk = SITE#<siteId>`,
  `sk = SETUP_CODE#<codeId>`; implementation uses a **global** verifier pk
  (`SETUP_CODE#<hmac>`) + GSI6/7. The global pk is deliberate — it's what makes
  `attribute_not_exists` enforce code uniqueness across all sites — but the doc must say
  so rather than silently diverging.
- **Audit claim unimplemented:** "Audited when issued, used, expired, or revoked"
  (line 40) has no corresponding code — zero audit item writes exist in setup-codes.js or
  admin.js. Either implement audit items or amend the claim to what is recorded today
  (status + `revokedReason` + timestamps on the code item itself).
- **`"expired"` status is dead in the typedef** (setup-codes.js:37) — nothing ever sets
  it; expiry is enforced by timestamp comparison (`isSetupCodeUsable`) and
  `expiresAt > :now` in the consume condition. Drop the enum value or implement a sweep;
  TTL is wired-but-inactive per main.tf:511-514 (documented post-MVP retention deferral —
  consistent, but the plan doc's audit/expired language predates that decision).

## 3. Deletion/fix batches

Extend the retirement plan's PR lettering so the two plans interleave:

- **PR-B extension (backend, with the retirement deletions):**
  collapse `reserveCurrentSetupCode` to single-shot (§ 2.3); delete `codeId`,
  `currentCodeId`, `randomCodeId`/`cryptoRandomFallback`, `setupCodePk` export, the
  duplicated `codeVerifier` attribute (§ 2.4); split admin.js per entity and inline the
  contact HOFs (§ 2.5); drop the unused `"expired"` enum value (§ 2.6)
- **PR-C extension (infra):** hoist `route_authorization` local map replacing
  `route_is_open` + the startswith ternaries (§ 2.1)
- **PR-D extension (docs):** deviation notes in site-code-lifecycle-plan.md — keying,
  audit, expired-status, TTL-inactive (§ 2.6); link this plan

## 4. Kept as-is (judgment calls, for reviewers)

- The verifier-pk scheme itself (`SETUP_CODE#<hmac>`) — correct, enables global uniqueness
- GSI6 + GSI7 — distinct revocation access patterns, both consumed (admin.js:633, :722)
- `CURRENT` reference item — declined to consolidate (§ 2.2); it's the CAS anchor
- `adminOnly`/`isCentralAdmin` gate — single chokepoint, fine

## 5. Verification gates

Same as the retirement plan (§ 5): typecheck/lint/tests, local-harness smoke of the
admin + device-registration flows, grep sweep for deleted symbols
(`reserveCurrentSetupCode` inner-loop semantics, `codeId`, `randomCodeId`,
`setupCodePk` external refs). For PR-C: terraform plan shows only the expected diff.

## 6. Declined (considered and rejected — with reasons, so they aren't re-litigated)

1. **Deriving CURRENT from GSI6** (§ 2.2) — trades one consistent `Get` for a query+sort
   on the issuance hot path and couples the CAS anchor to a scan. Revisit only if
   issuance volume ever makes the extra item costly.
2. **Single source of truth for route tables** (generation script from one table) —
   desirable but cross-cutting (lambda + local dev tool + terraform with different
   shapes); the in-file "keep in step" comments stay until that larger change.
3. **Dropping the contact HOFs without splitting files** — inline-and-split together
   (§ 2.5); inlining alone buys greppability at +30 lines for no structural gain.