/*
  Pure transforms: a streetconditions scorecard -> the findings we show on 5e.

  v1 groups findings BY SEVERITY straight from the scorecard — no triage buckets and
  no recommended actions (that layer is deferred; see docs/take5-plan.md). Severity is
  carried by the group + the severity word, never color alone (WCAG 1.4.1).

  A "finding" is a scorecard entry with rating >= 1 (drop the rating-0 rows). Groups:
    - hazard   : hazard === true            (pulled out regardless of rating)
    - major    : rating 2-3, non-hazard     ("moderate & severe")
    - minor    : rating 1, non-hazard
*/
import { severityWord } from "../config/scorecard.js";

/**
 * @param {{ratings_details:Array<{category,rating,hazard,explanation,evidence_indices}>}} scorecard
 * @param {Array<{side?:string, kind?:string}>} items  capture items, indexed by evidence_indices
 * @returns {Array<object>} findings (rating >= 1)
 */
export function scorecardToFindings(scorecard, items = []) {
  return scorecard.ratings_details
    .filter((r) => r.rating >= 1)
    .map((r) => {
      const src = items[r.evidence_indices?.[0]] || null;
      return {
        category: r.category,
        rating: r.rating,
        severity: severityWord(r.rating),
        hazard: !!r.hazard,
        explanation: r.explanation,
        side: src?.side || null,
        sourceKind: src?.kind || null,
        evidenceIndices: r.evidence_indices || [],
      };
    });
}

/**
 * A clean check = every category rating 0.
 * @param {{ratings_details:Array<{rating:number}>}} scorecard
 */
export function isClean(scorecard) {
  return scorecard.ratings_details.every((r) => r.rating === 0);
}

const GROUP_META = {
  hazard: {
    key: "hazard",
    title: "Hazard",
    note: "Do not handle — report to the city.",
  },
  major: { key: "major", title: "Moderate & severe", note: "Needs attention." },
  minor: { key: "minor", title: "Minor", note: "Noted." },
};

/**
 * Group findings for display: hazard first, then major (2-3), then minor (1).
 * @param {Array<object>} findings
 * @returns {Array<{key,title,note,items:Array<object>}>} non-empty groups, in order
 */
export function groupBySeverity(findings) {
  const buckets = { hazard: [], major: [], minor: [] };
  for (const f of findings) {
    if (f.hazard) buckets.hazard.push(f);
    else if (f.rating >= 2) buckets.major.push(f);
    else buckets.minor.push(f);
  }
  return ["hazard", "major", "minor"]
    .filter((k) => buckets[k].length)
    .map((k) => ({ ...GROUP_META[k], items: buckets[k] }));
}
