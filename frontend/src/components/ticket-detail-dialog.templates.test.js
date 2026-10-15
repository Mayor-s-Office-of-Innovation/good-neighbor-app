import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import { rulebookKey } from "../i18n/rulebook.js";
import { escapeHtml } from "../lib/html.js";
import { formatOverdueElapsed } from "../domain/home-tasks.js";
import { ticketDetailDialog } from "./ticket-detail-dialog.templates.js";

describe("ticketDetailDialog", () => {
  it("renders the loading and error rows", () => {
    expect(ticketDetailDialog({ detail: null, state: "loading" })).toContain(
      t("ticket.loading"),
    );
    const error = ticketDetailDialog({ detail: null, state: "error" });
    expect(error).toContain("data-retry-311");
    expect(error).not.toContain("ticket-detail__summary");
  });

  it("renders the request summary, overdue tone, and timeline", () => {
    const expectedResponseAt = "2026-09-01T00:00:00.000Z";
    const markup = ticketDetailDialog({
      state: "ready",
      detail: {
        status: "Open",
        statusDetail: "Assigned",
        responseOverdue: true,
        expectedResponseAt,
        title: "Trash <in> tree well",
        location: "1 Main St, San Francisco",
        requestNumber: "12345",
        events: [
          {
            title: "Opened",
            description: "Filed",
            occurredAt: "2026-08-30T00:00:00.000Z",
          },
        ],
      },
    });
    expect(markup).toContain("ticket-detail__type--overdue");
    expect(markup).toContain("Open: Assigned");
    expect(markup).toContain("Trash &lt;in&gt; tree well");
    expect(markup).toContain("1 Main St");
    expect(markup).not.toContain("San Francisco");
    expect(markup).toContain(
      escapeHtml(
        t("ticket.overdue.message", {
          elapsed: formatOverdueElapsed(expectedResponseAt),
        }),
      ),
    );
    expect(markup).toContain("ticket-timeline__item");
    expect(markup).toContain("<p>Filed</p>");
    expect(markup).toContain("#12345");
    expect(markup).toContain(`aria-label="${t("ticket.photo.none")}"`);
  });

  it("falls back when there are no updates", () => {
    const markup = ticketDetailDialog({
      state: "ready",
      detail: { status: "Closed", requestNumber: "1", events: [] },
    });
    expect(markup).toContain("ticket-detail__type--closed");
    expect(markup).toContain(t("ticket.updates.empty"));
  });

  it("describes when the request was submitted relative to today", () => {
    const render = (submittedAt) =>
      ticketDetailDialog({
        state: "ready",
        detail: { status: "Open", requestNumber: "1", events: [], submittedAt },
      });
    const dayMs = 86_400_000;
    expect(render(new Date().toISOString())).toContain(t("date.today"));
    expect(render(new Date(Date.now() - dayMs).toISOString())).toContain(
      t("date.daysAgo", { count: 1 }),
    );
    expect(render(new Date(Date.now() - 3 * dayMs).toISOString())).toContain(
      t("date.daysAgo", { count: 3 }),
    );
  });
});

describe("ticketDetailDialog 311 timeline events", () => {
  it("rebuilds structured event sentences through the catalog", () => {
    const markup = ticketDetailDialog({
      state: "ready",
      detail: {
        status: "Closed",
        statusDetail: "resolved",
        title: "Litter",
        requestNumber: "1",
        events: [
          {
            kind: "statusChanged",
            value: "Closed",
            title: "Ticket status changed to Closed",
            occurredAt: "2026-09-02T00:00:00.000Z",
          },
          {
            kind: "resolved",
            closureReason: "Field Work Completed",
            notes: "Removed the debris.",
            title: "The ticket was resolved",
            description:
              "Agency said: Field Work Completed\nRemoved the debris.",
            occurredAt: "2026-09-03T00:00:00.000Z",
          },
          {
            title: "Something legacy without a kind",
            occurredAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(markup).toContain(
      escapeHtml(
        t("server.sf311.eventTitle.statusChanged", {
          value: t(rulebookKey("Closed")),
        }),
      ),
    );
    expect(markup).toContain(escapeHtml(t("server.sf311.eventTitle.resolved")));
    expect(markup).toContain(escapeHtml("Removed the debris."));
    expect(markup).toContain(escapeHtml("Something legacy without a kind"));
    // Status line keeps the backend's lower-cased closure detail.
    expect(markup).toMatch(/Closed: resolved/);
  });
});

it.each(["in_progress", "completed"])(
  "shows saved content in the %s 311 timeline",
  (status) => {
    const markup = ticketDetailDialog({
      state: "ready",
      detail: {
        status: status === "completed" ? "Closed" : "Open",
        task: { status },
        title: "Litter",
        mediaUrls: new Map([["photo-1", "https://example.test/photo.jpg"]]),
        events: [
          { title: "Agency update", occurredAt: "2026-10-08T10:00:00Z" },
        ],
        updates: [
          {
            type: "note_photo_update",
            label: "Updated with photos and notes",
            notes: ["Still <there>"],
            photoKeys: ["photo-1"],
            occurredAt: "2026-10-08T12:00:00Z",
          },
          {
            type: "additional_action",
            label: "Additional action taken",
            text: "Called agency",
            occurredAt: "2026-10-08T11:00:00Z",
          },
        ],
        nextToken: "older",
      },
    });
    expect(markup).toContain("Still &lt;there&gt;");
    expect(markup).toContain('src="https://example.test/photo.jpg"');
    expect(markup.indexOf("Still &lt;there&gt;")).toBeLessThan(
      markup.indexOf("Called agency"),
    );
    expect(markup.indexOf("Called agency")).toBeLessThan(
      markup.indexOf("Agency update"),
    );
    expect(markup).toContain("data-load-older");
    expect(markup.includes('data-mode="notes"')).toBe(status === "in_progress");
    expect(markup.includes('data-mode="action"')).toBe(
      status === "in_progress",
    );
  },
);
