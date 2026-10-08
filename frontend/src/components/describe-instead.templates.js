// @ts-nocheck -- lenient migration baseline (checkJs). Presentational HTML strings.
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

export const DESCRIPTION_MAX_LENGTH = 4000;

// Translation keys; the copy lives in the i18n catalogs.
const PERIMETER_COPY = {
  subtitle: "describe.perimeter.subtitle",
  placeholder: "describe.perimeter.placeholder",
};

const PROBLEM_COPY = {
  subtitle: "describe.problem.subtitle",
  placeholder: "describe.problem.placeholder",
};

export const shell = ({
  flowType = "perimeter",
  minLength = 1,
  hasText = false,
  canContinue = false,
} = {}) => {
  const copy = flowType === "perimeter" ? PERIMETER_COPY : PROBLEM_COPY;
  return html`
    <div class="flow view-describe describe">
      <div class="describe__bar">
        <button
          class="describe__close describe__close--back"
          id="describe-close"
          type="button"
        >
          <span
            class="describe__close-icon describe__close-icon--back"
            aria-hidden="true"
          ></span>
          <span class="visually-hidden"
            >${escapeHtml(t("describe.back.aria"))}</span
          >
        </button>
        <span aria-hidden="true"></span>
        <button
          class="describe__close describe__close--dismiss"
          id="describe-dismiss"
          type="button"
        >
          <span
            class="describe__close-icon describe__close-icon--dismiss"
            aria-hidden="true"
          ></span>
          <span class="visually-hidden"
            >${escapeHtml(t("describe.close.aria"))}</span
          >
        </button>
      </div>

      <div class="describe__main">
        <div class="describe__heading">
          <h1 class="describe__title" tabindex="-1">
            ${escapeHtml(t("describe.title"))}
          </h1>
          <p class="describe__subtitle">${escapeHtml(t(copy.subtitle))}</p>
        </div>

        <div class="describe__card">
          <label class="visually-hidden" for="describe-text"
            >${escapeHtml(t("describe.title"))}</label
          >
          <div class="describe__field-wrap">
            <textarea
              class="describe__field"
              id="describe-text"
              placeholder="${escapeAttr(t(copy.placeholder))}"
              rows="5"
              spellcheck="true"
              maxlength="${DESCRIPTION_MAX_LENGTH}"
              ${minLength > 1 ? 'aria-describedby="describe-hint"' : ""}
            ></textarea>
          </div>

          <div class="describe__meta">
            ${minLength > 1
              ? html`<span class="describe__hint" id="describe-hint"
                  >${escapeHtml(t("describe.hint", { count: minLength }))}</span
                >`
              : ""}
            <button
              class="describe__clear"
              id="describe-clear"
              type="button"
              ${hasText ? "" : "disabled"}
              aria-label="${escapeAttr(t("describe.clear.aria"))}"
            >
              ${escapeHtml(t("common.clearAll"))}
            </button>
          </div>
        </div>
      </div>

      <div class="describe__actions">
        <button
          class="describe__continue"
          id="describe-continue"
          type="button"
          ${canContinue ? "" : "disabled"}
        >
          ${escapeHtml(t("common.continue"))}
        </button>
      </div>

      <dialog
        class="describe-modal"
        id="describe-exit-modal"
        aria-labelledby="describe-modal-title"
        aria-describedby="describe-modal-text"
      >
        <form class="describe-modal__card" method="dialog">
          <h2 class="describe-modal__title" id="describe-modal-title">
            ${escapeHtml(t("describe.discardDialog.title"))}
          </h2>
          <p class="describe-modal__text" id="describe-modal-text">
            ${escapeHtml(t("describe.discardDialog.text"))}
          </p>
          <div class="describe-modal__actions">
            <button
              class="describe-modal__secondary"
              type="submit"
              value="stay"
            >
              ${escapeHtml(t("common.keepEditing"))}
            </button>
            <button
              class="describe-modal__primary"
              id="describe-discard"
              type="submit"
              value="discard"
            >
              ${escapeHtml(t("common.discardChanges"))}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  `;
};
