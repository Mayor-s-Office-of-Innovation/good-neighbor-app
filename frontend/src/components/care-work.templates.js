import { escapeHtml as e, escapeAttr as a, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { formatTime } from "../i18n/dates.js";
import { formatPhotoDateTime } from "../domain/photo-lightbox.js";
import {
  CARE_WORK_TYPES,
  careTitle,
  careKindLabel,
  groupCareWork,
} from "../domain/care-work.js";

export function careHeader(title, close = false) {
  return html`<header class="care-header">
    <div class="care-header__nav ${close ? "care-header__nav--close" : ""}">
      <button
        type="button"
        class="btn-care care-back"
        data-back
        aria-label="${a(t(close ? "common.close" : "common.back"))}"
      >
        <wa-icon
          name="${close ? "xmark" : "chevron-left"}"
          aria-hidden="true"
        ></wa-icon>
      </button>
    </div>
    <h1 tabindex="-1">${e(title)}</h1>
  </header>`;
}
export function careList(items, loading = false) {
  return html`${careHeader(t("care.title"), true)}
    <p class="care-subtitle">${e(t("care.subtitle"))}</p>
    <button type="button" class="btn-ink care-cta" data-new>
      ${e(t("care.new"))}
    </button>
    <div class="care-days" aria-busy="${loading}">
      ${loading
        ? `<p role="status">${e(t("care.loading"))}</p>`
        : items.length
          ? groupCareWork(items)
              .map(
                (group) =>
                  html`<section class="care-day">
                    <h2>
                      ${e(group.label)}<span
                        aria-label="${a(
                          t("care.count", { count: group.items.length }),
                        )}"
                        >${group.items.length}</span
                      >
                    </h2>
                    <ul>
                      ${group.items
                        .map(
                          (item) =>
                            html`<li>
                              <button
                                type="button"
                                class="btn-care care-row"
                                ${item.status
                                  ? "disabled"
                                  : `data-work="${a(item.workId)}"`}
                              >
                                <strong>${e(careTitle(item))}</strong
                                ><time datetime="${a(item.createdAt)}"
                                  >${e(formatTime(item.createdAt))}</time
                                >
                              </button>
                              ${item.status
                                ? html`<p role="status">
                                    ${e(
                                      t(
                                        item.status === "failed"
                                          ? "care.needsRetry"
                                          : "care.saving",
                                      ),
                                    )}
                                  </p>`
                                : ""}
                              ${item.status === "failed"
                                ? html`<button
                                    type="button"
                                    class="btn-outline"
                                    data-retry-work="${a(item.workId)}"
                                  >
                                    ${e(t("care.retry"))}
                                  </button>`
                                : ""}
                              ${item.status === "failed" && item.editable
                                ? html`<button
                                    type="button"
                                    class="btn-outline"
                                    data-edit-work="${a(item.workId)}"
                                  >
                                    ${e(t("care.editRetry"))}
                                  </button>`
                                : ""}
                            </li>`,
                        )
                        .join("")}
                    </ul>
                  </section>`,
              )
              .join("")
          : `<p data-empty>${e(t("care.empty"))}</p>`}
    </div>`;
}
export function careOptions() {
  return html`${careHeader(t("care.choose"))}
    <div class="care-options">
      ${[...CARE_WORK_TYPES, "other"]
        .map(
          (kind) =>
            html`<button
              type="button"
              class="btn-care care-option ${kind === "other"
                ? "care-option--other"
                : ""}"
              data-kind="${a(kind)}"
            >
              <span>${e(careKindLabel(kind))}</span
              ><wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
            </button>`,
        )
        .join("")}
    </div>`;
}
export function carePhotoPicker(files, busy = false) {
  return html`<section
    class="care-photo-section"
    aria-labelledby="care-photo-label"
  >
    <h2 id="care-photo-label">${e(t("care.photo.add"))}</h2>
    <input
      id="care-photo-input"
      class="visually-hidden"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      capture="environment"
      multiple
      tabindex="-1"
      aria-label="${a(t("care.photo.add"))}"
      ${busy ? "disabled" : ""}
    /><button
      type="button"
      class="btn-care photo-capture-tile care-photo-add"
      data-add-photo
      ${busy ? "disabled" : ""}
    >
      <wa-icon name="camera" aria-hidden="true"></wa-icon>${e(
        t("care.photo.add"),
      )}
    </button>
    <ul class="care-thumbnails" ${files.length ? "" : "hidden"}>
      ${files
        .map(
          (entry, i) =>
            html`<li>
              <button
                type="button"
                class="btn-care care-photo"
                data-photo-lightbox
                data-photo-no-location
              >
                <img
                  src="${a(entry.url)}"
                  alt="${a(t("care.photo.alt", { index: i + 1 }))}"
                /></button
              ><button
                type="button"
                class="btn-care care-photo-remove"
                data-remove="${i}"
                aria-label="${a(t("care.photo.remove", { index: i + 1 }))}"
                ${busy ? "disabled" : ""}
              >
                <wa-icon name="xmark" aria-hidden="true"></wa-icon>
              </button>
            </li>`,
        )
        .join("")}
    </ul>
  </section>`;
}
export function careCompose(draft, busy = false) {
  const other = draft.kind === "other";
  const note = html`<wa-textarea
    id="care-note"
    label="${a(t(other ? "care.describe" : "care.note.add"))}"
    placeholder="${a(t("care.choose"))}"
    maxlength="4000"
    rows="3"
    resize="vertical"
    ${other ? "required" : ""}
    ${busy ? "disabled" : ""}
  ></wa-textarea>`;
  return html`${careHeader(careKindLabel(draft.kind))}
    <div class="care-compose">
      ${other ? note : ""}${carePhotoPicker(
        draft.files,
        busy || Boolean(draft.payload),
      )}${other ? "" : note}
      <p
        class="care-error"
        role="alert"
        data-error
        ${draft.error ? "" : "hidden"}
      >
        ${e(draft.error || "")}
      </p>
      <p role="status" data-progress ${busy ? "" : "hidden"}>
        ${e(t("care.saving"))}
      </p>
      <button
        type="button"
        class="btn-ink care-cta"
        data-save
        ${busy || (other && !draft.note.trim()) ? "disabled" : ""}
      >
        ${e(t("care.save"))}
      </button>
    </div>`;
}
export function careDetail(work) {
  return html`${careHeader(careTitle(work))}
    <p class="care-timestamp">
      <time datetime="${a(work.createdAt)}"
        >${e(formatPhotoDateTime(work.createdAt))}</time
      >
    </p>
    <div class="care-detail-photos">
      ${work.photos
        .map((photo, i) =>
          photo.url
            ? html`<button
                type="button"
                class="btn-care care-photo"
                data-photo-lightbox
                data-photo-no-location
                data-photo-time="${a(work.createdAt)}"
              >
                <img
                  src="${a(photo.url)}"
                  alt="${a(t("care.photo.alt", { index: i + 1 }))}"
                />
              </button>`
            : "",
        )
        .join("")}
    </div>
    ${work.photos.some((photo) => !photo.url)
      ? `<p class="care-photo-unavailable">${e(t(work.photos.some((photo) => photo.unavailable) ? "care.photo.unavailable" : "care.photo.expired"))}</p>`
      : ""}${work.kind !== "other" && work.note
      ? html`<section class="care-notes">
          <h2>${e(t("care.note"))}</h2>
          <p>${e(work.note)}</p>
        </section>`
      : ""}`;
}
