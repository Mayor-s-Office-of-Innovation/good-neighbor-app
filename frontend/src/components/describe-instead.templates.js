// @ts-nocheck -- template asset URLs use Vite import.meta.env.BASE_URL like main.js.
import { html } from "../lib/html.js";

export const shell = ({ text, hasText }) => html`
  <div class="flow view-describe describe">
    <div class="describe__bar">
      <button
        class="describe__close describe__close--back"
        id="describe-close"
        type="button"
      >
        <img
          class="describe__close-icon describe__close-icon--back"
          src="${import.meta.env.BASE_URL}icons/chevron-left.svg"
          alt=""
          aria-hidden="true"
        />
        <span class="visually-hidden">Back to photo capture</span>
      </button>
      <span aria-hidden="true"></span>
      <button
        class="describe__close describe__close--dismiss"
        id="describe-dismiss"
        type="button"
      >
        <img
          class="describe__close-icon describe__close-icon--dismiss"
          src="${import.meta.env.BASE_URL}icons/xmark.svg"
          alt=""
          aria-hidden="true"
        />
        <span class="visually-hidden">Close description screen</span>
      </button>
    </div>

    <div class="describe__main">
      <div class="describe__heading">
        <h1 class="describe__title">Describe what you see</h1>
        <p class="describe__subtitle">
          Describe the general conditions around the site. You can type or use
          the microphone.
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
          ></textarea>
        </div>

        <div class="describe__meta">
          <div class="describe__chips" aria-label="Description checks">
            <span
              class="describe-chip"
              id="describe-chip-what"
              aria-disabled="true"
              >What you can see</span
            >
            <span
              class="describe-chip"
              id="describe-chip-where"
              aria-disabled="true"
              >Where it is</span
            >
          </div>
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

        <button class="describe__voice" id="describe-voice" type="button">
          ${hasText ? "Add more by voice" : "Use voice"}
        </button>
        <p
          class="describe__voice-status"
          id="describe-voice-status"
          role="status"
          aria-live="polite"
          aria-hidden="true"
        ></p>
      </div>
    </div>

    <div class="describe__actions">
      <p
        class="describe__validation-status"
        id="describe-validation-status"
        aria-live="polite"
        aria-hidden="true"
      ></p>
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
          Your typed changes on this side have not been saved yet.
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
