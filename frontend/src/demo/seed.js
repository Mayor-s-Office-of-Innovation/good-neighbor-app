// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  Demo seed — a product-demo aid, NOT part of the real flow.

  The app has no backend dependency: onboarding (services/onboarding.js) and the
  analyzer (services/analyzer.js) are already mocked, and every screen renders off
  IndexedDB (site + checks) plus the in-memory session. So the only thing standing
  between a stakeholder and any screen state is *data*. This module writes that data
  directly, so the whole product can be walked without completing real checks.

  Trigger: a `?demo=` query param, read once at boot by main.js BEFORE app-root
  mounts. It is a no-op unless the param is present, so it never touches a normal run.

    /?demo=uptodate   home "Up to date" (5b): 3 checks in today + history, so the
                      donut, streak sparkline, and both worklist groups populate.
    /?demo=due        home "Check due now" (5a): populated history but 0 checks today.
    /results?demo=due jump straight to Results (5e) — it reads the latest seeded check.
    /?demo=reset      wipe the site + checks (back to the first-run setup screen).

  The param is stripped from the URL after seeding so a refresh doesn't re-seed.
*/
import { setSite, addCheck, clearChecks, clearSite, newId } from "../db.js";
import { severityWord } from "../config/scorecard.js";

const SITE_NAME = "Health Center — Mission";
const SITE_CODE = "HCM-4820";
const SIDES = ["North", "East", "South", "West"];
const STATUS_LABELS = ["Excellent", "Good", "Fair", "Poor", "Very poor"];

// A finding shaped exactly like domain/findings.js:scorecardToFindings output.
function finding(
  category,
  rating,
  hazard,
  explanation,
  side,
  sourceKind = "photo",
) {
  return {
    category,
    rating,
    severity: severityWord(rating),
    hazard,
    explanation,
    side,
    sourceKind,
    evidenceIndices: [0],
  };
}

// Curated findings drawn from the mock analyzer's canned text, one per triage bucket
// (check-results.js): hazard -> "City action", rating>=2 non-hazard -> "You can handle",
// rating 1 non-hazard -> "Noted, no action".
const HAZARD = [
  finding(
    "Sharps",
    3,
    true,
    "Two syringes near the tree well — do not handle.",
    "South",
  ),
  finding(
    "Human and Animal Waste",
    3,
    true,
    "Human waste in the doorway; steam-clean warranted.",
    "North",
  ),
  finding(
    "Fire & Safety Hazards",
    2,
    true,
    "Combustible material stacked against an exit.",
    "West",
  ),
];
const HANDLE = [
  finding(
    "Furniture & Large Debris",
    2,
    false,
    "A discarded chair partially blocking the walkway.",
    "East",
  ),
  finding(
    "Waste & Small Debris",
    2,
    false,
    "Cups, paper and loose litter along the gutter line.",
    "North",
  ),
];
const NOTED = [
  finding(
    "Graffiti",
    1,
    false,
    "Tagging on the transformer box.",
    "West",
    "note",
  ),
  finding(
    "Access Obstruction",
    1,
    false,
    "Construction fencing narrowing the accessible path.",
    "West",
    "note",
  ),
];

// A specific calendar day/time, `daysAgo` back, at `hour:minute` local.
function at(daysAgo, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// A time `mins` before *now* — used for today's checks so they never land in the
// future regardless of when the demo is opened (keeps them all "today").
function minsAgo(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() - mins);
  return d;
}

// Build one submitted check, mirroring the persisted shape from check-review._submit.
function buildCheck(siteId, when, findings) {
  const h = when.getHours();
  const window = h < 11 ? "morning" : h < 15 ? "midday" : "evening";
  const penalty = findings.reduce((s, f) => s + f.rating * 8, 0);
  const totalScore = Math.max(0, 100 - penalty);
  return {
    id: newId(),
    siteId,
    window,
    startedAt: new Date(when.getTime() - 4 * 60000).toISOString(),
    submittedAt: when.toISOString(),
    status: "submitted",
    statusLabel: STATUS_LABELS[Math.min(4, Math.floor(penalty / 20))],
    totalScore,
    sides: SIDES.map((side) => ({ side, applicable: true, itemCount: 2 })),
    findings,
    synced: false,
  };
}

// Prior-day history: enough spread for a believable streak sparkline and a
// last-6 mix that fills both worklist groups. Shared by both scenarios.
function historyChecks(siteId) {
  return [
    buildCheck(siteId, at(1, 9, 5), []),
    buildCheck(siteId, at(1, 13, 20), [HANDLE[1]]),
    buildCheck(siteId, at(1, 17, 40), [HAZARD[0], HANDLE[0]]),
    buildCheck(siteId, at(2, 10, 15), [NOTED[0]]),
    buildCheck(siteId, at(2, 16, 30), []),
    buildCheck(siteId, at(3, 12, 0), [HAZARD[1], HANDLE[1], NOTED[1]]),
    buildCheck(siteId, at(4, 9, 45), []),
    buildCheck(siteId, at(5, 15, 10), [HANDLE[0]]),
  ];
}

// Today's three checks (CADENCE=3) — flips the home to "Up to date" (5b).
function todayChecks(siteId) {
  return [
    buildCheck(siteId, minsAgo(230), []),
    buildCheck(siteId, minsAgo(130), [HANDLE[0]]),
    buildCheck(siteId, minsAgo(25), [HAZARD[0], NOTED[0]]),
  ];
}

const SCENARIOS = ["uptodate", "due", "reset"];

/**
 * Seed IndexedDB for a demo if `?demo=<scenario>` is in the URL, else do nothing.
 * Must be awaited before app-root reads the DB (see main.js).
 */
export async function maybeRunDemo() {
  const scenario = new URLSearchParams(location.search).get("demo");
  if (!scenario) return;
  if (!SCENARIOS.includes(scenario)) {
    stripParam();
    return;
  }

  await clearChecks();
  if (scenario === "reset") {
    await clearSite();
    stripParam();
    return;
  }

  const site = await setSite(SITE_NAME, { code: SITE_CODE });
  const checks =
    scenario === "uptodate"
      ? [...historyChecks(site.id), ...todayChecks(site.id)]
      : historyChecks(site.id);
  for (const c of checks) await addCheck(c);
  stripParam();
}

// Drop ?demo= from the address bar so a manual refresh doesn't re-seed, while
// keeping the current path (so /results?demo=due lands on Results, not home).
function stripParam() {
  const url = new URL(location.href);
  url.searchParams.delete("demo");
  history.replaceState({}, "", url.pathname + url.search + url.hash);
}
