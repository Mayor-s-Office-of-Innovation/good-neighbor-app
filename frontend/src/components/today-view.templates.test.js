import { describe, expect, it } from "vitest";

import {
  actionButton,
  emptyResults,
  errorView,
  homeAllDonePanel,
  homeResults,
  logoutDialog,
  reasonPicker,
  settingsMenu,
  summaryBlock,
  taskTabs,
} from "./today-view.templates.js";

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
