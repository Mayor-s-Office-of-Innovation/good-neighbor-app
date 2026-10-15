import {
  taskUpdateActions,
  taskUpdateTimelineItem,
} from "./issue-updates.templates.js";
/*
  Presentational template for <ticket-detail-dialog>: the 311 request detail
  sheet opened from a task card. Logic and fetching stay in
  ticket-detail-dialog.js; this file owns only the markup.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { hasKey, t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { statusLine } from "./analysis-results.templates.js";
import { formatDateTime, pacificDaysAgo } from "../i18n/dates.js";

/** Key-prefix scope for 311 vocabulary ("Resolved" also exists as a task label). */
const SF311 = "server.sf311";
import { formatOverdueElapsed } from "../domain/home-tasks.js";

function formatTicketDate(date) {
  return date
    ? formatDateTime(date, { dateStyle: "medium", timeStyle: "short" })
    : "";
}

function formatTicketRelativeDate(date) {
  if (!date) return "";
  const days = Math.max(0, pacificDaysAgo(date) ?? 0);
  return days === 0 ? t("date.today") : t("date.daysAgo", { count: days });
}

/**
 * 311 timeline events arrive with the English sentence already filled in
 * (`title`) plus the structured `kind` / `value` it was built from, so the
 * sentence can be rebuilt in the active language. Unknown kinds fall back to
 * the English title.
 * @param {{ kind?: string, value?: string, title?: string }} event
 */
function ticketEventTitle(event) {
  const key = event.kind ? `server.sf311.eventTitle.${event.kind}` : "";
  if (key && hasKey(key)) {
    return t(key, { value: rulebookText(event.value ?? "", SF311) });
  }
  return rulebookText(event.title, SF311);
}

/** @param {{ kind?: string, closureReason?: string, notes?: string, description?: string }} event */
function ticketEventDescription(event) {
  let description = event.description;
  if (event.kind === "resolved" && event.closureReason) {
    description = [
      t("server.sf311.eventDescription.agencySaid", {
        value: rulebookText(event.closureReason, SF311),
      }),
      event.notes,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return description ? html`<p>${escapeHtml(description)}</p>` : "";
}

/**
 * The 311 request detail sheet. `state` drives the loading / error rows;
 * `detail` is the loaded request (null until it arrives).
 * @param {{ detail: any, state: string }} vm — state is "idle" | "loading" | "ready" | "error"
 */
export function ticketDetailDialog({ detail, state }) {
  const events = [
    ...(detail?.events || []).map((event) => ({ ...event, local: false })),
    ...(detail?.updates || []).map((event) => ({ ...event, local: true })),
  ].sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
  return html` <dialog
    class="ticket-detail"
    id="ticket-detail-dialog"
    aria-labelledby="ticket-detail-title"
  >
    <div class="ticket-detail__sheet">
      <header class="ticket-detail__header">
        <button
          type="button"
          class="btn-icon ticket-detail__close wa-plain"
          data-close-311
          aria-label="${escapeAttr(t("ticket.close.aria"))}"
        >
          <wa-icon name="xmark" aria-hidden="true"></wa-icon>
        </button>
      </header>
      ${state === "loading"
        ? html`<p role="status">${escapeHtml(t("ticket.loading"))}</p>`
        : ""}
      ${state === "error"
        ? html`<div role="alert">
            <p>${escapeHtml(t("ticket.loadError"))}</p>
            <button
              type="button"
              class="btn-outline btn-outline--sm"
              data-retry-311
            >
              ${escapeHtml(t("common.retry"))}
            </button>
          </div>`
        : ""}
      ${detail
        ? html` <section
              class="ticket-detail__summary"
              aria-label="${escapeAttr(t("ticket.summary.aria"))}"
            >
              <p
                class="ticket-detail__type ticket-detail__type--${detail.responseOverdue
                  ? "overdue"
                  : detail.status === "Closed"
                    ? "closed"
                    : "default"}"
              >
                <span aria-hidden="true"></span>
                <span class="ticket-detail__type-label"
                  >${escapeHtml(t("card.route.ticket"))}</span
                >
                <span class="ticket-detail__type-separator" aria-hidden="true"
                  >·</span
                >
                <strong
                  >${escapeHtml(
                    statusLine(detail.status, detail.statusDetail, SF311),
                  )}</strong
                >
              </p>
              ${detail.location
                ? html`<p class="ticket-detail__location">
                    ${escapeHtml(String(detail.location).split(/\r?\n|,/)[0])}
                  </p>`
                : ""}
              <h2 id="ticket-detail-title">
                ${escapeHtml(
                  detail.title ||
                    detail.problemType ||
                    t("ticket.fallbackTitle"),
                )}
              </h2>
              ${detail.description
                ? html`<p class="ticket-detail__description">
                    ${escapeHtml(detail.description)}
                  </p>`
                : ""}
              ${detail.mediaUrl
                ? html`<button
                    class="ticket-detail__photo-trigger"
                    type="button"
                    data-photo-lightbox
                    data-photo-address="${escapeAttr(detail.location || "")}"
                    data-photo-time="${escapeAttr(detail.submittedAt || "")}"
                  >
                    <img
                      class="ticket-detail__photo"
                      src="${escapeAttr(detail.mediaUrl)}"
                      alt="${escapeAttr(
                        t("taskUpdate.photo.evidenceAlt", {
                          title:
                            detail.title ||
                            detail.problemType ||
                            t("ticket.photo.fallbackSubject"),
                        }),
                      )}"
                    />
                  </button>`
                : html`<div
                    class="ticket-detail__photo photo-placeholder"
                    role="img"
                    aria-label="${escapeAttr(t("ticket.photo.none"))}"
                  >
                    <wa-icon name="image" aria-hidden="true"></wa-icon>
                  </div>`}
              <dl class="ticket-detail__metadata">
                ${detail.assignedAgency
                  ? html`<div>
                      <dt>${escapeHtml(t("taskUpdate.metadata.agency"))}</dt>
                      <dd>
                        ${escapeHtml(
                          rulebookText(detail.assignedAgency, SF311),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.submittedAt
                  ? html`<div>
                      <dt>${escapeHtml(t("ticket.metadata.submitted"))}</dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketRelativeDate(detail.submittedAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.expectedResponseAt
                  ? html`<div>
                      <dt>
                        ${escapeHtml(t("ticket.metadata.responseExpected"))}
                      </dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketDate(detail.expectedResponseAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.closureReason
                  ? html`<div>
                      <dt>${escapeHtml(t("ticket.metadata.closureReason"))}</dt>
                      <dd>
                        ${escapeHtml(rulebookText(detail.closureReason, SF311))}
                      </dd>
                    </div>`
                  : ""}
              </dl>
              ${detail.responseOverdue && detail.expectedResponseAt
                ? html`<p class="ticket-detail__overdue-message">
                    ${escapeHtml(
                      t("ticket.overdue.message", {
                        elapsed: formatOverdueElapsed(
                          detail.expectedResponseAt,
                        ),
                      }),
                    )}
                  </p>`
                : ""}
            </section>
            <section class="ticket-detail__updates">
              <h3>${escapeHtml(t("ticket.updates.title"))}</h3>
              ${detail.task?.status === "in_progress" &&
              detail.status !== "Closed"
                ? taskUpdateActions()
                : ""}
              ${events.length
                ? html`<ol class="ticket-timeline">
                    ${events
                      .map((event) =>
                        event.local
                          ? taskUpdateTimelineItem(
                              event,
                              detail.task || {},
                              detail.mediaUrls || new Map(),
                              detail.title || "",
                            )
                          : html`<li class="ticket-timeline__item">
                              <div class="ticket-timeline__content">
                                <strong
                                  >${escapeHtml(
                                    ticketEventTitle(event),
                                  )}</strong
                                >${ticketEventDescription(event)}
                                <time datetime="${escapeAttr(event.occurredAt)}"
                                  >${escapeHtml(
                                    formatTicketDate(event.occurredAt),
                                  )}</time
                                >
                              </div>
                            </li>`,
                      )
                      .join("")}
                  </ol>`
                : html`<p>${escapeHtml(t("ticket.updates.empty"))}</p>`}
              ${detail.nextToken
                ? html`<button
                    type="button"
                    class="btn-outline"
                    data-load-older
                  >
                    ${escapeHtml(t("taskUpdate.updates.loadOlder"))}
                  </button>`
                : ""}
            </section>
            <p class="ticket-detail__reference">
              #${escapeHtml(detail.requestNumber)}
            </p>`
        : ""}
    </div>
  </dialog>`;
}
