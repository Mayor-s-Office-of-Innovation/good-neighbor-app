// @ts-nocheck -- lenient migration baseline (checkJs). Presentational HTML strings.
import { html } from "../lib/html.js";

export const DESCRIPTION_MAX_LENGTH = 4000;

export const shell = ({ hasText }) => html`
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
        <span class="visually-hidden">Back to photo capture</span>
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
        <span class="visually-hidden">Close description screen</span>
      </button>
    </div>

    <div class="describe__main">
      <div class="describe__heading">
        <h1 class="describe__title">Describe what you see</h1>
        <p class="describe__subtitle">
          Describe the general conditions around the site.
        </p>
      </div>

      <div class="describe__card">
        <label class="visually-hidden" for="describe-text"
          >Describe what you see</label
        >
        <div class="describe__field-wrap">
          <textarea
            class="describe__field"
            id="describe-text"
            placeholder="Example: There’s trash near the entrance and graffiti on the wall..."
            rows="5"
            spellcheck="true"
            maxlength="${DESCRIPTION_MAX_LENGTH}"
          ></textarea>
        </div>

        <div class="describe__meta">
          <button
            class="describe__clear"
            id="describe-clear"
            type="button"
            ${hasText ? "" : "disabled"}
            aria-label="Clear all text"
          >
            Clear all
          </button>
        </div>
      </div>
    </div>

    <div class="describe__actions">
      <button
        class="describe__continue"
        id="describe-continue"
        type="button"
        ${hasText ? "" : "disabled"}
      >
        Continue
      </button>
    </div>

    <dialog class="describe-modal" id="describe-exit-modal">
      <form class="describe-modal__card" method="dialog">
        <h2 class="describe-modal__title">Discard this description?</h2>
        <p class="describe-modal__text">
          Your typed changes for this place have not been saved yet.
        </p>
        <div class="describe-modal__actions">
          <button class="describe-modal__secondary" type="submit" value="stay">
            Keep editing
          </button>
          <button
            class="describe-modal__primary"
            id="describe-discard"
            type="submit"
            value="discard"
          >
            Discard changes
          </button>
        </div>
      </form>
    </dialog>
  </div>
`;
