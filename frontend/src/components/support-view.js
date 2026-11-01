import "./support-view.css";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t, getLocale } from "../i18n/i18n.js";
import { backOrNavigate } from "../router.js";
import { announceScreenHeading } from "../screen-focus.js";
import { askSupport } from "../services/api.js";

/** Plain-text only; even validated model output never enters an HTML sink. */
export class SupportView extends HTMLElement {
  /** @type {AbortController | null} */
  _pending = null;
  _locale = "";
  _questionTouched = false;

  connectedCallback() {
    this._locale = getLocale();
    this.innerHTML = html`<section
      class="support"
      aria-labelledby="support-title"
    >
      <div class="support__panel">
        <div class="support__back-row">
          <button
            type="button"
            class="btn-circle-close support__back"
            data-back
            aria-label="${escapeAttr(t("common.close"))}"
          >
            <wa-icon name="xmark" aria-hidden="true"></wa-icon>
          </button>
        </div>
        <h1 class="support__title" id="support-title" tabindex="-1">
          ${escapeHtml(t("support.title"))}
        </h1>
        <p>${escapeHtml(t("support.intro"))}</p>
        <div
          class="support__conversation"
          role="log"
          aria-label="${escapeAttr(t("support.conversation"))}"
          aria-live="polite"
          aria-relevant="additions"
        ></div>
        <p data-status role="status"></p>
        <button
          type="button"
          class="btn-outline support__small"
          data-clear
          hidden
        >
          ${escapeHtml(t("support.clear"))}
        </button>
        <form>
          <wa-textarea
            data-question
            label="${escapeAttr(t("support.question"))}"
            rows="3"
            maxlength="1000"
            minlength="20"
            resize="vertical"
            required
            ><span slot="hint" data-question-hint aria-live="polite"
              >${escapeHtml(t("support.questionHint"))}</span
            ></wa-textarea
          >
          <button class="btn-ink" type="submit" data-send disabled>
            ${escapeHtml(t("support.send"))}
          </button>
        </form>
        <p class="support__privacy">${escapeHtml(t("support.privacy"))}</p>
        <p class="support__privacy">${escapeHtml(t("support.accuracy"))}</p>
        <p class="support__handoff">
          ${escapeHtml(t("support.handoff"))}
          <a class="support__email" href="mailto:goodneighbor@sf.gov"
            >${escapeHtml(t("support.email"))}</a
          >
        </p>
      </div>
    </section>`;
    this.querySelector("[data-back]").addEventListener("click", () =>
      backOrNavigate("/today"),
    );
    announceScreenHeading(this, "#support-title");
    this.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this._submit();
    });
    const question = this.querySelector("[data-question]");
    question.addEventListener("input", () => {
      this._questionTouched = true;
      this._syncQuestion();
    });
    question.addEventListener("focusout", () => {
      this._questionTouched = true;
      this._syncQuestion();
    });
    this.querySelector("[data-clear]").addEventListener("click", () => {
      this.querySelector(".support__conversation").replaceChildren();
      this._syncResponses();
      /** @type {HTMLElement} */ (
        this.querySelector("[data-question]")
      ).focus();
    });
  }

  disconnectedCallback() {
    this._reset();
  }

  _reset() {
    this._pending?.abort();
    this._pending = null;
    const question =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default | null} */ (
        this.querySelector("[data-question]")
      );
    if (question) question.value = "";
    this.querySelector(".support__conversation")?.replaceChildren();
    this._syncResponses();
    this._busy(false);
  }

  _syncResponses() {
    const clear = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-clear]")
    );
    if (clear) clear.hidden = !this.querySelector(".support__turn");
  }

  /** @param {boolean} busy */
  _busy(busy) {
    const send = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-send]")
    );
    if (send) send.disabled = busy;
    this._syncQuestion(busy);
    const status = this.querySelector("[data-status]");
    if (status) status.textContent = busy ? t("support.waiting") : "";
  }

  _syncQuestion(busy = Boolean(this._pending)) {
    const field =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default | null} */ (
        this.querySelector("[data-question]")
      );
    if (!field) return;
    const length = field.value.trim().length;
    const invalid = length < 20 || field.value.length > 1000;
    const error = this._questionTouched && invalid;
    const hint = this.querySelector("[data-question-hint]");
    if (hint) {
      hint.textContent = t(
        error ? "support.questionTooShort" : "support.questionHint",
      );
      hint.classList.toggle("support__question-error", error);
    }
    field.setCustomValidity(error ? t("support.questionTooShort") : "");
    const send = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-send]")
    );
    if (send) send.disabled = busy || invalid;
  }

  async _submit(retryQuestion, retryTurn) {
    if (this._pending) return;
    const textarea =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default} */ (
        this.querySelector("[data-question]")
      );
    const question = retryQuestion || textarea.value.trim();
    if (question.length < 20 || question.length > 1000) {
      this._questionTouched = true;
      this._syncQuestion();
      return;
    }
    const controller = new AbortController();
    this._pending = controller;
    this._busy(true);
    // The server's 15s deadline is inside this end-to-end deadline, including auth.
    const timer = setTimeout(() => controller.abort(), 20000);
    let result;
    try {
      result = await askSupport({
        question,
        locale: getLocale(),
        signal: controller.signal,
      });
    } catch (error) {
      result = {
        outcome:
          /** @type {any} */ (error)?.status === 429
            ? "limited"
            : "unavailable",
      };
    } finally {
      clearTimeout(timer);
    }
    // Closed or superseded dialogs must never receive late answers.
    if (this._pending !== controller || !this.isConnected) return;
    this._pending = null;
    this._busy(false);
    if (retryTurn && !retryTurn.isConnected) return;
    retryTurn?.remove();
    this._append(question, result);
    if (!retryQuestion && textarea.value.trim() === question) {
      textarea.value = "";
      this._questionTouched = false;
    }
    this._syncQuestion();
    textarea.focus();
  }

  /** @param {string} question @param {any} result */
  _append(question, result) {
    const log = this.querySelector(".support__conversation");
    const turn = document.createElement("section");
    turn.className = "support__turn";
    const heading = document.createElement("h3");
    heading.textContent = question;
    const answer = document.createElement("p");
    const valid =
      result?.outcome === "answered" &&
      typeof result.answer === "string" &&
      result.answer.length <= 1500 &&
      Array.isArray(result.sources) &&
      result.sources.length > 0 &&
      result.sources.length <= 3 &&
      result.sources.every(
        (source) =>
          typeof source?.id === "string" &&
          typeof source.title === "string" &&
          typeof source.text === "string",
      );
    const fallback = [
      "unknown",
      "off_topic",
      "limited",
      "unavailable",
    ].includes(result?.outcome)
      ? result.outcome
      : "unknown";
    answer.textContent = valid
      ? result.answer
      : t(`support.${fallback === "off_topic" ? "offTopic" : fallback}`);
    const response = document.createElement("details");
    response.className = "support__response";
    response.open = true;
    const toggle = document.createElement("summary");
    toggle.append(heading);
    response.append(toggle, answer);
    if (!valid && ["limited", "unavailable"].includes(fallback)) {
      answer.classList.add("app-error", "app-error--panel");
      answer.setAttribute("role", "alert");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn-outline btn-outline--sm";
      retry.textContent = t("notice.retry");
      retry.addEventListener("click", () => {
        if (this._pending) return;
        void this._submit(question, turn);
      });
      response.append(retry);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-icon support__delete";
    remove.dataset.deleteResponse = "";
    remove.setAttribute("aria-label", t("support.delete"));
    remove.title = t("support.delete");
    const removeIcon = document.createElement("wa-icon");
    removeIcon.setAttribute("name", "xmark");
    removeIcon.setAttribute("aria-hidden", "true");
    remove.append(removeIcon);
    remove.addEventListener("click", () => {
      turn.remove();
      this._syncResponses();
      /** @type {HTMLElement} */ (
        this.querySelector("[data-question]")
      ).focus();
    });
    turn.append(remove, response);
    if (valid) {
      const label = document.createElement("p");
      label.textContent = t("support.sources");
      response.append(label);
      for (const source of result.sources) {
        const details = document.createElement("details");
        details.className = "support__source";
        details.lang = "en"; // Canonical FAQ is English; generated answers use app locale.
        const summary = document.createElement("summary");
        summary.textContent = `${source.id}: ${source.title}`;
        const text = document.createElement("p");
        text.textContent = source.text;
        details.append(summary, text);
        response.append(details);
      }
    }
    log.append(turn);
    while (log.children.length > 10) log.firstElementChild.remove();
    this._syncResponses();
    turn.scrollIntoView({ block: "nearest" });
  }
}

customElements.define("support-view", SupportView);
