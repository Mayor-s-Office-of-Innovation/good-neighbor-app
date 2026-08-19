import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  evaluateAssessment,
  getAssessmentGuidance,
  submitConditionAnswers,
} from "../services/api.js";
import { guidanceFixtures } from "../dev/guidance-fixtures.js";

const DEFAULT_FIXTURE = guidanceFixtures[0];

/**
 * @typedef {{ id: string, label: string, assessment: Record<string, unknown> }} GuidanceFixture
 * @typedef {{ assessment?: Record<string, unknown>, conditions?: Record<string, unknown>[], tasks?: Record<string, unknown>[] }} GuidanceResponse
 * @typedef {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }} ParseResult
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function pretty(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * @param {string} text
 * @returns {ParseResult}
 */
function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function displayValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

/**
 * @returns {string}
 */
function nowSuffix() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function baseId(value, fallback) {
  return String(value || fallback).replace(/-\d{14}$/, "");
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function freshPayload(payload) {
  const suffix = nowSuffix();
  return {
    ...payload,
    assessmentId: `${baseId(payload.assessmentId, "dev-guidance")}-${suffix}`,
    checkId: `${baseId(payload.checkId, "dev-check")}-${suffix}`,
    reportedAt: new Date().toISOString(),
  };
}

/**
 * @param {Element | null | undefined} element
 * @returns {string}
 */
function elementValue(element) {
  return String(/** @type {{ value?: unknown }} */ (element ?? {}).value ?? "");
}

/**
 * @param {Element | null | undefined} element
 * @returns {boolean}
 */
function elementChecked(element) {
  return Boolean(/** @type {{ checked?: unknown }} */ (element ?? {}).checked);
}

class GuidanceHarness extends HTMLElement {
  constructor() {
    super();
    /** @type {GuidanceFixture} */
    this._fixture = DEFAULT_FIXTURE;
    /** @type {string} */
    this._json = pretty(DEFAULT_FIXTURE.assessment);
    /** @type {boolean} */
    this._freshOnEvaluate = true;
    /** @type {Record<string, unknown> | null} */
    this._request = null;
    /** @type {unknown} */
    this._response = null;
    /** @type {GuidanceResponse | null} */
    this._guidance = null;
    /** @type {string} */
    this._error = "";
    /** @type {boolean} */
    this._busy = false;
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    this.innerHTML = html`
      <section class="guidance-harness" aria-labelledby="guidance-title">
        <header class="guidance-harness__header">
          <a href="/today" class="guidance-harness__back">&larr; Today</a>
          <div>
            <p class="guidance-harness__eyebrow">DEV HARNESS</p>
            <h1 id="guidance-title">Guidance workflow</h1>
          </div>
        </header>

        <div class="guidance-harness__layout">
          <form class="guidance-harness__panel guidance-harness__editor">
            <div class="guidance-harness__controls">
              <wa-select id="fixture" label="Fixture">
                ${guidanceFixtures
                  .map(
                    (fixture) => html`
                      <wa-option
                        value="${escapeAttr(fixture.id)}"
                        ${fixture.id === this._fixture.id ? "selected" : ""}
                      >
                        ${escapeHtml(fixture.label)}
                      </wa-option>
                    `,
                  )
                  .join("")}
              </wa-select>
              <wa-button
                type="button"
                id="freshen"
                appearance="outlined"
                size="small"
              >
                Fresh IDs
              </wa-button>
            </div>

            <wa-checkbox
              id="fresh-on-evaluate"
              ${this._freshOnEvaluate ? "checked" : ""}
            >
              Fresh IDs on evaluate
            </wa-checkbox>

            <div
              class="guidance-harness__controls guidance-harness__controls--three"
            >
              <wa-input
                id="assessment-id"
                label="assessmentId"
                autocomplete="off"
              ></wa-input>
              <wa-input
                id="check-id"
                label="checkId"
                autocomplete="off"
              ></wa-input>
              <wa-input
                id="reported-at"
                label="reportedAt"
                autocomplete="off"
              ></wa-input>
            </div>

            <wa-textarea
              id="assessment-json"
              label="Assessment JSON"
              spellcheck="false"
              resize="vertical"
              rows="22"
              value="${escapeAttr(this._json)}"
            ></wa-textarea>

            <div class="guidance-harness__actions">
              <wa-button
                type="submit"
                appearance="accent"
                ${this._busy ? "disabled" : ""}
              >
                Evaluate
              </wa-button>
              <wa-button type="button" id="refresh" appearance="outlined">
                Refresh
              </wa-button>
            </div>
            ${this._error
              ? html`<p class="guidance-harness__error" role="alert">
                  ${escapeHtml(this._error)}
                </p>`
              : ""}
          </form>

          <div class="guidance-harness__panel guidance-harness__results">
            ${this._guidance ? this._guidanceView() : this._emptyView()}
          </div>
        </div>

        <section class="guidance-harness__raw" aria-label="Raw JSON">
          <details open>
            <summary>Last request</summary>
            <pre>${escapeHtml(pretty(this._request ?? {}))}</pre>
          </details>
          <details open>
            <summary>Last response</summary>
            <pre>${escapeHtml(pretty(this._response ?? {}))}</pre>
          </details>
        </section>
      </section>
    `;

    this.querySelector("#fixture")?.addEventListener("change", (event) => {
      const id = elementValue(/** @type {Element} */ (event.target));
      const fixture = guidanceFixtures.find((item) => item.id === id);
      if (!fixture) return;
      this._fixture = fixture;
      this._json = pretty(fixture.assessment);
      this._request = null;
      this._response = null;
      this._guidance = null;
      this._error = "";
      this._render();
    });

    this.querySelector("#fresh-on-evaluate")?.addEventListener(
      "change",
      (event) => {
        this._freshOnEvaluate = elementChecked(
          /** @type {Element} */ (event.target),
        );
      },
    );

    this.querySelector("#freshen")?.addEventListener("click", () => {
      const parsed = parseJson(
        elementValue(this.querySelector("#assessment-json")),
      );
      if (parsed.ok === false) {
        this._error = parsed.error;
        this._render();
        return;
      }
      this._json = pretty(freshPayload(parsed.value));
      this._error = "";
      this._render();
    });

    this.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this._evaluate();
    });
    this.querySelector("#refresh")?.addEventListener("click", () => {
      void this._refresh();
    });
    this.querySelectorAll("[data-answer]").forEach((button) => {
      button.addEventListener("click", () => {
        void this._answer(
          /** @type {HTMLElement} */ (button).dataset.assessmentId,
          /** @type {HTMLElement} */ (button).dataset.conditionId,
          /** @type {HTMLElement} */ (button).dataset.answerKey,
          /** @type {HTMLElement} */ (button).dataset.answer === "true",
        );
      });
    });
  }

  /**
   * @returns {ParseResult}
   */
  _payloadFromEditor() {
    const json = elementValue(this.querySelector("#assessment-json"));
    this._json = json;
    const parsed = parseJson(json);
    if (parsed.ok === false) return parsed;
    const payload = { ...parsed.value };
    const assessmentId = elementValue(
      this.querySelector("#assessment-id"),
    ).trim();
    const checkId = elementValue(this.querySelector("#check-id")).trim();
    const reportedAt = elementValue(this.querySelector("#reported-at")).trim();
    if (assessmentId) payload.assessmentId = assessmentId;
    if (checkId) payload.checkId = checkId;
    if (reportedAt) payload.reportedAt = reportedAt;
    return { ok: true, value: payload };
  }

  async _evaluate() {
    const parsed = this._payloadFromEditor();
    if (parsed.ok === false) {
      this._error = parsed.error;
      this._render();
      return;
    }
    if (this._freshOnEvaluate) {
      parsed.value = freshPayload(parsed.value);
    }
    this._json = pretty(parsed.value);
    this._busy = true;
    this._error = "";
    this._request = {
      method: "POST",
      path: "/v1/assessments:evaluate",
      body: parsed.value,
    };
    this._render();
    try {
      this._response = await evaluateAssessment(parsed.value);
      this._guidance = /** @type {GuidanceResponse} */ (this._response);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._response = { error: this._error };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _refresh() {
    const parsed = this._payloadFromEditor();
    const assessmentId =
      parsed.ok && parsed.value.assessmentId
        ? String(parsed.value.assessmentId)
        : String(this._guidance?.assessment?.assessmentId ?? "");
    if (!assessmentId) {
      this._error = "No assessmentId available to refresh.";
      this._render();
      return;
    }
    this._busy = true;
    this._error = "";
    this._request = {
      method: "GET",
      path: `/v1/assessments/${assessmentId}/guidance`,
    };
    this._render();
    try {
      this._response = await getAssessmentGuidance(assessmentId);
      this._guidance = /** @type {GuidanceResponse} */ (this._response);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._response = { error: this._error };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  /**
   * @param {string | undefined} assessmentId
   * @param {string | undefined} conditionId
   * @param {string | undefined} answerKey
   * @param {boolean} value
   * @returns {Promise<void>}
   */
  async _answer(assessmentId, conditionId, answerKey, value) {
    if (!assessmentId || !conditionId || !answerKey) return;
    this._busy = true;
    this._error = "";
    this._request = {
      method: "POST",
      path: `/v1/assessments/${assessmentId}/conditions/${conditionId}/answers`,
      body: { answers: { [answerKey]: value } },
    };
    this._render();
    try {
      this._response = await submitConditionAnswers(assessmentId, conditionId, {
        answers: { [answerKey]: value },
      });
      await this._refresh();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._response = { error: this._error };
      this._busy = false;
      this._render();
    }
  }

  /**
   * @returns {string}
   */
  _emptyView() {
    return html`
      <div class="guidance-harness__empty">
        <h2>No evaluation yet</h2>
        <p>
          Paste an assessment or load a fixture, then evaluate it against the
          local guidance API.
        </p>
      </div>
    `;
  }

  /**
   * @returns {string}
   */
  _guidanceView() {
    const assessment = this._guidance?.assessment ?? {};
    const conditions = this._guidance?.conditions ?? [];
    const tasks = this._guidance?.tasks ?? [];
    return html`
      <section class="guidance-section" aria-labelledby="assessment-summary">
        <h2 id="assessment-summary">Assessment</h2>
        <dl class="guidance-kv">
          <div>
            <dt>ID</dt>
            <dd>${escapeHtml(displayValue(assessment.assessmentId))}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>${escapeHtml(displayValue(assessment.status))}</dd>
          </div>
          <div>
            <dt>Policy</dt>
            <dd>${escapeHtml(displayValue(assessment.policyVersion))}</dd>
          </div>
          <div>
            <dt>Tasks</dt>
            <dd>${tasks.length}</dd>
          </div>
        </dl>
      </section>

      <section class="guidance-section" aria-labelledby="conditions-heading">
        <h2 id="conditions-heading">Conditions</h2>
        <div class="guidance-list">
          ${conditions
            .map((condition) => this._conditionCard(condition))
            .join("")}
        </div>
      </section>

      <section class="guidance-section" aria-labelledby="tasks-heading">
        <h2 id="tasks-heading">Tasks</h2>
        <div class="guidance-list">
          ${tasks.length
            ? tasks.map((task) => this._taskCard(task)).join("")
            : html`<p class="guidance-harness__muted">
                No tasks created yet.
              </p>`}
        </div>
      </section>
    `;
  }

  /**
   * @param {Record<string, unknown>} condition
   * @returns {string}
   */
  _conditionCard(condition) {
    const question =
      condition.needsAnswer && typeof condition.needsAnswer === "object"
        ? /** @type {{ prompt?: unknown, key?: unknown }} */ (
            condition.needsAnswer
          )
        : null;
    return html`
      <article class="guidance-card">
        <div class="guidance-card__top">
          <h3>${escapeHtml(displayValue(condition.canonicalCategory))}</h3>
          <span class="guidance-pill"
            >Severity ${escapeHtml(displayValue(condition.severity))}</span
          >
        </div>
        <dl class="guidance-kv guidance-kv--compact">
          <div>
            <dt>Status</dt>
            <dd>${escapeHtml(displayValue(condition.status))}</dd>
          </div>
          <div>
            <dt>Rule</dt>
            <dd>${escapeHtml(displayValue(condition.selectedRuleId))}</dd>
          </div>
          <div>
            <dt>Resolved</dt>
            <dd>${condition.resolvedToTasks ? "Yes" : "No"}</dd>
          </div>
        </dl>
        <p>${escapeHtml(displayValue(condition.description))}</p>
        ${question
          ? html`
              <div class="guidance-question">
                <p>${escapeHtml(displayValue(question.prompt))}</p>
                <div class="guidance-question__actions">
                  <wa-button
                    type="button"
                    appearance="outlined"
                    size="small"
                    data-answer="true"
                    data-assessment-id="${escapeAttr(condition.assessmentId)}"
                    data-condition-id="${escapeAttr(condition.conditionId)}"
                    data-answer-key="${escapeAttr(question.key)}"
                  >
                    Yes
                  </wa-button>
                  <wa-button
                    type="button"
                    appearance="outlined"
                    size="small"
                    data-answer="false"
                    data-assessment-id="${escapeAttr(condition.assessmentId)}"
                    data-condition-id="${escapeAttr(condition.conditionId)}"
                    data-answer-key="${escapeAttr(question.key)}"
                  >
                    No
                  </wa-button>
                </div>
              </div>
            `
          : ""}
      </article>
    `;
  }

  /**
   * @param {Record<string, unknown>} task
   * @returns {string}
   */
  _taskCard(task) {
    const appActions = Array.isArray(task.appActions) ? task.appActions : [];
    return html`
      <article class="guidance-card">
        <div class="guidance-card__top">
          <h3>${escapeHtml(displayValue(task.label))}</h3>
          <span class="guidance-pill"
            >${escapeHtml(displayValue(task.kind))}</span
          >
        </div>
        <dl class="guidance-kv guidance-kv--compact">
          <div>
            <dt>Status</dt>
            <dd>${escapeHtml(displayValue(task.status))}</dd>
          </div>
          <div>
            <dt>Rule</dt>
            <dd>${escapeHtml(displayValue(task.ruleId))}</dd>
          </div>
          <div>
            <dt>App action</dt>
            <dd>${escapeHtml(displayValue(task.appActionStatus))}</dd>
          </div>
        </dl>
        <p>${escapeHtml(displayValue(task.guidance))}</p>
        ${appActions.length
          ? html`
              <ul class="guidance-actions">
                ${appActions
                  .map((action) => {
                    const item =
                      /** @type {{ code?: unknown, payload?: unknown }} */ (
                        action
                      );
                    return html`
                      <li>
                        <code>${escapeHtml(displayValue(item.code))}</code>
                        ${escapeHtml(pretty(item.payload ?? {}))}
                      </li>
                    `;
                  })
                  .join("")}
              </ul>
            `
          : ""}
      </article>
    `;
  }
}

customElements.define("guidance-harness", GuidanceHarness);
