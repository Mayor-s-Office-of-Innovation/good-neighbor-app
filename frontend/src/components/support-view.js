import "./support-view.css";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t, getLocale } from "../i18n/i18n.js";
import { backOrNavigate, forceNextRouteTransition } from "../router.js";
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
            data-menu-back
            aria-label="${escapeAttr(t("common.back"))}"
          >
            <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
          </button>
        </div>
        <h1 class="support__title" id="support-title" tabindex="-1">
          ${escapeHtml(t("support.title"))}
        </h1>
        <p>${escapeHtml(t("support.intro"))}</p>
        <div class="support__starters" data-starters>
          ${[1, 2, 3]
            .map(
              (n) =>
                html`<button
                  type="button"
                  class="support__starter"
                  data-starter
                >
                  <span>${escapeHtml(t(`support.starter${n}`))}</span>
                  <wa-icon name="arrow-up-right" aria-hidden="true"></wa-icon>
                </button>`,
            )
            .join("")}
        </div>
        <div
          class="support__conversation"
          role="log"
          aria-label="${escapeAttr(t("support.conversation"))}"
          aria-live="polite"
          aria-relevant="additions"
        ></div>
        <p data-status role="status"></p>
        <button type="button" class="support__clear" data-clear hidden>
          <wa-icon name="rotate-left" aria-hidden="true"></wa-icon>
          ${escapeHtml(t("support.clear"))}
        </button>
        <form class="support__composer">
          <wa-textarea
            data-question
            label="${escapeAttr(t("support.question"))}"
            placeholder="${escapeAttr(t("support.placeholder"))}"
            rows="2"
            maxlength="1000"
            minlength="20"
            resize="none"
            required
          ></wa-textarea>
          <button
            class="support__send"
            type="submit"
            data-send
            disabled
            aria-label="${escapeAttr(t("support.send"))}"
          >
            <wa-icon name="arrow-up" aria-hidden="true"></wa-icon>
          </button>
        </form>
        <p
          class="support__question-hint"
          data-question-hint
          aria-live="polite"
          hidden
        ></p>
        <p class="support__privacy">
          ${escapeHtml(t("support.privacy"))}
          ${escapeHtml(t("support.accuracy"))}
        </p>
        <p class="support__handoff">
          ${escapeHtml(t("support.handoff"))}
          <a class="support__email" href="mailto:goodneighbor@sf.gov"
            >${escapeHtml(t("support.email"))}</a
          >
        </p>
      </div>
    </section>`;
    this.querySelector("[data-menu-back]")?.addEventListener("click", () => {
      forceNextRouteTransition("pop");
      try {
        sessionStorage.setItem("gnp-reopen-settings", "1");
      } catch {
        /* storage unavailable: land on a plain home screen */
      }
      backOrNavigate("/today");
    });
    announceScreenHeading(this, "#support-title");
    const question =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default} */ (
        this.querySelector("[data-question]")
      );
    this.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this._submit();
    });
    // One tap on a starter fills the question and asks it — no typing, no
    // length hurdle (every starter clears the 20-character floor).
    this.querySelectorAll("[data-starter]").forEach((starter) =>
      starter.addEventListener("click", () => {
        question.value =
          starter.querySelector("span")?.textContent?.trim() || "";
        this._questionTouched = true;
        this._syncQuestion();
        void this._submit();
      }),
    );
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
    this._questionTouched = false;
    this.querySelector(".support__conversation")?.replaceChildren();
    this._syncResponses();
    this._busy(false);
  }

  _syncResponses() {
    const hasTurns = Boolean(this.querySelector(".support__turn"));
    const clear = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-clear]")
    );
    if (clear) clear.hidden = !hasTurns;
    // Starters step aside once a conversation exists; Clear brings them back.
    const starters = /** @type {HTMLElement | null} */ (
      this.querySelector("[data-starters]")
    );
    if (starters) starters.hidden = hasTurns || Boolean(this._pending);
  }

  /** @param {boolean} busy */
  _busy(busy) {
    const send = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("[data-send]")
    );
    if (send) send.disabled = busy;
    this._syncResponses();
    this.querySelectorAll("[data-starter]").forEach((starter) => {
      /** @type {HTMLButtonElement} */ (starter).disabled = busy;
    });
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
    // An empty composer just disables Send quietly; red is only for a
    // question someone started and left too short.
    const error = this._questionTouched && invalid && length > 0;
    const hint = /** @type {HTMLElement | null} */ (
      this.querySelector("[data-question-hint]")
    );
    if (hint) {
      // The hint speaks only when something is wrong (copy stays minimal),
      // as its own line below the composer.
      hint.textContent = error ? t("support.questionHint") : "";
      hint.hidden = !error;
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
      this._syncQuestion();
    }
    this._syncQuestion();
    textarea.focus();
  }

  /** @param {string} question @param {any} result */
  _append(question, result) {
    const log = this.querySelector(".support__conversation");
    const turn = document.createElement("section");
    turn.className = "support__turn";
    // The question is a chat bubble on the right; the answer is plain text.
    const bubbleRow = document.createElement("p");
    bubbleRow.className = "support__q";
    const bubble = document.createElement("span");
    bubble.textContent = question;
    bubbleRow.append(bubble);
    const answer = document.createElement("p");
    answer.className = "support__a";
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
    turn.append(bubbleRow, answer);
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
      turn.append(retry);
    }
    if (valid) {
      // "N sources" toggles the source card; expanded by default so the
      // receipts are in view when the answer lands.
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "support__sources-toggle";
      toggle.setAttribute("aria-expanded", "true");
      const book = document.createElement("wa-icon");
      book.setAttribute("name", "book-open");
      book.setAttribute("aria-hidden", "true");
      const count = document.createElement("span");
      count.textContent = t("support.sourcesCount", {
        count: result.sources.length,
      });
      const chevron = document.createElement("wa-icon");
      chevron.className = "support__sources-chevron";
      chevron.setAttribute("name", "chevron-down");
      chevron.setAttribute("aria-hidden", "true");
      toggle.append(book, count, chevron);
      const card = document.createElement("div");
      card.className = "support__sources";
      for (const source of result.sources) {
        const details = document.createElement("details");
        details.className = "support__source";
        details.lang = "en"; // Canonical FAQ is English; answers use app locale.
        const summary = document.createElement("summary");
        const copyWrap = document.createElement("span");
        copyWrap.className = "support__source-copy";
        const title = document.createElement("strong");
        title.textContent = source.title;
        const doc = document.createElement("span");
        doc.className = "support__source-doc";
        doc.textContent = t(
          source.id.startsWith("FAQ-")
            ? "support.sourceFaq"
            : source.id.startsWith("GUIDE-")
              ? "support.sourceGuide"
              : "support.sourceDoc",
          { id: source.id },
        );
        copyWrap.append(title, doc);
        const open = document.createElement("wa-icon");
        open.className = "support__source-chevron";
        open.setAttribute("name", "chevron-right");
        open.setAttribute("aria-hidden", "true");
        summary.append(copyWrap, open);
        const text = document.createElement("p");
        text.textContent = source.text;
        details.append(summary, text);
        card.append(details);
      }
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        card.hidden = expanded;
      });
      turn.append(toggle, card);
    }
    log.append(turn);
    while (log.children.length > 10) log.firstElementChild.remove();
    this._syncResponses();
    turn.scrollIntoView({ block: "nearest" });
  }
}

customElements.define("support-view", SupportView);
