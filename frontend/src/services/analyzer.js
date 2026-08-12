/*
  MOCK analyzer, shaped exactly like streetconditions.org's real output.

  A perimeter check's captures (photos / voice / notes) are fed to the SAME 12-category
  rubric and the tool returns a fixed scorecard: every category, every time, with a
  severity `rating` 0-3 and a `hazard` flag. `rating` is severity, NOT confidence
  (there is no confidence field in the real tool) — see docs/take5-plan.md.

  SWAP POINT: replace analyzeCheck() with the server-mediated call (client uploads
  media -> our backend calls streetconditions with a held credential -> returns JSON).
  Keep the input (items[]) and output (scorecard) shapes and no UI changes.

  Scorecard shape (per submission):
    {
      total_score: number 0-100,
      status_label: 'Excellent'|'Good'|'Fair'|'Poor'|'Very poor'|'Maintain',
      ratings_details: [
        { category, rating: 0-3, hazard: bool, explanation, evidence_indices:number[] },
        ... one per CATEGORIES entry, always 12 ...
      ]
    }
*/
import { CATEGORIES } from "../config/scorecard.js";

// Plausible explanation + hazard disposition per category, keyed by the rating that
// makes it non-zero. Kept here (not in the shared config) because it's mock-only text.
const CANNED = {
  "Waste & Small Debris": {
    hazard: false,
    text: "Cups, paper and loose litter along the gutter line.",
  },
  "Furniture & Large Debris": {
    hazard: false,
    text: "A discarded chair partially blocking the walkway.",
  },
  "Human and Animal Waste": {
    hazard: true,
    text: "Human waste in the doorway; steam-clean warranted.",
  },
  Sharps: {
    hazard: true,
    text: "Two syringes near the tree well — do not handle.",
  },
  "Unsheltered Presence": {
    hazard: false,
    text: "One individual sheltering against the building.",
  },
  "Fire & Safety Hazards": {
    hazard: true,
    text: "Combustible material stacked against an exit.",
  },
  "Access Obstruction": {
    hazard: false,
    text: "Construction fencing narrowing the accessible path.",
  },
  Graffiti: { hazard: false, text: "Tagging on the transformer box." },
  Animals: { hazard: false, text: "An unattended dog near the corner." },
  "Active Drug Use": {
    hazard: true,
    text: "Signs of active drug use observed on site.",
  },
  "Public Health Need": {
    hazard: false,
    text: "Someone appears to need a wellness check.",
  },
  "RV or other inhabited vehicle": {
    hazard: false,
    text: "An inhabited vehicle parked along the frontage.",
  },
};

const STATUS_LABELS = ["Excellent", "Good", "Fair", "Poor", "Very poor"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A deterministic seed from what was captured, so the mock feels responsive to the
// actual walk without needing Math.random (keeps results reproducible in a session).
function seedFrom(items) {
  let s = items.length * 31;
  for (const it of items) {
    if (it.kind === "note") s += (it.text || "").length;
    else s += (it.size || 0) % 997;
    s += it.side ? it.side.charCodeAt(0) : 0;
  }
  return Math.abs(s);
}

/**
 * Analyze a whole check's captures and return one scorecard.
 * @param {Array<{kind:'photo'|'voice'|'note', side?:string, size?:number, text?:string}>} items
 * @returns {Promise<{total_score:number,status_label:string,ratings_details:Array<{category:string,rating:number,hazard:boolean,explanation:string,evidence_indices:number[]}>}>}
 */
export async function analyzeCheck(items) {
  await delay(900); // feel like a real round-trip
  const seed = seedFrom(items);
  const n = Math.max(1, items.length);

  // Pick a handful of categories to flag, driven by the seed. The rest stay rating 0.
  const flagCount = 3 + (seed % 3); // 3-5 non-zero categories
  const flagged = new Set();
  for (let i = 0; i < flagCount; i++) {
    flagged.add(CATEGORIES[(seed + i * 5) % CATEGORIES.length]);
  }

  const ratings_details = CATEGORIES.map((category, ci) => {
    if (!flagged.has(category)) {
      return {
        category,
        rating: 0,
        hazard: false,
        explanation: "",
        evidence_indices: [],
      };
    }
    const canned = CANNED[category] || {
      hazard: false,
      text: "Condition noted on site.",
    };
    // Rating 1-3; hazard categories skew more severe.
    const base = (seed + ci * 3) % 3; // 0-2
    const rating = canned.hazard ? Math.min(3, base + 2) : base + 1;
    return {
      category,
      rating,
      hazard: canned.hazard && rating >= 2,
      explanation: canned.text,
      evidence_indices: [(seed + ci) % n],
    };
  });

  // total_score: 100 minus a penalty per severity point (mock heuristic).
  const penalty = ratings_details.reduce((sum, r) => sum + r.rating * 8, 0);
  const total_score = Math.max(0, 100 - penalty);
  const status_label =
    STATUS_LABELS[Math.min(STATUS_LABELS.length - 1, Math.floor(penalty / 20))];

  return { total_score, status_label, ratings_details };
}
