import { describe, expect, it } from "vitest";

import { ticketDetailDialog } from "./ticket-detail-dialog.templates.js";

describe("ticketDetailDialog", () => {
  it("renders the loading and error rows", () => {
    expect(ticketDetailDialog({ detail: null, state: "loading" })).toContain(
      "Loading request updates…",
    );
    const error = ticketDetailDialog({ detail: null, state: "error" });
    expect(error).toContain("data-retry-311");
    expect(error).not.toContain("ticket-detail__summary");
  });

  it("renders the request summary, overdue tone, and timeline", () => {
    const markup = ticketDetailDialog({
      state: "ready",
      detail: {
        status: "Open",
        statusDetail: "Assigned",
        responseOverdue: true,
        expectedResponseAt: "2026-09-01T00:00:00.000Z",
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
    expect(markup).toContain("expected response time passed");
    expect(markup).toContain("ticket-timeline__item");
    expect(markup).toContain("<p>Filed</p>");
    expect(markup).toContain("#12345");
    expect(markup).toContain('aria-label="No photo available"');
  });

  it("falls back when there are no updates", () => {
    const markup = ticketDetailDialog({
      state: "ready",
      detail: { status: "Closed", requestNumber: "1", events: [] },
    });
    expect(markup).toContain("ticket-detail__type--closed");
    expect(markup).toContain("No updates are available yet.");
  });
});
