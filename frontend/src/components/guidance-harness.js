// @ts-nocheck -- dev harness; keep production code paths typed first.
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  evaluateAssessment,
  getAssessmentGuidance,
  submitConditionAnswers,
} from "../services/api.js";
import { guidanceFixtures } from "../dev/guidance-fixtures.js";

const DEFAULT_FIXTURE = guidanceFixtures[0];

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

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

function displayValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

function nowSuffix() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

function baseId(value, fallback) {
  return String(value || fallback).replace(/-\d{14}$/, "");
}

function freshPayload(payload) {
  const suffix = nowSuffix();
  return {
    ...payload,
    assessmentId: `${baseId(payload.assessmentId, "dev-guidance")}-${suffix}`,
    checkId: `${baseId(payload.checkId, "dev-check")}-${suffix}`,
    reportedAt: new Date().toISOString(),
  };
}

class GuidanceHarness extends HTMLElement {
  connectedCallback() {
    this._fixture = DEFAULT_FIXTURE;
    this._json = pretty(DEFAULT_FIXTURE.assessment);
    this._freshOnEvaluate = true;
    this._request = null;
    this._response = null;
    this._guidance = null;
    this._error = "";
    this._busy = false;
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
              <label>
                Fixture
                <select id="fixture">
                  ${guidanceFixtures
                    .map(
                      (fixture) => html`
                        <option
                          value="${escapeAttr(fixture.id)}"
                          ${fixture.id === this._fixture.id ? "selected" : ""}
                        >
                          ${escapeHtml(fixture.label)}
                        </option>
                      `,
                    )
                    .join("")}
                </select>
              </label>
              <button
                type="button"
                id="freshen"
                class="btn-outline btn-outline--sm"
              >
                Fresh IDs
              </button>
            </div>

            <label class="guidance-harness__checkbox">
              <input
                id="fresh-on-evaluate"
                type="checkbox"
                ${this._freshOnEvaluate ? "checked" : ""}
              />
              Fresh IDs on evaluate
            </label>

            <div
              class="guidance-harness__controls guidance-harness__controls--three"
            >
              <label>
                assessmentId
                <input id="assessment-id" type="text" autocomplete="off" />
              </label>
              <label>
                checkId
                <input id="check-id" type="text" autocomplete="off" />
              </label>
              <label>
                reportedAt
                <input id="reported-at" type="text" autocomplete="off" />
              </label>
            </div>

            <label class="guidance-harness__json-label" for="assessment-json">
              Assessment JSON
            </label>
            <textarea id="assessment-json" spellcheck="false">
${escapeHtml(this._json)}</textarea
            >

            <div class="guidance-harness__actions">
              <button
                type="submit"
                class="btn-ink"
                ${this._busy ? "disabled" : ""}
              >
                Evaluate
              </button>
              <button
                type="button"
                id="refresh"
                class="btn-outline btn-outline--sm"
              >
                Refresh
              </button>
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
      const id = event.target.value;
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
        this._freshOnEvaluate = event.target.checked;
      },
    );

    this.querySelector("#freshen")?.addEventListener("click", () => {
      const parsed = parseJson(this.querySelector("#assessment-json").value);
      if (!parsed.ok) {
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
      this._evaluate();
    });
    this.querySelector("#refresh")?.addEventListener("click", () =>
      this._refresh(),
    );
    this.querySelectorAll("[data-answer]").forEach((button) => {
      button.addEventListener("click", () => {
        this._answer(
          button.dataset.assessmentId,
          button.dataset.conditionId,
          button.dataset.answerKey,
          button.dataset.answer === "true",
        );
      });
    });
  }

  _payloadFromEditor() {
    const json = this.querySelector("#assessment-json")?.value ?? "";
    this._json = json;
    const parsed = parseJson(json);
    if (!parsed.ok) return parsed;
    const payload = { ...parsed.value };
    const assessmentId = this.querySelector("#assessment-id")?.value?.trim();
    const checkId = this.querySelector("#check-id")?.value?.trim();
    const reportedAt = this.querySelector("#reported-at")?.value?.trim();
    if (assessmentId) payload.assessmentId = assessmentId;
    if (checkId) payload.checkId = checkId;
    if (reportedAt) payload.reportedAt = reportedAt;
    return { ok: true, value: payload };
  }

  async _evaluate() {
    const parsed = this._payloadFromEditor();
    if (!parsed.ok) {
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
      this._guidance = this._response;
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
        ? parsed.value.assessmentId
        : this._guidance?.assessment?.assessmentId;
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
      this._guidance = this._response;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._response = { error: this._error };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _answer(assessmentId, conditionId, answerKey, value) {
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

  _guidanceView() {
    const assessment = this._guidance.assessment ?? {};
    const conditions = this._guidance.conditions ?? [];
    const tasks = this._guidance.tasks ?? [];
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

  _conditionCard(condition) {
    const question = condition.needsAnswer;
    return html`
      <article class="guidance-card">
        <div class="guidance-card__top">
          <h3>${escapeHtml(displayValue(condition.canonicalCategory))}</h3>
          <span class="guidance-pill"
            >Severity ${escapeHtml(condition.severity)}</span
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
                <p>${escapeHtml(question.prompt)}</p>
                <div class="guidance-question__actions">
                  <button
                    type="button"
                    class="btn-outline btn-outline--sm"
                    data-answer="true"
                    data-assessment-id="${escapeAttr(condition.assessmentId)}"
                    data-condition-id="${escapeAttr(condition.conditionId)}"
                    data-answer-key="${escapeAttr(question.key)}"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    class="btn-outline btn-outline--sm"
                    data-answer="false"
                    data-assessment-id="${escapeAttr(condition.assessmentId)}"
                    data-condition-id="${escapeAttr(condition.conditionId)}"
                    data-answer-key="${escapeAttr(question.key)}"
                  >
                    No
                  </button>
                </div>
              </div>
            `
          : ""}
      </article>
    `;
  }

  _taskCard(task) {
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
        ${task.appActions?.length
          ? html`
              <ul class="guidance-actions">
                ${task.appActions
                  .map(
                    (action) => html`
                      <li>
                        <code>${escapeHtml(action.code)}</code>
                        ${escapeHtml(pretty(action.payload ?? {}))}
                      </li>
                    `,
                  )
                  .join("")}
              </ul>
            `
          : ""}
      </article>
    `;
  }
}

customElements.define("guidance-harness", GuidanceHarness);
