import { describe, expect, it } from "vitest";

import {
  actionButton,
  emptyResults,
  errorView,
  homeAllDonePanel,
  homeResults,
  locationDialog,
  logoutDialog,
  reasonPicker,
  settingsMenu,
  siteSwitcher,
  summaryBlock,
  taskTabs,
  ticketDetailDialog,
} from "./today-view.templates.js";

const sites = [
  { siteId: "site-a", name: "Alpha Center" },
  { siteId: "site-b", name: "Beta <Hall>" },
];

describe("settingsMenu", () => {
  it("renders the menu only while open", () => {
    expect(settingsMenu({ open: false })).not.toContain('role="menu"');
    const open = settingsMenu({ open: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('id="settings-logout"');
  });
});

describe("logoutDialog", () => {
  it("disables the confirm button and shows the error while pending", () => {
    const idle = logoutDialog({ error: "", pending: false });
    expect(idle).toContain("Log me out");
    expect(idle).not.toContain('role="alert"');

    const pending = logoutDialog({ error: "Nope", pending: true });
    expect(pending).toContain("Logging out...");
    expect(pending).toMatch(/id="logout-confirm"[^>]*disabled/);
    expect(pending).toContain('class="logout-dialog__error" role="alert"');
  });

  it("escapes the error text", () => {
    const markup = logoutDialog({
      error: "<img src=x onerror=1>",
      pending: false,
    });
    expect(markup).toContain("&lt;img src=x onerror=1&gt;");
    expect(markup).not.toContain("<img");
  });
});

describe("siteSwitcher", () => {
  it("lists sites with the current one marked only while open", () => {
    const closed = siteSwitcher({
      providerName: "Provider One",
      sites,
      currentSiteId: "site-a",
      open: false,
      error: "",
      status: "loaded",
    });
    expect(closed).toContain("Provider One");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('id="site-switcher-list"');

    const open = siteSwitcher({
      providerName: "",
      sites,
      currentSiteId: "site-a",
      open: true,
      error: "",
      status: "loaded",
    });
    expect(open).toContain("Your provider");
    expect(open).toContain('data-switch-site="site-a"');
    expect(open).toContain('aria-current="page"');
    expect(open).toContain("Beta &lt;Hall&gt;");
    expect(open).not.toContain("Beta <Hall>");
  });

  it("shows the loading, failure, and error rows", () => {
    const base = {
      providerName: "P",
      sites,
      currentSiteId: "site-a",
      open: true,
    };
    expect(siteSwitcher({ ...base, error: "", status: "loading" })).toContain(
      "Loading sites…",
    );
    expect(siteSwitcher({ ...base, error: "", status: "error" })).toContain(
      'id="site-catalog-retry"',
    );
    expect(siteSwitcher({ ...base, error: "Bad", status: "loaded" })).toContain(
      'class="home-site-switcher__error" role="alert"',
    );
  });
});

describe("locationDialog", () => {
  it("names the site and presses the current option", () => {
    const markup = locationDialog({
      siteName: "Alpha Center",
      sites,
      currentSiteId: "site-b",
    });
    expect(markup).toContain("not near Alpha Center");
    expect(markup).toMatch(/data-location-site="site-b"\s+aria-pressed="true"/);
    expect(markup).toMatch(
      /data-location-site="site-a"\s+aria-pressed="false"/,
    );
    expect(markup).toMatch(/id="location-confirm"[^>]*disabled/);
  });
});

describe("summaryBlock", () => {
  it("offers a site change when the device is far away", () => {
    const markup = summaryBlock({ outsideRadius: true, label: "ignored" });
    expect(markup).toContain('id="lastlog-change-site"');
    expect(markup).not.toContain("ignored");
  });

  it("renders nothing without a label and escapes one", () => {
    expect(summaryBlock({ outsideRadius: false, label: "" })).toBe("");
    expect(
      summaryBlock({ outsideRadius: false, label: "Last log: <b>" }),
    ).toContain("Last log: &lt;b&gt;");
  });
});

describe("taskTabs", () => {
  it("uses accessible filter buttons rather than incomplete tab semantics", () => {
    const markup = taskTabs({ activeId: "todo" });
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("home-tabs__tab--active");
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('tabindex="-1"');
  });
});

describe("homeResults", () => {
  const base = {
    homeFilter: "todo",
    siteName: "Alpha",
    siteAddress: "1 Main",
    pendingSessionId: "",
    hasPendingSession: false,
    recentCheckTime: "",
    recentItems: [],
    newTaskCards: [],
    newTaskCardsMarkup: "",
    newTaskCount: 0,
    activeClearCheck: null,
    hasPendingClearResult: false,
    historyGroups: [],
  };

  it("shows the all-done panel for an empty To do list", () => {
    expect(homeResults(base)).toContain("home-results__complete");
  });

  it("shows the plain empty message while a session is pending or on other tabs", () => {
    expect(homeResults({ ...base, hasPendingSession: true })).toContain(
      "No tasks to do.",
    );
    expect(homeResults({ ...base, homeFilter: "history" })).toContain(
      "No task history yet.",
    );
    expect(emptyResults({ homeFilter: "in_progress" })).toContain(
      "No tasks in progress.",
    );
  });

  it("renders one history tray per group", () => {
    const markup = homeResults({
      ...base,
      homeFilter: "history",
      historyGroups: [
        { checkTime: "2026-09-01T10:00:00.000Z", cards: "<p>card-1</p>" },
        { checkTime: "2026-08-01T10:00:00.000Z", cards: "" },
      ],
    });
    expect(markup).toContain("home-results__cards");
    expect(markup).toContain("<p>card-1</p>");
    expect(markup.match(/analysis-tray--history/g)).toHaveLength(2);
    expect(markup).not.toContain("home-results__empty");
  });

  it("renders the new-results tray when new task cards exist", () => {
    const markup = homeResults({
      ...base,
      newTaskCount: 1,
      newTaskCardsMarkup: "<p>new-card</p>",
      recentCheckTime: new Date().toISOString(),
    });
    expect(markup).toContain("analysis-tray--recent");
    expect(markup).toContain("<p>new-card</p>");
  });
});

describe("actionButton", () => {
  it("renders links, disabled emails, and data-action buttons", () => {
    expect(
      actionButton({
        kind: "email",
        label: "Email",
        variant: "blue",
        href: "mailto:a@b.c",
      }),
    ).toMatch(
      /^<a class="btn-blue btn-blue--sm" href="mailto:a@b.c"\s*>Email<\/a\s*>$/,
    );
    expect(
      actionButton({
        kind: "email",
        label: "Email",
        variant: "blue",
        href: null,
      }),
    ).toMatch(/<button[^>]*disabled/);
    expect(
      actionButton({ kind: "done", label: "Done", variant: "ink" }),
    ).toContain('data-action="done"');
  });

  it("escapes the link target so a payload cannot break out of the attribute", () => {
    const markup = actionButton({
      kind: "email",
      label: "Email",
      variant: "blue",
      href: 'mailto:a@b.c" onmouseover="alert(1)',
    });
    expect(markup).toContain(
      'href="mailto:a@b.c&quot; onmouseover=&quot;alert(1)"',
    );
    expect(markup).not.toContain('" onmouseover="');
  });
});

describe("reasonPicker", () => {
  it("lists each reason and a cancel", () => {
    const markup = reasonPicker({ reasons: ["Locked", "No access"] });
    expect(markup.match(/data-action="cant-reason"/g)).toHaveLength(2);
    expect(markup).toContain('data-reason="No access"');
    expect(markup).toContain('data-action="cant-cancel"');
  });
});

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

describe("errorView", () => {
  it("shows the org line only when known", () => {
    expect(errorView({ identity: { org: "", site: "Site" } })).not.toContain(
      "home-identity__org",
    );
    const markup = errorView({ identity: { org: "Org", site: "Site" } });
    expect(markup).toContain("home-identity__org");
    expect(markup).toContain('id="retry"');
  });
});

describe("homeAllDonePanel", () => {
  it("links to the single-issue flow", () => {
    expect(homeAllDonePanel()).toContain('data-start-capture="single-problem"');
  });
});
