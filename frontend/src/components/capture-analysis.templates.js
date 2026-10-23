import { html, escapeHtml } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { visibleProblemSelection } from "./analysis-results.templates.js";
import "./capture-analysis.css";

// Catalog keys keep rubric names localized; aliases cover older analyzer results.
const categories = [
  ["litter", "litter-b192", "waste & small debris"],
  ["bulky", "bulky-items-c8c9", "bulky items", "large waste"],
  ["feces", "feces-and-urine-1f09", "feces and urine", "feces or urine"],
  ["needles", "needles-d5d8"],
  [
    "encampment",
    "tents-tarps-or-bedding-6368",
    "tents, tarps, or bedding",
    "temporary shelters",
  ],
  ["graffiti", "graffiti-d371"],
  ["fire", "fire-hazard-0363", "fire hazard"],
  [
    "blocked",
    "blocked-doorway-or-sidewalk-6db3",
    "blocked doorway or sidewalk",
    "blocking access",
  ],
  ["drugs", "public-drug-use-9638", "public drug use"],
  [
    "distress",
    "someone-in-distress-0d4e",
    "someone in distress",
    "behavioral health",
  ],
  ["animals", "animals-1780", "aggressive animals", "dangerous animals"],
  ["medical", "medical-emergency-1a14", "medical emergency"],
  [
    "threats",
    "threats-intimidation-or-violence-9166",
    "threats, intimidation, or violence",
    "intimidation, or violence",
    "intimidation or violence",
    "intimidation and violence",
  ],
  ["parking", "illegal-parking-878a", "illegal parking"],
];

/** @param {import("./analysis-results.templates.js").AnalysisItem} item */
const isPending = (item) =>
  ["queued", "analyzing"].includes(item.analysis?.status);

/** Decorative scanner is present only while this photo is pending. */
export function analysisScanner(item) {
  if (!isPending(item)) return "";
  return html`<span class="capture-scanner" aria-hidden="true"
    ><span class="capture-scanner__band"
      >${Array.from({ length: 8 }, () => "<span></span>").join("")}</span
    ></span
  >`;
}

/**
 * One deduplicated rubric list for the roll, followed by the pending placeholder.
 * @param {import("./analysis-results.templates.js").AnalysisItem[]} items
 * @returns {string}
 */
export function captureLabels(items) {
  const found = new Map();
  for (const item of items) {
    const { visibleConditions, visibleTasks } = visibleProblemSelection(item);
    for (const record of [...visibleConditions, ...visibleTasks]) {
      const names = [
        "canonicalCategory" in record ? record.canonicalCategory : "",
        record.category,
        record.analyzerCategory,
      ]
        .filter(Boolean)
        .map((name) => name.trim().toLowerCase());
      const category = categories.find(([icon, , ...aliases]) =>
        names.some((name) => [icon, ...aliases].includes(name)),
      );
      if (category) found.set(category[1], category[0]);
    }
  }
  const labels = [...found]
    .map(
      ([key, icon]) =>
        html` <div class="capture-label" data-category="${key}">
          <span class="capture-category-icon" aria-hidden="true">
            ${icon === "parking"
              ? '<wa-icon name="flag"></wa-icon>'
              : html`<img
                    class="capture-category-icon--light capture-category-icon--${icon}-light"
                    src="/category-icons/${icon}-light.png"
                    alt=""
                  />
                  <img
                    class="capture-category-icon--dark capture-category-icon--${icon}-dark"
                    src="/category-icons/${icon}-dark.png"
                    alt=""
                  />`}
          </span>
          <span>${escapeHtml(t(`rulebook.category.${key}`))}</span>
        </div>`,
    )
    .join("");
  return (
    labels +
    (items.some(isPending)
      ? html` <div class="capture-label capture-label--pending">
          <wa-icon name="sparkles" aria-hidden="true"></wa-icon>
          <span class="capture-label__skeleton" aria-hidden="true"></span>
          <span class="visually-hidden"
            >${escapeHtml(t("card.pending.title"))}</span
          >
        </div>`
      : "")
  );
}
