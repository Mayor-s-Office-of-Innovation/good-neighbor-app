/*
  Presentational template for <ticket-detail-dialog>: the 311 request detail
  sheet opened from a task card. Logic and fetching stay in
  ticket-detail-dialog.js; this file owns only the markup.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { formatOverdueElapsed } from "../domain/home-tasks.js";

function formatTicketDate(date) {
  return date
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(date))
    : "";
}

function formatTicketRelativeDate(date) {
  if (!date) return "";
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000),
  );
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

function ticketEventDescription(description) {
  return description ? html`<p>${escapeHtml(description)}</p>` : "";
}

/**
 * The 311 request detail sheet. `state` drives the loading / error rows;
 * `detail` is the loaded request (null until it arrives).
 * @param {{ detail: any, state: string }} vm — state is "idle" | "loading" | "ready" | "error"
 */
export function ticketDetailDialog({ detail, state }) {
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
          aria-label="Close request details"
        >
          <wa-icon name="xmark" aria-hidden="true"></wa-icon>
        </button>
      </header>
      ${state === "loading"
        ? html`<p role="status">Loading request updates…</p>`
        : ""}
      ${state === "error"
        ? html`<div role="alert">
            <p>We couldn't load the latest 311 updates.</p>
            <button
              type="button"
              class="btn-outline btn-outline--sm"
              data-retry-311
            >
              Try again
            </button>
          </div>`
        : ""}
      ${detail
        ? html` <section
              class="ticket-detail__summary"
              aria-label="Request summary"
            >
              <p
                class="ticket-detail__type ticket-detail__type--${detail.responseOverdue
                  ? "overdue"
                  : detail.status === "Closed"
                    ? "closed"
                    : "default"}"
              >
                <span aria-hidden="true"></span>
                <span class="ticket-detail__type-label">311 request</span>
                <span class="ticket-detail__type-separator" aria-hidden="true"
                  >·</span
                >
                <strong
                  >${escapeHtml(detail.status)}${detail.statusDetail
                    ? html`: ${escapeHtml(detail.statusDetail)}`
                    : ""}</strong
                >
              </p>
              ${detail.location
                ? html`<p class="ticket-detail__location">
                    ${escapeHtml(String(detail.location).split(/\r?\n|,/)[0])}
                  </p>`
                : ""}
              <h2 id="ticket-detail-title">
                ${escapeHtml(
                  detail.title || detail.problemType || "Request details",
                )}
              </h2>
              ${detail.description
                ? html`<p class="ticket-detail__description">
                    ${escapeHtml(detail.description)}
                  </p>`
                : ""}
              ${detail.mediaUrl
                ? html`<img
                    class="ticket-detail__photo"
                    src="${escapeAttr(detail.mediaUrl)}"
                    alt="Evidence for ${escapeAttr(
                      detail.title || detail.problemType || "the 311 request",
                    )}"
                  />`
                : html`<div
                    class="ticket-detail__photo photo-placeholder"
                    role="img"
                    aria-label="No photo available"
                  >
                    <wa-icon name="image" aria-hidden="true"></wa-icon>
                  </div>`}
              <dl class="ticket-detail__metadata">
                ${detail.assignedAgency
                  ? html`<div>
                      <dt>Agency:</dt>
                      <dd>${escapeHtml(detail.assignedAgency)}</dd>
                    </div>`
                  : ""}
                ${detail.submittedAt
                  ? html`<div>
                      <dt>Submitted:</dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketRelativeDate(detail.submittedAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.expectedResponseAt
                  ? html`<div>
                      <dt>Response expected:</dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketDate(detail.expectedResponseAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.closureReason
                  ? html`<div>
                      <dt>Closure reason:</dt>
                      <dd>${escapeHtml(detail.closureReason)}</dd>
                    </div>`
                  : ""}
              </dl>
              ${detail.responseOverdue && detail.expectedResponseAt
                ? html`<p class="ticket-detail__overdue-message">
                    The City's expected response time passed
                    ${escapeHtml(
                      formatOverdueElapsed(detail.expectedResponseAt),
                    )}
                    ago.
                  </p>`
                : ""}
            </section>
            <section class="ticket-detail__updates">
              <h3>Request updates</h3>
              ${detail.events?.length
                ? html`<ol class="ticket-timeline">
                    ${detail.events
                      .map(
                        (event) =>
                          html`<li class="ticket-timeline__item">
                            <div class="ticket-timeline__content">
                              <strong>${escapeHtml(event.title)}</strong
                              >${ticketEventDescription(event.description)}
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
                : html`<p>No updates are available yet.</p>`}
            </section>
            <p class="ticket-detail__reference">
              #${escapeHtml(detail.requestNumber)}
            </p>`
        : ""}
    </div>
  </dialog>`;
}
