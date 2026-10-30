import { describe, expect, it } from "vitest";

import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../lib/html.js";
import {
  actionButton,
  attributionDialog,
  emptyResults,
  errorView,
  homeAllDonePanel,
  homeActions,
  homeResults,
  logoutDialog,
  settingsMenu,
  summaryBlock,
  taskTabs,
} from "./today-view.templates.js";

describe("homeActions", () => {
  it("renders an icon for each overflow-menu action", () => {
    const markup = homeActions({ checkLabel: "Start a full check" });

    expect(markup).toContain('<wa-icon name="bullhorn"');
    expect(markup).toContain('<wa-icon name="flag"');
    expect(markup).not.toContain(t("support.title"));
  });
});

describe("settingsMenu", () => {
  it("renders the menu only while open", () => {
    expect(settingsMenu({ open: false })).not.toContain('role="menu"');
    const open = settingsMenu({ open: true, adminAccess: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('id="settings-help"');
    expect(open).toContain('<wa-icon name="circle-question"');
    expect(open).toContain(t("support.title"));
    expect(open).toContain('id="settings-feedback"');
    expect(open).toContain('id="settings-site-admin"');
    expect(open).toContain('id="settings-reports"');
    expect(open).toContain('id="settings-attributions"');
    expect(open).toContain('id="settings-logout"');
  });

  it("hides Site admin and Reports without admin access", () => {
    const markup = settingsMenu({ open: true, adminAccess: false });
    expect(markup).not.toContain('id="settings-site-admin"');
    expect(markup).not.toContain('id="settings-reports"');
  });
});

describe("attributionDialog", () => {
  it("lists every address-data attribution in an accessible dialog", () => {
    const markup = attributionDialog();

    expect(markup).toContain('id="attributions-dialog"');
    expect(markup).toContain('aria-labelledby="attributions-title"');
    expect(markup).toContain(escapeHtml(t("today.attributions.aws")));
    expect(markup).toContain(escapeHtml(t("today.attributions.census")));
    expect(markup.match(/target="_blank"/g)).toHaveLength(2);
    expect(markup.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
  });
});

describe("logoutDialog", () => {
  it("disables the confirm button and shows the error while pending", () => {
    const idle = logoutDialog({ error: "", pending: false });
    expect(idle).toContain(escapeHtml(t("today.logout.confirm")));
    expect(idle).not.toContain('role="alert"');

    const pending = logoutDialog({ error: "Nope", pending: true });
    expect(pending).toContain(escapeHtml(t("today.logout.pending")));
    expect(pending).toMatch(/id="logout-confirm"[^>]*disabled/);
    expect(pending).toContain('class="logout-dialog__error" role="alert"');
  });

  it("warns about work that hasn't uploaded yet", () => {
    const none = logoutDialog({ error: "", pending: false });
    expect(none).not.toContain('id="logout-unsent"');
    expect(none).toContain('aria-describedby="logout-copy"');

    const markup = logoutDialog({
      error: "",
      pending: false,
      unsent: { checks: 2, careLogs: 1 },
    });
    expect(markup).toContain('id="logout-unsent"');
    expect(markup).toContain('aria-describedby="logout-copy logout-unsent"');
    expect(markup).toContain(
      escapeHtml(t("today.logout.unsentChecks", { count: 2 })),
    );
    expect(markup).toContain(
      escapeHtml(t("today.logout.unsentCareLogs", { count: 1 })),
    );
    expect(markup).toContain(escapeHtml(t("today.logout.unsentHint")));

    const checksOnly = logoutDialog({
      error: "",
      pending: false,
      unsent: { checks: 1, careLogs: 0 },
    });
    expect(checksOnly).toContain(
      escapeHtml(t("today.logout.unsentChecks", { count: 1 })),
    );
    expect(checksOnly).not.toContain(
      escapeHtml(t("today.logout.unsentCareLogs", { count: 0 })),
    );
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
    expect(markup).toContain(escapeHtml(t("today.summary.outsideRadius")));
    expect(markup).toContain(escapeHtml(t("today.summary.changeSite")));
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
    expect(markup).toContain(
      `aria-label="${escapeHtml(t("today.tabs.aria"))}"`,
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("home-tabs__tab--active");
    expect(markup).toContain(escapeHtml(t("home.tab.todo")));
    expect(markup).toContain(escapeHtml(t("home.tab.inProgress")));
    expect(markup).toContain(escapeHtml(t("home.tab.history")));
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
    pendingClearCheck: null,
    historyGroups: [],
  };

  it("shows the all-done panel for an empty To do list", () => {
    expect(homeResults(base)).toContain("home-results__complete");
  });

  it("shows the plain empty message while a session is pending or on other tabs", () => {
    expect(homeResults({ ...base, hasPendingSession: true })).toContain(
      escapeHtml(t("today.empty.todo")),
    );
    expect(homeResults({ ...base, homeFilter: "history" })).toContain(
      escapeHtml(t("today.empty.history")),
    );
    expect(emptyResults({ homeFilter: "in_progress" })).toContain(
      escapeHtml(t("today.empty.inProgress")),
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

describe("errorView", () => {
  it("shows the org line only when known", () => {
    expect(errorView({ identity: { org: "", site: "Site" } })).not.toContain(
      "home-identity__org",
    );
    const markup = errorView({ identity: { org: "Org", site: "Site" } });
    expect(markup).toContain("home-identity__org");
    expect(markup).toContain('id="retry"');
    expect(markup).toContain(escapeHtml(t("today.error.title")));
    expect(markup).toContain(escapeHtml(t("notice.loadHelp")));
    expect(markup).toContain(escapeHtml(t("common.retry")));
  });
});

describe("homeAllDonePanel", () => {
  it("links to the single-issue flow", () => {
    const markup = homeAllDonePanel();
    expect(markup).toContain('data-start-capture="single-problem"');
    expect(markup).toContain(escapeHtml(t("card.clear.addProblem")));
    // The sentence around the link stays one translatable unit.
    const [before, after] = t("today.allDone.note").split("{link}");
    expect(markup).toContain(escapeHtml(before));
    expect(markup).toContain(escapeHtml(after));
    expect(markup).not.toContain("{link}");
  });
});

it("orders manager settings and uses the key icon for access", () => {
  const markup = settingsMenu({ open: true, adminAccess: true });
  const ids = [
    "access",
    "site-admin",
    "reports",
    "feedback",
    "language",
    "attributions",
    "logout",
  ];
  const positions = ids.map((id) => markup.indexOf(`id="settings-${id}"`));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(markup).toContain('name="key"');
});
