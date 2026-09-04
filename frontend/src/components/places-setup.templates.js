import { html, escapeHtml } from "../lib/html.js";

/**
 * @typedef {{ id?: string, name?: string, order?: number }} PlaceTemplateItem
 * @typedef {{
 *   title: string,
 *   subtitle: string,
 *   siteName: string,
 *   places: PlaceTemplateItem[],
 *   canAdd: boolean,
 *   canSave: boolean,
 *   mode: "setup" | "edit",
 *   menuIndex: number | null,
 *   error?: string
 * }} PlacesShellOptions
 * @typedef {{
 *   place: PlaceTemplateItem,
 *   index: number,
 *   count: number,
 *   menuOpen: boolean
 * }} PlaceRowOptions
 */

export const PLACE_PLACEHOLDER = "Example: 6th St., or, Front entrance";
export const MAX_PLACE_NAME_LENGTH = 120;

/**
 * @param {PlacesShellOptions} options
 * @returns {string}
 */
export function placesShell({
  title,
  subtitle,
  siteName,
  places,
  canAdd,
  canSave,
  mode,
  menuIndex,
  error = "",
}) {
  return html`
    <div class="places-flow" data-mode="${escapeHtml(mode)}">
      ${mode === "edit"
        ? html`<button
            class="places-flow__back"
            id="places-back"
            type="button"
            aria-label="Back"
          >
            <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
          </button>`
        : ""}
      <section class="places-flow__panel" aria-labelledby="places-title">
        <div class="places-flow__copy">
          <h1 class="places-flow__title" id="places-title">
            ${escapeHtml(title)}
          </h1>
          <p class="places-flow__subtitle">${escapeHtml(subtitle)}</p>
        </div>

        <p class="places-flow__site">${escapeHtml(siteName)}</p>

        <ol class="places-list" id="places-list">
          ${places
            .map((place, index) =>
              placeRow({
                place,
                index,
                count: places.length,
                menuOpen: menuIndex === index,
              }),
            )
            .join("")}
        </ol>

        ${mode === "edit"
          ? html`<p class="places-flow__future-note">
              Changes apply to future checks.<br />
              Previous check records won’t be affected.
            </p>`
          : ""}
        ${error
          ? html`<p class="places-flow__error" role="alert">
              ${escapeHtml(error)}
            </p>`
          : ""}

        <div class="places-flow__actions">
          <button
            class="btn-outline places-flow__button places-flow__button--add"
            id="add-place"
            type="button"
            ${canAdd ? "" : "disabled"}
          >
            Add place
          </button>
          <button
            class="btn-ink places-flow__button"
            id="save-places"
            type="button"
            ${canSave ? "" : "disabled"}
          >
            Save places
          </button>
        </div>
      </section>

      <dialog class="places-modal" id="remove-place-dialog">
        <form class="places-modal__card" method="dialog">
          <div class="places-modal__copy">
            <h2 class="places-modal__title" id="remove-place-title"></h2>
            <p class="places-modal__text">
              It will no longer appear in future perimeter checks. Previous
              check records won't be affected.
            </p>
          </div>
          <div class="places-modal__actions">
            <button class="btn-ink places-modal__primary" type="submit">
              Keep place
            </button>
            <button
              class="places-modal__danger"
              id="remove-place-confirm"
              type="button"
            >
              Remove place
            </button>
          </div>
        </form>
      </dialog>

      <dialog class="places-modal" id="discard-places-dialog">
        <form class="places-modal__card" method="dialog">
          <div class="places-modal__copy">
            <h2 class="places-modal__title">Discard changes?</h2>
            <p class="places-modal__text">
              Your changes to the check locations haven't been saved.
            </p>
          </div>
          <div class="places-modal__actions">
            <button class="btn-ink places-modal__primary" type="submit">
              Keep editing
            </button>
            <button
              class="places-modal__danger"
              id="discard-places-confirm"
              type="button"
            >
              Discard changes
            </button>
          </div>
        </form>
      </dialog>
    </div>
  `;
}

/**
 * @param {PlaceRowOptions} options
 * @returns {string}
 */
function placeRow({ place, index, count, menuOpen }) {
  const name = place.name || "";
  const canMoveUp = index > 0;
  const canMoveDown = index < count - 1;
  const isSingle = count === 1;
  const isBlank = !name.trim();
  const showMenuButton = !isSingle;
  return html`
    <li
      class="places-row ${isSingle ? "places-row--single" : ""}"
      data-index="${index}"
    >
      ${isSingle
        ? ""
        : html`<span class="places-row__number" aria-hidden="true"
            >${index + 1}</span
          >`}
      <wa-input
        class="places-row__input"
        data-place-input="${index}"
        label="Place ${index + 1}"
        value="${escapeHtml(name)}"
        placeholder="${PLACE_PLACEHOLDER}"
        maxlength="${MAX_PLACE_NAME_LENGTH}"
      ></wa-input>
      <div class="places-row__menu-wrap">
        ${showMenuButton
          ? html`<button
              class="places-row__menu-button"
              type="button"
              data-place-menu="${index}"
              aria-label="${isBlank ? "Remove blank place" : "Place options"}"
              aria-expanded="${menuOpen ? "true" : "false"}"
            >
              ${isBlank
                ? html`<wa-icon name="xmark" aria-hidden="true"></wa-icon>`
                : html`<span
                    class="places-row__dots"
                    aria-hidden="true"
                  ></span>`}
            </button>`
          : ""}
        ${menuOpen && !isBlank
          ? html`<div class="places-menu" role="menu">
              <button
                class="places-menu__item"
                type="button"
                data-place-action="up"
                data-index="${index}"
                role="menuitem"
                ${canMoveUp ? "" : "disabled"}
              >
                <span aria-hidden="true">↑</span> Move up
              </button>
              <button
                class="places-menu__item"
                type="button"
                data-place-action="down"
                data-index="${index}"
                role="menuitem"
                ${canMoveDown ? "" : "disabled"}
              >
                <span aria-hidden="true">↓</span> Move down
              </button>
              <button
                class="places-menu__item places-menu__item--danger"
                type="button"
                data-place-action="remove"
                data-index="${index}"
                role="menuitem"
              >
                <wa-icon name="trash" aria-hidden="true"></wa-icon> Remove
              </button>
            </div>`
          : ""}
      </div>
    </li>
  `;
}
