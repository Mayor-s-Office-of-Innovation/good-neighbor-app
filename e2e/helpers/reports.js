/*
  Route stubs for the site manager reports (/reports). The report endpoints
  are deterministic functions of the table, so the specs stub them with a
  fixed week rather than seeding checks: the screens render the same
  whatever the local table holds and whatever today's date is.
*/

export const REPORT_TODAY = "2026-09-30";
export const REPORT_DAY = "2026-09-29";

/** @param {string} date @param {string} status @param {number} completed @param {Partial<Record<string, any>>} [extra] */
const day = (date, status, completed, extra = {}) => ({
  date,
  status,
  required: 3,
  completed,
  reports: 0,
  issueCount: 0,
  checkIds: [],
  ...extra,
});

const period = {
  kind: "week",
  start: "2026-09-27",
  endExclusive: "2026-10-04",
};

export const CHECKS_REPORT = {
  period,
  today: REPORT_TODAY,
  requirement: { requiredPerDay: 3, required: true },
  days: [
    day("2026-09-27", "complete", 3, {
      issueCount: 2,
      checkIds: ["c1", "c2", "c3"],
    }),
    day("2026-09-28", "partial", 1, { checkIds: ["c4"] }),
    day(REPORT_DAY, "partial", 2, { issueCount: 1, checkIds: ["c5", "c6"] }),
    day(REPORT_TODAY, "pending", 1, { checkIds: ["c7"] }),
    day("2026-10-01", "upcoming", 0),
    day("2026-10-02", "upcoming", 0),
    day("2026-10-03", "upcoming", 0),
  ],
  totals: { possible: 12, completed: 7, recorded: 7, missed: 3, issueCount: 3 },
  previous: {
    kind: "week",
    start: "2026-09-20",
    endExclusive: "2026-09-27",
    totals: {
      possible: 21,
      completed: 18,
      recorded: 18,
      missed: 3,
      issueCount: 5,
    },
  },
};

export const TASKS_REPORT = {
  period,
  today: REPORT_TODAY,
  tasks: [
    // A 311 request: its card opens the request sheet.
    {
      taskId: "t1",
      shortId: "GUB-STJ-041",
      checkId: "c5",
      category: "Litter",
      guidance: "Bag it and place it in the bin.",
      kind: "escalation",
      status: "completed",
      completionMethod: "311_filed",
      latestUpdateLabel: "Resolved",
      sourceArtifactIds: ["c5-photo"],
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: { tickets: [{ srNum: "SR-100" }] },
        },
      ],
      createdAt: "2026-09-29T16:10:00.000Z",
    },
    // An on-site action: its card opens the updates timeline.
    {
      taskId: "t2",
      shortId: "GUB-STJ-042",
      checkId: "c5",
      category: "Graffiti",
      kind: "action",
      status: "completed",
      completionMethod: "site_team_resolved",
      sourceArtifactIds: ["c5-photo"],
      createdAt: "2026-09-29T16:12:00.000Z",
    },
  ],
  previous: {
    kind: "week",
    start: "2026-09-20",
    endExclusive: "2026-09-27",
    count: 4,
    byType: { Litter: 3, Graffiti: 1 },
  },
};

/** A 1x1 GIF, so card thumbnails never hit the network. */
const PHOTO_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * @param {string} checkId @param {string} completedAt @param {number} issueCount
 * @param {{ photo?: boolean }} [extra] add a georeferenced photo artifact
 */
const check = (checkId, completedAt, issueCount, { photo = false } = {}) => ({
  check: {
    checkId,
    status: "completed",
    flowType: "perimeter",
    startedAt: completedAt,
    completedAt,
    issueCount,
  },
  artifacts: [
    ...(photo
      ? [
          {
            artifactId: `${checkId}-photo`,
            s3Key: `checks/${checkId}/photo.jpg`,
            contentType: "image/jpeg",
          },
        ]
      : []),
    {
      artifactId: `${checkId}-text`,
      text: "Sidewalk clear, one bag of litter.",
    },
  ],
  analyses: photo
    ? [
        {
          artifactId: `${checkId}-photo`,
          georeferencedAddress: "15th St, San Francisco, CA",
        },
      ]
    : [],
});

/**
 * Install the stubs on a page. Call before navigating to /reports.
 * @param {import("@playwright/test").Page} page
 */
export async function stubReports(page) {
  await page.route("**/app/v1/manager/reports/checks?*", (route) =>
    route.fulfill({ json: CHECKS_REPORT }),
  );
  await page.route("**/app/v1/manager/reports/tasks?*", (route) =>
    route.fulfill({ json: TASKS_REPORT }),
  );
  await page.route("**/v1/checks/c5", (route) =>
    route.fulfill({
      json: check("c5", "2026-09-29T16:04:00.000Z", 1, { photo: true }),
    }),
  );
  await page.route("**/v1/checks/c6", (route) =>
    route.fulfill({ json: check("c6", "2026-09-29T21:07:00.000Z", 0) }),
  );
  await page.route("**/v1/checks/c5/artifacts/c5-photo/media", (route) =>
    route.fulfill({ json: { downloadUrl: PHOTO_DATA_URL } }),
  );
  // The day's task cards: live 311 status, the request sheet, and the
  // updates timeline.
  await page.route("**/v1/311-requests:batch", (route) =>
    route.fulfill({
      json: { requests: [{ taskId: "t1", request: { status: "Open" } }] },
    }),
  );
  await page.route("**/v1/tasks/t1/311-requests/SR-100", (route) =>
    route.fulfill({
      json: {
        request: {
          srNum: "SR-100",
          requestNumber: "SF-GUB-222",
          status: "Open",
          agency: "Department of Public Works",
          submittedAt: "2026-09-29T16:15:00.000Z",
          updates: [],
        },
      },
    }),
  );
  for (const task of TASKS_REPORT.tasks) {
    await page.route(`**/v1/tasks/${task.taskId}/updates*`, (route) =>
      route.fulfill({ json: { task, updates: [], nextToken: null } }),
    );
  }
}

/**
 * Open the reports from the home settings menu and wait for the records.
 * @param {import("@playwright/test").Page} page
 */
export async function openReports(page) {
  await page.locator("#home-settings").click();
  await page.locator("#settings-reports").click();
  await page.waitForURL(/\/reports/);
  await page.locator(".reports__records").waitFor();
}
