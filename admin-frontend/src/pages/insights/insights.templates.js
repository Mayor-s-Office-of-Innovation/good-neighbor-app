// Shared, so Overview and Site insights show periods and data times alike.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import {
  formatDateTime,
  pacificDateKey,
} from "../../../../frontend/src/i18n/dates.js";
import {
  addDays,
  dayInstant,
  dayKeysBetween,
} from "../../../../frontend/src/domain/reports-periods.js";
import { escapeHtml } from "../../dom.js";
import {
  customPeriodError,
  intervalOf,
  periodOf,
  periodSearch,
  quarterOf,
  samePeriod,
  stepPeriod,
} from "./insights-query.js";

/** @typedef {import("./insights-query.js").Period} Period */
/** @typedef {{ kind: string, startDay: string, endDay: string, incomplete: boolean, observedTo?: string }} Interval */
/** @typedef {{ asOf: string | null, interval: Interval | null, dataQuality: { reasons: string[], coverageStart: string | null } }} ReplyMeta */

/** @param {string} day e.g. "Oct 2, 2026" */
export function formatDay(day) {
  return formatDateTime(dayInstant(day), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** @param {string | null} instant e.g. "Nov 4, 10:00 AM" */
export function formatInstant(instant) {
  return instant
    ? formatDateTime(instant, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

/** Catalog keys are lowerCamel; server codes are snake_case. @param {string} prefix @param {string} code */
export const codeKey = (prefix, code) =>
  `${prefix}.${code.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;

/** @param {Interval} interval e.g. "October 2026", "Q3 2026" or "FY 2025–26" */
export function periodLabel(interval) {
  const start = interval.startDay;
  if (interval.kind === "month")
    return formatDateTime(dayInstant(start), {
      month: "long",
      year: "numeric",
    });
  if (interval.kind === "quarter") {
    const { year, quarter } = /** @type {{ year: number, quarter: number }} */ (
      quarterOf(start)
    );
    // The field app's reports name quarters this way too.
    return t("reports.period.quarter", { quarter, year });
  }
  if (interval.kind === "year") return start.slice(0, 4);
  if (interval.kind === "financialYear")
    return t("admin.insights.period.fy", {
      start: start.slice(0, 4),
      end: String(Number(start.slice(0, 4)) + 1).slice(2),
    });
  return rangeLabel(interval);
}

/** @param {Interval} interval e.g. "Oct 1, 2026 to Oct 31, 2026" */
export function rangeLabel(interval) {
  return t("admin.insights.period.range", {
    from: formatDay(interval.startDay),
    to: formatDay(addDays(interval.endDay, -1)),
  });
}

/** @param {{ startDay: string, endDay: string }} interval endDay is the day after the last */
export const intervalText = (interval) =>
  t("admin.insights.interval", {
    from: formatDay(interval.startDay),
    to: formatDay(interval.endDay),
  });

/** A running period's counts stop at the data time, so the footer ends there too. @param {Interval} interval */
export const footerText = (interval) =>
  interval.incomplete && interval.observedTo
    ? t("admin.insights.intervalSoFar", {
        from: formatDay(interval.startDay),
        to: formatInstant(interval.observedTo),
      })
    : intervalText(interval);

/** Under the count, so people see which days the numbers cover. @param {ParentNode} root @param {Interval | null} interval */
export function drawInterval(root, interval) {
  const line = root.querySelector("[data-insights-interval]");
  if (line) line.textContent = interval ? footerText(interval) : "";
}

/** The server rounds to one decimal before it flags, so the page shows the same. @param {number} perDay */
export const oneDecimal = (perDay) => perDay.toFixed(1);

/** @param {number} perDay */
export const perDayText = (perDay) =>
  t("admin.insights.perDay", { value: oneDecimal(perDay) });

/** @param {{ startDay: string, endDay: string }} interval end exclusive */
export const periodDays = (interval) =>
  dayKeysBetween(interval.startDay, interval.endDay).length;

/** @param {number} value */
export const per30Text = (value) =>
  t("admin.insights.per30d", { value: oneDecimal(value) });

/** No records cover this period, so its zeros aren't real. @param {ReplyMeta} meta */
export function noDataFor(meta) {
  const start = meta.dataQuality?.coverageStart;
  return (
    (meta.dataQuality?.reasons ?? []).includes("before_coverage") &&
    (!start || (!!meta.interval && meta.interval.endDay <= start))
  );
}

/** A state added on the server later reads as Unknown, not a key. @param {{ state: string }} contact */
export function contactWord(contact) {
  const key = `admin.insights.contact.${contact.state}`;
  return t(hasKey(key) ? key : "admin.insights.contact.unknown");
}

/**
 * "?" help, opened by click so touch screens can read it too.
 * @param {string} id unique on the page; also names the anchor
 * @param {string} topic what it explains, for its button's name
 * @param {string} text already translated
 */
export function helpTip(id, topic, text) {
  // Anchor positioning keeps the bubble by its "?"; elsewhere it centres.
  return `<button type="button" class="btn-plain insights__tip" popovertarget="${id}" aria-label="${escapeHtml(t("admin.insights.helpFor", { topic }))}" style="anchor-name:--${id}">?</button><span id="${id}" popover class="insights__tip-body" data-help="${id}" style="position-anchor:--${id}">${escapeHtml(text)}</span>`;
}

/** Says how old the data is and why counts may be short, so no one reads a gap as zero. @param {ReplyMeta | null} meta */
export function freshnessView(meta) {
  if (!meta)
    return `<p class="muted insights__freshness" data-insights-freshness>${escapeHtml(t("admin.insights.dataAsOfPending"))}</p>`;
  const time = formatInstant(meta.asOf);
  const reasons = new Set(meta.dataQuality?.reasons ?? []);
  const coverageStart = meta.dataQuality?.coverageStart;
  // A running period is marked on the period control instead.
  const notes = [
    reasons.has("stale_snapshot") && t("admin.insights.quality.stale"),
    reasons.has("before_coverage") &&
      (!coverageStart
        ? t("admin.insights.quality.noCoverage")
        : noDataFor(meta)
          ? t("admin.insights.empty.noData", { day: formatDay(coverageStart) })
          : t("admin.insights.quality.beforeCoverage", {
              day: formatDay(coverageStart),
            })),
    (reasons.has("undated_issues") || reasons.has("undated_checks")) &&
      t("admin.insights.quality.undated"),
  ].filter((note) => typeof note === "string");
  return `<p class="muted insights__freshness" data-insights-freshness>${escapeHtml(
    time
      ? t("admin.insights.dataAsOf", { time })
      : t("admin.insights.dataAsOfUnknown"),
  )}</p>${
    notes.length
      ? `<p class="insights__quality" data-insights-quality role="note"><strong>${escapeHtml(t("admin.insights.quality.label"))}</strong> ${notes
          .map((note) => `<span>${escapeHtml(note)}</span>`)
          .join(" · ")}</p>`
      : ""
  }`;
}

const KINDS = /** @type {const} */ ([
  "month",
  "quarter",
  "year",
  "financialYear",
  "custom",
]);

/** @param {Interval | null} interval */
export const periodName = (interval) =>
  interval ? periodLabel(interval) : t("common.loading");

/**
 * Custom waits for "Show period", so half-typed dates don't load. With no
 * interval yet, only Custom works: the server hasn't said which month it chose.
 * @param {{ interval: Interval | null, kind: string, draft: { from: string, to: string }, error: string, dataTime?: string | null }} view
 *   dataTime: the reply's data time; the browser clock would claim data no snapshot holds
 */
export function periodView({ interval, kind, draft, error, dataTime = null }) {
  const kinds = `<div class="insights__ptabs" role="group" aria-label="${escapeHtml(t("admin.insights.period.kinds"))}">${KINDS.map(
    (k) =>
      `<button type="button" class="btn-plain" data-period-kind="${k}" aria-pressed="${k === kind}" ${!interval && k !== "custom" ? "disabled" : ""}>${escapeHtml(t(`admin.insights.period.${k}`))}</button>`,
  ).join("")}</div>`;
  const body =
    kind === "custom"
      ? `<div class="insights__custom">
          <wa-input type="date" id="insights-period-from" label="${escapeHtml(t("admin.insights.period.from"))}" value="${escapeHtml(draft.from)}" size="s"></wa-input>
          <wa-input type="date" id="insights-period-to" label="${escapeHtml(t("admin.insights.period.to"))}" value="${escapeHtml(draft.to)}" size="s"></wa-input>
          <button type="button" class="btn-secondary" id="insights-period-apply">${escapeHtml(t("admin.insights.period.apply"))}</button>
        </div>`
      : `<div class="insights__stepper">
          <button type="button" class="btn-icon" data-period-step="-1" aria-label="${escapeHtml(t("admin.insights.period.previous"))}" ${interval ? "" : "disabled"}><wa-icon name="chevron-left" aria-hidden="true"></wa-icon></button>
          <span class="insights__period-label" data-period-label>${escapeHtml(periodName(interval))}</span>
          <button type="button" class="btn-icon" data-period-step="1" aria-label="${escapeHtml(t("admin.insights.period.next"))}" ${!interval || interval.incomplete ? "disabled" : ""}><wa-icon name="chevron-right" aria-hidden="true"></wa-icon></button>
        </div>`;
  const pill =
    interval?.incomplete && dataTime
      ? `<span class="insights__pill" data-period-incomplete>${escapeHtml(
          t("admin.insights.period.incomplete", {
            time: formatInstant(dataTime),
          }),
        )}</span>`
      : "";
  return `<div class="insights__period" role="group" aria-label="${escapeHtml(t("admin.insights.period.label"))}">
    ${kinds}${body}${pill}
  </div>${error ? `<p class="error" role="alert" data-period-error>${escapeHtml(t(error))}</p>` : ""}`;
}

/**
 * A running period switches to the one holding today, a finished one to its start.
 * @param {string} kind
 * @param {Interval} interval
 * @returns {Period | null} null when the period needs the user's dates
 */
export function periodForKind(kind, interval) {
  const day =
    interval.incomplete && interval.observedTo
      ? pacificDateKey(interval.observedTo)
      : interval.startDay;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (kind === "month") return { kind: "month", month: day.slice(0, 7) };
  if (kind === "quarter") return quarterOf(day);
  if (kind === "year") return { kind: "year", year };
  if (kind === "financialYear")
    return { kind: "financialYear", startYear: month >= 7 ? year : year - 1 };
  return null;
}

/** Checked before asking, so a bad range never costs a request. @param {Element} root */
export function customDraft(root) {
  const value = (/** @type {string} */ id) =>
    String(/** @type {any} */ (root.querySelector(id))?.value ?? "");
  const from = value("#insights-period-from");
  const to = value("#insights-period-to");
  return { from, to, error: customPeriodError(from, to) };
}

/** A Web Awesome input throws if focused before it renders. @param {Element | null} element */
export function focusSoon(element) {
  const el = /** @type {any} */ (element);
  if (!el) return;
  if (!el.updateComplete) {
    el.focus();
    return;
  }
  const before = document.activeElement;
  void el.updateComplete.then(() => {
    // The user may have moved on, or a later redraw replaced the input.
    if (el.isConnected && document.activeElement === before) el.focus();
  });
}

// Controls a redraw may replace, found again by what they do.
const FOCUS_KEYS = ["data-period-step", "data-period-kind", "id"];
const DRAFT_IDS = ["#insights-period-from", "#insights-period-to"];

/**
 * Puts focus back on the control the redraw replaced. Half-typed dates
 * survive a load that ends mid-typing, unless the period changed.
 * @param {HTMLElement} region
 * @param {() => string} markup
 * @param {boolean} [keepTyped]
 */
export function redrawKeepingFocus(region, markup, keepTyped = true) {
  const active = document.activeElement;
  const key =
    active && region.contains(active)
      ? FOCUS_KEYS.find((name) => active.hasAttribute(name))
      : undefined;
  const value = key ? active?.getAttribute(key) : null;
  const typed = DRAFT_IDS.map(
    (id) => /** @type {any} */ (region.querySelector(id))?.value,
  );
  region.innerHTML = markup();
  // An empty box holds nothing typed, so the dates the redraw filled in stay.
  if (keepTyped)
    DRAFT_IDS.forEach((id, i) => {
      const input = /** @type {any} */ (region.querySelector(id));
      if (input && typed[i]) input.value = typed[i];
    });
  if (!key || value === null) return;
  const same = /** @type {HTMLButtonElement | null} */ (
    region.querySelector(`[${key}="${CSS.escape(value)}"]`)
  );
  // Next is disabled on the running period; focus mustn't drop to the page.
  const target = same?.disabled
    ? region.querySelector(`[${key}]:not([disabled])`)
    : same;
  focusSoon(target);
}

/**
 * fallback: the period the controls show when the first load failed before the server named one.
 * @typedef {{ period: Period | null, periodKind: string, periodError: string, reply: Record<string, any> | null, fallback?: Period | null, periodPicked: (period: Period) => void }} PeriodHost
 */

/** The month holding today, in Pacific time. @param {Date} [now] @returns {Period} */
export const monthOfToday = (now = new Date()) => ({
  kind: "month",
  month: pacificDateKey(now).slice(0, 7),
});

/**
 * The reply's interval if it answers the period asked for, else the
 * period's own days, so the controls still work after a failed load.
 * @param {PeriodHost} host
 * @returns {Interval | null} null until the server names its default period
 */
export function periodInterval(host) {
  const replied = host.reply?.meta.interval ?? null;
  const period = host.period ?? (replied ? null : host.fallback);
  if (!period) return replied;
  const asked = intervalOf(period);
  return replied &&
    replied.kind === asked.kind &&
    replied.startDay === asked.startDay &&
    replied.endDay === asked.endDay
    ? replied
    : asked;
}

/** @param {PeriodHost} host @param {HTMLElement} region */
export function drawPeriodControl(host, region) {
  const interval = periodInterval(host);
  const shown = periodSearch(host.period).toString();
  const periodUnchanged = region.dataset.period === shown;
  region.dataset.period = shown;
  const draft =
    host.period?.kind === "custom"
      ? { from: host.period.from, to: host.period.to }
      : interval
        ? /** @type {{ from: string, to: string }} */ (
            periodOf({ ...interval, kind: "custom" })
          )
        : { from: "", to: "" };
  const fromReply = !!interval && interval === host.reply?.meta.interval;
  redrawKeepingFocus(
    region,
    () =>
      periodView({
        interval,
        kind: host.periodKind,
        draft,
        error: host.periodError,
        dataTime: fromReply ? (interval.observedTo ?? null) : null,
      }),
    periodUnchanged,
  );
}

/** @param {PeriodHost} host @param {Element} button @param {HTMLElement} region @returns {boolean} whether it was a period control */
export function periodClicked(host, button, region) {
  const interval = periodInterval(host);
  const kind = button.getAttribute("data-period-kind");
  const step = button.getAttribute("data-period-step");
  // Disabled until there's an interval, except Custom; a click can still race a redraw.
  if (!interval && (step || (kind && kind !== "custom"))) return true;
  if (kind) {
    const next = interval ? periodForKind(kind, interval) : null;
    if (
      next &&
      interval &&
      samePeriod(next, host.period ?? periodOf(interval))
    ) {
      // Back to the period on screen: no reload, so the picks stay.
      host.periodKind = next.kind;
      host.periodError = "";
      drawPeriodControl(host, region);
    } else if (next) host.periodPicked(next);
    else {
      host.periodKind = "custom";
      host.periodError = "";
      drawPeriodControl(host, region);
      focusSoon(region.querySelector("#insights-period-from"));
    }
    return true;
  }
  if (step && interval) {
    host.periodPicked(
      stepPeriod(host.period ?? periodOf(interval), step === "1" ? 1 : -1),
    );
    return true;
  }
  if (button.id !== "insights-period-apply") return false;
  const { from, to, error } = customDraft(region);
  if (!error) {
    host.periodPicked({ kind: "custom", from, to });
    return true;
  }
  // The period shown stays; the typed dates stay too, for one fix.
  host.periodError = error;
  drawPeriodControl(host, region);
  return true;
}

/** @param {number | null} severity */
export function severityKnown(severity) {
  return (
    Number.isInteger(severity) && Number(severity) >= 1 && Number(severity) <= 5
  );
}

/** The server's bands, so the table and the CSV agree. @param {number | null} severity 1–5 */
export const severityBand = (severity) =>
  severityKnown(severity)
    ? Number(severity) >= 4
      ? "severe"
      : Number(severity) === 3
        ? "moderate"
        : "minor"
    : "unknown";

/** @param {number | null} severity */
export const severityWord = (severity) =>
  t(`admin.insights.severity.${severityBand(severity)}`);

/** @param {string} message already translated @param {string} [retryId] */
export function failedView(message, retryId = "insights-retry") {
  // The dashboard makes each .error an alert; a second one would repeat it.
  return `<div class="insights__failed" data-insights-failed><p class="error">${escapeHtml(message)}</p><button type="button" class="btn-secondary" id="${retryId}">${escapeHtml(t("common.retry"))}</button></div>`;
}

/** @param {unknown} err @param {string} lead translated first sentence */
export function failureText(err, lead) {
  // A timeout's message is already a sentence, so its code names it.
  const named = /** @type {any} */ (err)?.code;
  const code =
    typeof named === "string" ? named : err instanceof Error ? err.message : "";
  const key = codeKey("admin.insights.error", code);
  const detail = hasKey(key) ? t(key) : t("admin.insights.error.generic");
  return `${lead} ${detail}`;
}

/**
 * Keeps the old results, dimmed, while new ones load, so the page keeps its height and scroll.
 * @param {Element} region
 */
export function showLoading(region) {
  region.setAttribute("aria-busy", "true");
  // An old error kept on screen would look like the new load failed too.
  if (
    region.childElementCount &&
    !region.querySelector("[data-insights-failed]")
  ) {
    region.classList.add("insights__stale");
    // Old rows can't be picked or opened while they're out of date.
    region.toggleAttribute("inert", true);
  } else region.innerHTML = loadingView();
}

/** @param {Element} region @param {string} markup */
export function showLoaded(region, markup) {
  region.removeAttribute("aria-busy");
  region.classList.remove("insights__stale");
  region.removeAttribute("inert");
  region.innerHTML = markup;
}

/** @param {string} [label] */
export function loadingView(label = t("common.loading")) {
  return `<p role="status" class="insights__loading"><wa-spinner aria-hidden="true"></wa-spinner> ${escapeHtml(label)}</p>`;
}
