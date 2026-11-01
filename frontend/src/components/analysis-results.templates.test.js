import { setDuplicateUiSite } from "../services/feature-flags.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t, setLocale } from "../i18n/i18n.js";
import { formatNumericDate, formatTime, formatWeekday } from "../i18n/dates.js";
import { escapeHtml } from "../lib/html.js";
import {
  analysisActionPriority,
  analysisCards,
  analysisResultsTray,
  historicalCheckTitle,
  problemSummary,
  problemSummaryLabel,
  sortAnalysisCards,
  taskAnalysisCard,
  updatedCardTime,
} from "./analysis-results.templates.js";

/** Fixture helper — test items only need the fields the templates read. */
const item = (fields) => /** @type {any} */ (fields);

describe("historical check titles", () => {
  const now = new Date(2026, 8, 23, 12, 0);

  it("shows the time for a superseded check from today", () => {
    const date = new Date(2026, 8, 23, 9, 5);
    expect(historicalCheckTitle(date, now)).toBe(
      t("analysis.checkTitle.today", { time: formatTime(date) }),
    );
  });

  it("uses yesterday for the prior calendar day", () => {
    expect(historicalCheckTitle(new Date(2026, 8, 22, 9, 0), now)).toBe(
      t("analysis.checkTitle.yesterday"),
    );
  });

  it("uses the weekday within the current calendar week", () => {
    const date = new Date(2026, 8, 21, 9, 0);
    expect(historicalCheckTitle(date, now)).toBe(
      t("analysis.checkTitle.weekday", { weekday: formatWeekday(date) }),
    );
  });

  it("uses a numeric date before the current calendar week", () => {
    const date = new Date(2026, 8, 14, 9, 0);
    expect(historicalCheckTitle(date, now)).toBe(
      t("analysis.checkTitle.date", { date: formatNumericDate(date) }),
    );
  });
});

describe("analysis result summaries", () => {
  it("ranks unanswered cards first, then emergency, non-emergency, 311 and on-site", () => {
    const tasks = [
      { kind: "action" },
      { kind: "escalation" },
      { kind: "non_actionable_escalation" },
      {
        kind: "non_actionable_escalation",
        appActions: [{ code: "open_phone", payload: { phoneNumber: "911" } }],
      },
    ];
    /** @type {Array<{markup: string, createdAt: string, actionPriority: number, needsAnswer?: boolean}>} */
    const cards = tasks.map((task, index) => ({
      markup: String(index),
      createdAt: `2026-09-22T1${index}:00:00Z`,
      actionPriority: analysisActionPriority(task),
    }));
    cards.push({ ...cards[0], markup: "question", needsAnswer: true });
    expect(sortAnalysisCards(cards).map((card) => card.markup)).toEqual([
      "question",
      "3",
      "2",
      "1",
      "0",
    ]);
    expect(
      sortAnalysisCards([
        { ...cards[1], markup: "older", createdAt: "2026-09-22T09:00:00Z" },
        { ...cards[1], markup: "newer", createdAt: "2026-09-22T11:00:00Z" },
      ]).map((card) => card.markup),
    ).toEqual(["newer", "older"]);
  });

  it("sorts unanswered questions first, then each card by its displayed timestamp", () => {
    const cards = [
      { markup: "older action", createdAt: "2026-09-22T09:00:00Z" },
      { markup: "newer action", createdAt: "2026-09-22T11:00:00Z" },
      {
        markup: "older question",
        createdAt: "2026-09-22T08:00:00Z",
        needsAnswer: true,
      },
      {
        markup: "newer question",
        createdAt: "2026-09-22T10:00:00Z",
        needsAnswer: true,
      },
    ];

    expect(sortAnalysisCards(cards).map((card) => card.markup)).toEqual([
      "newer question",
      "older question",
      "newer action",
      "older action",
    ]);
    expect(
      sortAnalysisCards(
        cards.map((card) =>
          card.markup === "older question"
            ? { ...card, needsAnswer: false }
            : card,
        ),
      ).map((card) => card.markup),
    ).toEqual([
      "newer question",
      "newer action",
      "older action",
      "older question",
    ]);
    expect(cards[0].markup).toBe("older action");
  });

  it("orders live result cards and persisted cards together within one check", () => {
    const markup = analysisResultsTray(
      [
        {
          id: "old-question",
          uploadedAt: "2026-09-22T08:00:00Z",
          analysis: {
            status: "analyzed",
            tasks: [],
            conditions: [
              {
                conditionId: "needs-answer",
                description: "Question from the older photo.",
                needsAnswer: {
                  key: "onsite",
                  prompt: "Is this yours?",
                  options: [{ label: "Yes", value: true }],
                },
              },
            ],
          },
        },
        {
          id: "newer-photo",
          uploadedAt: "2026-09-22T11:00:00Z",
          analysis: {
            status: "analyzed",
            tasks: [
              {
                taskId: "live-task",
                userFriendlyLabel: "Newer live issue",
                guidance: "Review it.",
                kind: "action",
              },
            ],
            conditions: [],
          },
        },
      ],
      "check-1",
      {
        extraCards: [
          {
            markup:
              '<article data-testid="persisted">Persisted issue</article>',
            createdAt: "2026-09-22T10:00:00Z",
          },
        ],
      },
    );

    expect(markup.indexOf("Question from the older photo.")).toBeLessThan(
      markup.indexOf("Newer live issue"),
    );
    expect(markup.indexOf("Newer live issue")).toBeLessThan(
      markup.indexOf("Persisted issue"),
    );
  });

  it("uses the user-friendly condition label as the card title", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          tasks: [
            {
              taskId: "task_1",
              conditionId: "condition_litter",
              category: "Litter",
              label: "File a 311 ticket",
              userFriendlyLabel: "Lots of trash in tree well",
              guidance: "Use the app to file a 311 ticket.",
              kind: "escalation",
            },
          ],
          conditions: [],
        },
      },
      "check_1",
    );

    expect(cards[0]).toContain("Lots of trash in tree well");
    expect(cards[0]).not.toContain(">Litter</h3>");
  });

  it.each(["Litter", "Trash beside the sidewalk"])(
    "renders analyzer fallback label %s without framing and retains evidence",
    (label) => {
      const cards = analysisCards(
        {
          id: "optional-photo",
          kind: "photo",
          dataUrl: "https://example.test/evidence.jpg",
          analysis: {
            status: "analyzed",
            artifactId: "artifact-optional",
            sourceAnalysis: {},
            conditions: [],
            tasks: [
              {
                taskId: "task-optional",
                conditionId: "condition-optional",
                category: "Litter",
                userFriendlyLabel: label,
                label: "File a 311 ticket",
                guidance: "Report this issue.",
                kind: "escalation",
              },
            ],
          },
        },
        "check-optional",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]).toContain(escapeHtml(label));
      expect(cards[0]).toContain("https://example.test/evidence.jpg");
      expect(cards[0]).toContain("task-optional");
      expect(cards[0]).not.toContain("analysis-card--failed");
    },
  );

  it("keeps category titles as a fallback for legacy cards", () => {
    const card = taskAnalysisCard({
      task: { taskId: "task_1", category: "Litter" },
      action: null,
      statusLabel: "Existing",
    });

    expect(card).toContain(">Litter</h3>");
  });

  it("shows task short ids instead of raw assessment ids on task cards", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          assessment: { assessmentId: "long-assessment-id" },
          tasks: [
            {
              taskId: "task_1",
              shortId: "GUB-STJ-001",
              assessmentId: "long-assessment-id",
              conditionId: "condition_tents",
              category: "Tents, tarps, or bedding",
              guidance: "File a 311 ticket.",
              kind: "escalation",
              buttons: ["File 311 ticket"],
            },
          ],
          conditions: [
            {
              conditionId: "condition_tents",
              category: "Tents, tarps, or bedding",
              description: "Tent on the sidewalk.",
            },
          ],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(
      t("card.meta.newWithReference", { reference: "GUB-STJ-001" }),
    );
    expect(cards[0]).not.toContain("long-assessment-id");
  });

  it("falls back to assessment ids for legacy task cards without display ids", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          tasks: [
            {
              taskId: "task_1",
              assessmentId: "legacy-assessment-id",
              conditionId: "condition_litter",
              category: "Litter",
              guidance: "File a 311 ticket.",
              kind: "escalation",
            },
          ],
          conditions: [
            {
              conditionId: "condition_litter",
              category: "Litter",
              description: "Trash is visible.",
            },
          ],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(
      t("card.meta.newWithReference", { reference: "legacy-assessment-id" }),
    );
  });

  it("does not show raw assessment ids on condition cards awaiting answers", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          assessment: { assessmentId: "long-assessment-id" },
          tasks: [],
          conditions: [
            {
              conditionId: "condition_blocking",
              category: "Blocking access",
              description: "A couch is blocking the sidewalk.",
              needsAnswer: {
                key: "onsite",
                prompt: "Is this from your site?",
                options: [
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ],
              },
            },
          ],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("Blocking access");
    expect(cards[0]).toContain(`>${t("card.meta.new")}</span>`);
    expect(cards[0]).not.toContain("long-assessment-id");
  });

  it("renders task cards alongside unpaired condition questions", () => {
    const items = [
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          tasks: [
            {
              taskId: "task_1",
              conditionId: "condition_litter",
              category: "Litter",
              guidance: "File a 311 ticket.",
              kind: "escalation",
              buttons: ["File 311 ticket"],
            },
          ],
          conditions: [
            {
              conditionId: "condition_litter",
              category: "Litter",
              description: "Trash is visible.",
            },
            {
              conditionId: "condition_extra",
              category: "Dangerous animals",
              description: "Dogs are off-leash.",
              needsAnswer: {
                key: "affiliated",
                prompt: "Is this animal owned by a site client or resident?",
                options: [
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ],
              },
            },
          ],
        },
      },
    ];

    const cards = analysisCards(items[0], "check_1");

    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("Litter");
    expect(cards[1]).toContain("Dangerous animals");
    expect(cards[1]).toContain(
      "Is this animal owned by a site client or resident?",
    );
    expect(problemSummary(items)).toEqual({ visible: 2, hidden: 0 });
    expect(problemSummaryLabel(problemSummary(items))).toBe(
      t("analysis.summary.found", { count: 2 }),
    );
  });

  it("counts a visible unpaired condition after all task conditions are hidden", () => {
    const item = {
      id: "item_1",
      kind: "photo",
      placeName: "15th St",
      analysis: {
        status: "analyzed",
        rejectedConditionIds: ["condition_litter"],
        tasks: [
          {
            taskId: "task_1",
            conditionId: "condition_litter",
            category: "Litter",
            guidance: "File a 311 ticket.",
            kind: "escalation",
            buttons: ["File 311 ticket"],
          },
        ],
        conditions: [
          {
            conditionId: "condition_litter",
            category: "Litter",
            description: "Trash is visible.",
          },
          {
            conditionId: "condition_needles",
            category: "Needles",
            description: "A needle is visible.",
          },
        ],
      },
    };

    const cards = analysisCards(item, "check_1");

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("Needles");
    expect(problemSummary([item])).toEqual({ visible: 1, hidden: 1 });
    expect(problemSummaryLabel(problemSummary([item]))).toBe(
      t("analysis.summary.found", { count: 1 }),
    );
  });

  it("renders a clarifying question with its issue-specific condition title", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "Problem",
        analysis: {
          status: "analyzed",
          tasks: [],
          conditions: [
            {
              conditionId: "condition_animals",
              analyzerCategory: "Dangerous animals",
              canonicalCategory: "Aggressive animals",
              description: "Dogs are off-leash near traffic.",
              needsAnswer: {
                key: "affiliated",
                prompt: "Is this animal owned by a site client or resident?",
                options: [
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ],
              },
            },
          ],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("Dangerous animals");
    expect(cards[0]).toContain("Dogs are off-leash near traffic.");
    expect(cards[0]).toContain(
      "Is this animal owned by a site client or resident?",
    );
    expect(cards[0]).toContain('data-analysis-action="answer"');
    expect(cards[0]).toContain('data-answer-key="affiliated"');
    expect(cards[0]).not.toContain(t("card.title.fallback"));
  });

  it("uses analyzer category fields for condition-only cards", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "Problem",
        analysis: {
          status: "analyzed",
          tasks: [],
          conditions: [
            {
              conditionId: "condition_animals",
              analyzerCategory: "Dangerous animals",
              canonicalCategory: "Aggressive animals",
              description: "Dogs are off-leash near traffic.",
            },
          ],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("Dangerous animals");
    expect(cards[0]).not.toContain(t("card.title.fallback"));
  });

  it("renders the check-level clear result with an add-problem link", () => {
    const cards = analysisCards(
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          tasks: [],
          conditions: [],
        },
      },
      "check_1",
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(escapeHtml(t("card.clear.title")));
    const [sentence] = t("card.clear.copy").split("{link}");
    expect(cards[0]).toContain(escapeHtml(sentence.trim()));
    expect(cards[0]).toContain(escapeHtml(t("card.clear.addProblem")));
    expect(cards[0]).toContain('href="/problem"');
    expect(cards[0]).not.toContain('data-analysis-action="edit"');
    expect(cards[0]).not.toContain('data-analysis-action="delete"');
  });

  it("shows one clear card for multiple clear photos", () => {
    const clearItem = (id) => ({
      id,
      kind: "photo",
      analysis: { status: "analyzed", tasks: [], conditions: [] },
    });
    const markup = analysisResultsTray(
      [clearItem("photo_1"), clearItem("photo_2")],
      "check_1",
    );

    expect(markup.split(escapeHtml(t("card.clear.title"))).length - 1).toBe(1);
  });

  it("does not show a clear card after an issue is already in the stack", () => {
    const markup = analysisResultsTray(
      [
        {
          id: "issue_photo",
          analysis: {
            status: "analyzed",
            tasks: [
              {
                taskId: "task_1",
                conditionId: "condition_1",
                userFriendlyLabel: "Litter",
                guidance: "Pick it up.",
                kind: "action",
              },
            ],
            conditions: [],
          },
        },
        {
          id: "clear_photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
      ],
      "check_1",
    );

    expect(markup).not.toContain(escapeHtml(t("card.clear.title")));
    expect(markup).toContain("Litter");
  });

  it("waits for every item before showing the stack-level clear card", () => {
    const markup = analysisResultsTray(
      [
        {
          id: "pending_issue_photo",
          analysis: { status: "analyzing" },
        },
        {
          id: "clear_photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
      ],
      "check_1",
    );

    expect(markup).not.toContain(escapeHtml(t("card.clear.title")));
    expect(markup).toContain("analysis-card--pending");
  });
});

describe("pending progress cards", () => {
  it("uses the analyzing skeleton while upload and analysis are in flight", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        upload: { status: "uploading" },
        analysis: { status: "queued", stages: {} },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.recovery.uploading")));
    expect(card).toContain("15th St");
    expect(card).toContain("analysis-card__skeleton--route");
    expect(card).toContain("analysis-card__skeleton--button");
    expect(card).toContain("analysis-card__media--placeholder");
  });

  it("keeps the same stable skeleton once polling begins", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzing",
          stages: {
            uploaded: "2026-09-15T10:00:00Z",
            sent: "2026-09-15T10:00:02Z",
          },
        },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.pending.title")));
    expect(card).toContain("analysis-card__skeleton--wide");
    expect(card).toContain("analysis-card__skeleton--mid");
  });

  it("does not show photo stages on text items", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "text",
        text: "Litter by the door",
        analysis: { status: "queued", stages: {} },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.pending.title")));
    expect(card).toContain("analysis-card__media--text");
    expect(card).not.toContain("analysis-card__media--placeholder");
  });
});

describe("failed cards", () => {
  it("renders a failed item with a retry button instead of an endless skeleton", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        upload: { status: "uploaded", artifactId: "artifact_1" },
        analysis: {
          status: "failed",
          recovery: { state: "manual", attempts: 3 },
          artifactId: "artifact_1",
          error: "Analysis is taking longer than expected.",
          failure: {
            leg: "analyze",
            uploaded: true,
            enqueued: true,
            waitedMs: 180125,
          },
        },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.failed.analysisTitle")));
    expect(card).toContain(escapeHtml(t("common.retry")));
    expect(card).toContain('data-analysis-action="retry"');
    expect(card).toContain(
      escapeHtml(
        t("card.failed.waited", {
          duration: t("date.elapsed.minutes", { minutes: 3, seconds: 0 }),
        }),
      ),
    );
    expect(card).not.toContain("skeleton-line");
  });

  it("names the upload leg and offers remove for a failed, never-uploaded photo", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        upload: { status: "failed" },
        analysis: {
          status: "failed",
          recovery: { state: "manual", attempts: 3 },
          error: "Could not analyze this item.",
          failure: {
            leg: "upload",
            uploaded: false,
            enqueued: false,
            waitedMs: 900,
          },
        },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.failed.uploadTitle")));
    expect(card).toContain(escapeHtml(t("card.failed.reason.upload")));
    expect(card).toContain('data-analysis-action="delete-failed-item"');
    // The "Waited …" sentence minus its duration: must be absent under a second.
    const [waitedPrefix] = t("card.failed.waited", { duration: "\0" }).split(
      "\0",
    );
    expect(card).not.toContain(escapeHtml(waitedPrefix.trim()));
  });

  it("keeps an analyzer-side failure retryable with the same delete affordance", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "failed",
          recovery: { state: "manual", attempts: 3 },
          artifactId: "artifact_1",
          failure: {
            leg: "analyze",
            uploaded: true,
            enqueued: true,
            backendError: true,
            waitedMs: 4200,
          },
        },
      }),
      "check_1",
    )[0];

    expect(card).toContain(escapeHtml(t("card.failed.reason.analyzeBackend")));
    expect(card).toContain(
      escapeHtml(
        t("card.failed.waited", {
          duration: t("date.elapsed.seconds", { seconds: 4 }),
        }),
      ),
    );
    expect(card).toContain('data-analysis-action="retry"');
    expect(card).toContain('data-analysis-action="delete-failed-item"');
  });
});

describe("taskAnalysisCard", () => {
  it("uses the thumbnail on the card and the full media URL in the lightbox", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_photo",
        checkId: "check_photo",
        category: "Litter",
        thumbnailUrl: "https://cdn.example/thumb.jpg",
        mediaUrl: "https://cdn.example/full.jpg",
      },
      action: null,
      statusLabel: "Today",
    });

    expect(card).toContain('src="https://cdn.example/thumb.jpg"');
    expect(card).toContain('data-full-src="https://cdn.example/full.jpg"');
  });

  it("keeps action guidance visible while preserving the condition description for edits", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_1",
        checkId: "check_1",
        conditionId: "condition_litter",
        category: "Litter",
        description: "Trash is piled around the tree well.",
        guidance:
          "If there is too much trash for you to clean up, ask the City for help.",
        buttons: ["File 311 ticket"],
      },
      action: { label: "File 311 ticket", variant: "blue", kind: "file311" },
      statusLabel: "TODAY · 10:00AM",
      isNew: false,
    });

    expect(card).toContain(
      "If there is too much trash for you to clean up, ask the City for help.",
    );
    expect(card).toContain(
      'data-card-edit-description="Trash is piled around the tree well."',
    );
  });

  it("uses the blue primary treatment only for 311 escalation tasks", () => {
    const escalation = taskAnalysisCard({
      task: { taskId: "task_311", kind: "escalation", category: "Litter" },
      action: { label: "File 311 ticket", variant: "blue", kind: "file311" },
      statusLabel: "Today",
    });
    const phone = taskAnalysisCard({
      task: {
        taskId: "task_phone",
        kind: "non_actionable_escalation",
        category: "Safety",
      },
      action: { label: "I called 911", variant: "blue", kind: "done" },
      statusLabel: "Today",
    });

    expect(escalation).toContain("analysis-card__primary--escalation");
    expect(phone).not.toContain("analysis-card__primary--escalation");
  });

  it("supports a read-only details action without edit or delete controls", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_1",
        checkId: "check_1",
        conditionId: "condition_litter",
        category: "Litter",
        description: "Trash is piled around the tree well.",
        guidance: "Clean it up.",
        buttons: ["Cleaned it up"],
      },
      action: { label: "View details", variant: "outline", kind: "view311" },
      statusLabel: "YESTERDAY · 10:00AM",
      isNew: false,
      includeControls: false,
    });

    expect(card).toContain(t("card.viewUpdates"));
    expect(card).toContain('data-action="view311"');
    expect(card).toContain("analysis-card__updates");
    expect(card).not.toContain('name="circle-check"');
    expect(card).toContain("analysis-card__media--placeholder");
    expect(card).toContain('name="image"');
    expect(card).not.toContain("analysis-card__media--text");
    expect(card).not.toContain('data-analysis-action="edit"');
    expect(card).not.toContain('data-analysis-action="delete"');
  });

  it("formats latest 311 update timestamps for card footers", () => {
    const now = new Date("2026-09-24T12:00:00-07:00");
    expect(updatedCardTime("2026-09-24T09:15:00-07:00", now)).toBe(
      "Updated today, 9:15 AM",
    );
    expect(updatedCardTime("2026-09-22T09:15:00-07:00", now)).toBe(
      "Updated Tuesday, 9:15 AM",
    );
    expect(updatedCardTime("2026-09-17T09:15:00-07:00", now)).toBe(
      "Updated 09/17/2026, 9:15 AM",
    );
  });

  it.each([
    ["Open", "", false, "filed"],
    ["Open", "", true, "overdue"],
    ["Closed", "8", false, "cityClosed"],
    ["Closed", "", false, "cityClosed"],
    ["On hold", "", false, "onHold"],
  ])(
    "renders one status ticker for %s",
    (ticketStatus, ticketClosedReason, ticketResponseOverdue, key) => {
      const card = taskAnalysisCard({
        task: {
          taskId: "task_311",
          status: "in_progress",
          kind: "escalation",
          ticketStatus,
          ticketClosedReason,
          ticketResponseOverdue,
          appActionResults: [
            {
              code: "create_311_ticket",
              payload: { tickets: [{ srNum: "123" }] },
            },
          ],
        },
        action: null,
        statusLabel: "",
      });
      expect(card).toContain(`data-status-ticker="${key}"`);
      expect(card).not.toContain("analysis-card__route-dot");
    },
  );

  it("omits an unverified 311 status", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_311",
        kind: "escalation",
        category: "Litter",
        ticketStatus: "",
      },
      action: { label: "View details", variant: "outline", kind: "view311" },
      statusLabel: "Today",
      includeControls: false,
    });

    expect(card).toContain(escapeHtml(t("card.ticker.needsAction")));
    expect(card).not.toContain("analysis-card__ticket-status");
  });
});

describe("evidence captions without a place name", () => {
  it("uses the photo's reverse-geocoded first address line before the site address", () => {
    const cards = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        dataUrl: "data:,",
        analysis: {
          status: "analyzing",
          georeferencedAddress: "640 Jones St, San Francisco, CA",
        },
      }),
      "check_1",
      { siteAddress: "123 Main St, San Francisco, CA" },
    );

    expect(cards[0]).toContain("640 Jones St");
    expect(cards[0]).not.toContain("123 Main St");
    expect(cards[0]).not.toContain("San Francisco, CA");
  });

  it("falls back to the site's first address line when coordinates have no address", () => {
    const cards = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        dataUrl: "data:,",
        analysis: { status: "analyzing" },
      }),
      "check_1",
      { siteName: "Civic Center Annex", siteAddress: "123 Main St\nSuite 2" },
    );

    expect(cards[0]).toContain("123 Main St");
    expect(cards[0]).not.toContain("Suite 2");
  });

  it("shows the stored photo address on a hydrated home task", () => {
    const card = taskAnalysisCard({
      task: item({
        taskId: "task_1",
        category: "Litter",
        siteAddress: "123 Main St, San Francisco",
        evidence: {
          georeferencedAddress: "640 Jones St, San Francisco, CA",
        },
      }),
      action: null,
      statusLabel: "Existing",
      siteName: "Civic Center Annex",
    });

    expect(card).toContain("640 Jones St");
    expect(card).not.toContain("123 Main St");
  });

  it("retains a task-only identifier in current and historical card footers", () => {
    for (const isNew of [true, false]) {
      const card = taskAnalysisCard({
        task: item({ taskId: "task-only-123", category: "Litter" }),
        action: null,
        statusLabel: isNew ? "New" : "Existing",
        isNew,
      });
      expect(card).toContain("<span>task-only-123</span>");
    }
  });

  it("labels current items with the host's site name", () => {
    const cards = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        dataUrl: "data:,",
        analysis: { status: "analyzing" },
      }),
      "check_1",
      { siteName: "Civic Center Annex" },
    );

    expect(cards[0]).toContain("Civic Center Annex");
    expect(cards[0]).not.toContain("data-place-id");
  });

  it("keeps a legacy item's own place name", () => {
    const cards = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        dataUrl: "data:,",
        placeName: "North gate",
        analysis: { status: "analyzing" },
      }),
      "check_1",
      { siteName: "Civic Center Annex" },
    );

    expect(cards[0]).toContain("North gate");
    expect(cards[0]).not.toContain("Civic Center Annex");
  });

  it("never captions a task card with the fixed position descriptor", () => {
    const card = taskAnalysisCard({
      // Backend tasks may still carry the descriptor; the template ignores it.
      task: item({
        taskId: "task_1",
        category: "Litter",
        positionDescriptor: "perimeter",
      }),
      action: null,
      statusLabel: "Existing",
      siteName: "Civic Center Annex",
    });

    expect(card).toContain("Civic Center Annex");
    expect(card).not.toContain(">perimeter<");
  });
});

describe("card redesign", () => {
  it("uses the Spanish task-update translation for an ambiguous History status", async () => {
    await setLocale("es");
    try {
      const card = taskAnalysisCard({
        task: {
          taskId: "resolved",
          kind: "escalation",
          status: "completed",
          latestUpdateLabel: "Resolved",
        },
        history: true,
        action: null,
        statusLabel: "",
      });
      expect(card).toContain(t("card.ticker.resolved"));
      expect(card).not.toContain("Resuelta");
    } finally {
      await setLocale("en");
    }
  });

  it("renders the analyzer's localized label and in-progress description", async () => {
    await setLocale("es");
    try {
      const task = {
        taskId: "task_es",
        kind: "escalation",
        category: "Litter",
        status: "in_progress",
        userFriendlyLabel: "Trash blocking the sidewalk",
        guidance:
          "If there is too much trash for you to clean up, ask the City for help.",
        description: "English description",
        translations: {
          language: "es",
          user_friendly_label: "Basura que bloquea la acera",
          description: "Descripción en español",
        },
      };
      const card = taskAnalysisCard({
        task,
        action: null,
        statusLabel: "Today",
      });
      expect(card).toContain("<h3>Basura que bloquea la acera</h3>");
      expect(card).toContain("<p>Descripción en español</p>");
      // The visible description is localized; the canonical English stays on
      // the edit-target attribute the edit dialog seeds from.
      expect(card).toContain(
        'data-card-edit-description="English description"',
      );
      expect(card).not.toContain("<p>English description</p>");
      expect(card).not.toContain("Trash blocking the sidewalk");
    } finally {
      await setLocale("en");
    }
  });

  it("renders the active locale from a per-locale translations map", async () => {
    await setLocale("fil");
    try {
      const task = {
        taskId: "task_map",
        kind: "escalation",
        category: "Litter",
        status: "in_progress",
        userFriendlyLabel: "Trash blocking the sidewalk",
        guidance:
          "If there is too much trash for you to clean up, ask the City for help.",
        description: "English description",
        translations: {
          es: {
            user_friendly_label: "Basura que bloquea la acera",
            description: "Descripción en español",
          },
          fil: {
            user_friendly_label: "Basura na naghaharang ng bangketa",
            description: "Paglalarawan sa Filipino",
          },
        },
      };
      const card = taskAnalysisCard({
        task,
        action: null,
        statusLabel: "Today",
      });
      expect(card).toContain("<h3>Basura na naghaharang ng bangketa</h3>");
      expect(card).toContain("<p>Paglalarawan sa Filipino</p>");
      expect(card).not.toContain("Basura que bloquea la acera");
    } finally {
      await setLocale("en");
    }
  });

  it("keeps English analyzer text when the translations target another locale", async () => {
    await setLocale("es");
    try {
      const task = {
        taskId: "task_mismatch",
        kind: "escalation",
        category: "Litter",
        status: "in_progress",
        userFriendlyLabel: "Trash blocking the sidewalk",
        guidance:
          "If there is too much trash for you to clean up, ask the City for help.",
        description: "English description",
        translations: {
          language: "fil",
          user_friendly_label: "Basura na naghaharang ng bangketa",
          description: "Paglalarawan sa Filipino",
        },
      };
      const card = taskAnalysisCard({
        task,
        action: null,
        statusLabel: "Today",
      });
      expect(card).toContain("<h3>Trash blocking the sidewalk</h3>");
      expect(card).toContain("English description");
      expect(card).not.toContain("Basura na naghaharang ng bangketa");
    } finally {
      await setLocale("en");
    }
  });
  const task = {
    taskId: "task_1",
    ruleId: "LITTER-1",
    kind: "action",
    category: "Litter",
    buttons: ["We picked this up"],
    createdAt: "2026-10-01T12:00:00Z",
    completedAt: "2026-10-01T13:00:00Z",
  };
  it("shows the new rubric label on an existing to-do card with one edit target and an X", () => {
    const card = taskAnalysisCard({
      task,
      action: { kind: "done", label: "We picked this up" },
      statusLabel: "",
    });
    expect(card).toContain('role="checkbox"');
    expect(card).toContain('aria-checked="false"');
    expect(card).toContain("Pick up the litter");
    expect(card).not.toContain("We picked this up");
    expect(card).toContain('name="xmark"');
    expect(card).toContain(t("card.editDetails"));
  });
  it("retains a filing button for 311 escalations", () => {
    const card = taskAnalysisCard({
      task: { ...task, kind: "escalation" },
      action: { kind: "file311", label: "File 311 ticket" },
      statusLabel: "",
    });
    expect(card).toContain('data-action="file311"');
    expect(card).not.toContain('role="checkbox"');
  });
  it("renders history as a timeline row without editing controls or guidance", () => {
    const card = taskAnalysisCard({
      task: { ...task, status: "completed", guidance: "Guidance omitted" },
      history: true,
      action: null,
      statusLabel: "",
    });
    expect(card).toContain('data-action="update"');
    expect(card).toContain(t("card.history.hours", { count: 1 }));
    expect(card).not.toContain('data-analysis-action="edit"');
    expect(card).not.toContain('data-analysis-action="delete"');
    expect(card).not.toContain("Guidance omitted");
  });
});

describe("duplicate card presentation", () => {
  beforeEach(() =>
    setDuplicateUiSite({ featureFlags: { duplicateDetection: true } }),
  );
  afterEach(() => setDuplicateUiSite(null));
  it("shows duplicate progress in the ticker and silently falls back after completion or failure", () => {
    const task = {
      taskId: "duplicate-status-task",
      status: "open",
      category: "Litter",
      createdAt: new Date().toISOString(),
    };
    const checking = taskAnalysisCard({
      task: { ...task, duplicateCheckState: "pending" },
      action: null,
      statusLabel: "",
    });
    expect(checking).toContain(t("card.ticker.checking"));
    expect(checking).toContain("status-ticker__spinner");
    expect(checking.indexOf(t("card.ticker.checking"))).toBeLessThan(
      checking.indexOf(t("card.editDetails")),
    );
    const completed = taskAnalysisCard({
      task: { ...task, duplicateCheckState: "complete" },
      action: null,
      statusLabel: "",
    });
    expect(completed).toContain(t("card.ticker.needsAction"));
    expect(completed).not.toContain("<wa-spinner");
    const unavailable = taskAnalysisCard({
      task: { ...task, duplicateCheckState: "unavailable" },
      action: null,
      statusLabel: "",
    });
    expect(unavailable).not.toContain(t("duplicate.unavailable"));
    expect(unavailable).toContain(t("card.ticker.needsAction"));
    expect(unavailable).not.toContain("<wa-spinner");
    expect(unavailable).not.toContain(t("duplicate.noMatches"));
    const disabled = taskAnalysisCard({ task, action: null, statusLabel: "" });
    expect(disabled).not.toContain(t("duplicate.checking"));
    expect(disabled).not.toContain(t("duplicate.noMatches"));
  });

  it("links the earlier-issue phrase to the original worklist card", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "repeat",
        status: "open",
        category: "Graffiti",
        duplicate: { original: { taskId: "original-id" } },
      },
      action: null,
      statusLabel: "",
    });
    expect(card).toContain('href="/today?issue=original-id"');
    expect(card).toContain('data-original-task-id="original-id"');
    expect(card).toContain(t("duplicate.earlierIssue"));
    expect(card).not.toContain("{issue}");
  });

  it("hides persisted duplicate presentation and status when display is off", () => {
    setDuplicateUiSite(null);
    const card = taskAnalysisCard({
      task: {
        taskId: "repeat",
        status: "open",
        category: "Graffiti",
        duplicateCheckState: "pending",
        duplicate: { compact: true, original: { taskId: "original" } },
      },
      action: null,
      statusLabel: "",
    });
    expect(card).not.toContain("duplicate-card__body");
    expect(card).not.toContain("duplicate-earlier-link");
    expect(card).not.toContain(t("duplicate.checking"));
    expect(card).toContain(t("card.editDetails"));
  });
});

it.each([false, true])(
  "renders responsive phone controls with duplicate UI enabled=%s only for a phone action with an explicit number",
  (enabled) => {
    setDuplicateUiSite({ featureFlags: { duplicateDetection: enabled } });
    const task = {
      taskId: "phone",
      kind: "non_actionable_escalation",
      phoneNumber: "415-553-0123",
      policyVersion: "actions-escalations-v7",
      buttons: ["Call SFPD: 415-553-0123"],
      status: "open",
    };
    const render = (value) =>
      taskAnalysisCard({
        task: value,
        statusLabel: "",
        action: { kind: "done", label: t("common.done") },
      });
    const markup = render(task);
    expect(markup).toContain('data-phone-number="415-553-0123"');
    expect(markup).toContain("analysis-card__check--phone");
    expect(markup).toContain('role="checkbox"');
    expect(render({ ...task, phoneNumber: "" })).not.toContain(
      "data-phone-number",
    );
    expect(render({ ...task, kind: "action" })).not.toContain(
      "data-phone-number",
    );
    expect(render({ ...task, phoneNumber: '911" onclick="bad' })).not.toContain(
      "data-phone-number",
    );
    setDuplicateUiSite(null);
  },
);

it.each(["in_progress", "open", "completed"])(
  "shows permanent resolution only on in-progress cards (%s)",
  (status) => {
    const markup = taskAnalysisCard({
      task: { taskId: "test", status, label: "Test" },
      action: { kind: "update", label: "Updates" },
      statusLabel: "",
    });
    expect(markup.includes('data-action="mark-resolved"')).toBe(
      status === "in_progress",
    );
    if (status === "in_progress")
      expect(markup.indexOf('data-action="mark-resolved"')).toBeLessThan(
        markup.indexOf("analysis-card__updates"),
      );
  },
);

describe("waiting for connection", () => {
  it("shows a saved-offline card instead of a failure or progress", () => {
    const [markup] = analysisCards(
      {
        id: "item_offline",
        kind: "text",
        text: "Litter by the gate",
        placeName: "15th St",
        analysis: { status: "waiting" },
      },
      "check_1",
    );
    expect(markup).toContain("analysis-card--waiting");
    expect(markup).toContain(escapeHtml(t("card.waiting.title")));
    expect(markup).toContain(escapeHtml(t("notice.keepOpen")));
    expect(markup).not.toContain("analysis-card--failed");
    expect(markup).not.toContain("analysis-card--pending");
  });

  it("shows the photo saved on the device, not a placeholder", () => {
    const [markup] = analysisCards(
      {
        id: "item_offline_photo",
        kind: "photo",
        dataUrl: "data:image/jpeg;base64,AAAA",
        analysis: { status: "waiting" },
      },
      "check_1",
    );
    expect(markup).toContain("analysis-card--waiting");
    expect(markup).toContain("data:image/jpeg;base64,AAAA");
    expect(markup).not.toContain("analysis-card__media--placeholder");
  });
});

it("only claims saved on phone after a confirmed local write, including repeated online failures", () => {
  const photo = {
    id: "local",
    kind: "photo",
    dataUrl: "data:image/jpeg;base64,AAAA",
  };
  const [unconfirmed] = analysisCards(
    item({ ...photo, analysis: { status: "waiting" } }),
    "check",
  );
  expect(unconfirmed).not.toContain(escapeHtml(t("notice.savedOnPhone")));
  const [saved] = analysisCards(
    item({
      ...photo,
      analysis: {
        status: "failed",
        localSaveConfirmed: true,
        retryCount: 3,
        recovery: { state: "manual", attempts: 3 },
        failure: { leg: "analyze" },
      },
    }),
    "check",
  );
  expect(saved).not.toContain(escapeHtml(t("notice.savedOnPhone")));
  expect(saved).toContain(escapeHtml(t("card.failed.analysisTitle")));
  expect(saved).not.toContain(escapeHtml(t("notice.savedHelp")));
  expect(saved).toContain('data-analysis-action="retry"');
});
it.each([false, true])(
  "shows Add proof for either completion path and removes it after saving (%s)",
  (canBeInProgress) => {
    const task = {
      taskId: "proof",
      status: "completed",
      canBeInProgress,
      completionMethod: canBeInProgress ? "site_team_resolved" : "manual",
    };
    const render = (task) =>
      taskAnalysisCard({ task, action: null, statusLabel: "", history: true });
    expect(render(task)).toContain('data-action="add-proof"');
    expect(render(task)).toContain(t("taskUpdate.addProof"));
    expect(render({ ...task, proofAddedAt: "2026-10-28" })).not.toContain(
      'data-action="add-proof"',
    );
    expect(
      render({ ...task, status: "open", createdAt: "2020-01-01" }),
    ).not.toContain('data-action="add-proof"');
  },
);

it("identifies an unreadable photo, shows its evidence and allows deletion", () => {
  const markup = analysisCards(
    item({
      id: "failed-photo",
      kind: "photo",
      dataUrl: "data:image/png;base64,AA",
      analysis: {
        status: "failed",
        failure: { leg: "analyze", uploaded: true, code: "undecodable_input" },
        recovery: { state: "blocked" },
      },
    }),
    "check",
  ).join("");
  expect(markup).toContain(escapeHtml(t("card.failed.unreadableTitle")));
  expect(markup).toContain(escapeHtml(t("card.failed.unreadableBody")));
  expect(markup).toContain("artifact-photo");
  expect(markup).toContain('data-analysis-action="delete-failed-item"');
  expect(markup).not.toContain('data-analysis-action="retry"');
});

it("uses the existing saved design for persisted recovery while offline", () => {
  vi.stubGlobal("navigator", { onLine: false });
  const [markup] = analysisCards(
    item({
      id: "saved",
      kind: "photo",
      dataUrl: "data:image/png;base64,AA",
      analysis: {
        status: "waiting",
        localSaveConfirmed: true,
        recovery: { state: "waiting", stage: "upload" },
      },
    }),
    "check",
  );
  expect(markup).toContain("data:image/svg+xml,");
  expect(markup).not.toContain("/images/error-states/saved-photo.svg");
  expect(markup).toContain(escapeHtml(t("notice.savedOnPhone")));
  expect(markup).not.toContain('data-analysis-action="retry"');
  vi.unstubAllGlobals();
});

it("shows a clarification warning and the friendly issue title on question cards", () => {
  const [markup] = analysisCards(
    item({
      id: "photo",
      kind: "photo",
      analysis: {
        status: "analyzed",
        conditions: [
          {
            conditionId: "litter",
            category: "Technical category",
            userFriendlyLabel: "Trash on the sidewalk",
            needsAnswer: {
              key: "affiliated",
              prompt: "From this site?",
              options: [],
            },
          },
        ],
        tasks: [],
      },
    }),
    "check",
  );
  expect(markup).toContain("Trash on the sidewalk");
  expect(markup).not.toContain(t("card.title.moreDetails"));
  expect(markup).toContain(escapeHtml(t("card.ticker.needsClarification")));
  expect(markup).toContain("status-ticker--warning");
  expect(markup).toContain('name="circle-exclamation"');
});

it("offers one delete action despite contradictory upload flags and explains offline cleanup", () => {
  vi.stubGlobal("navigator", { onLine: false });
  try {
    const [markup] = analysisCards(
      item({
        id: "failed",
        kind: "photo",
        upload: { status: "uploaded", artifactId: "artifact" },
        analysis: {
          status: "failed",
          failure: { leg: "upload", uploaded: false },
          recovery: { state: "manual" },
        },
      }),
      "check",
    );
    expect(
      markup.match(/data-analysis-action="delete-failed-item"/g),
    ).toHaveLength(1);
    expect(markup).toContain(escapeHtml(t("card.failed.deleteOffline")));
    expect(markup).toMatch(
      /data-analysis-action="delete-failed-item"[^>]*disabled/,
    );
    expect(markup).not.toContain('data-analysis-action="remove-item"');
    expect(markup).not.toContain('data-analysis-action="retry"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reuses the existing uploading card for automatic upload retries", () => {
  const [markup] = analysisCards(
    item({
      kind: "photo",
      upload: { status: "uploading" },
      analysis: {
        status: "queued",
        recovery: { state: "working", stage: "upload", attempts: 1 },
      },
    }),
    "check",
  );
  expect(markup).toContain(escapeHtml(t("card.recovery.uploading")));
  expect(markup).toContain('class="ellipsis-dots" aria-hidden="true"');
});

it.each([false, true])(
  "keeps known photo evidence recoverable without a URL (readOnly=%s)",
  (readOnly) => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task",
        checkId: "check",
        sourceArtifactIds: ["photo"],
        evidence: { kind: "photo", artifactId: "photo" },
        mediaState: "retry",
      },
      action: null,
      statusLabel: "",
      readOnly,
    });
    expect(card).toContain("<artifact-photo");
    expect(card).toContain('data-artifact-id="photo"');
    expect(card).not.toContain('name="file-lines"');
  },
);
it("keeps true text evidence as a document", () => {
  const card = taskAnalysisCard({
    task: {
      taskId: "task",
      checkId: "check",
      evidence: { kind: "text", text: "Synthetic description" },
    },
    action: null,
    statusLabel: "",
  });
  expect(card).toContain('name="file-lines"');
  expect(card).not.toContain("<artifact-photo");
});

it("uses a neutral placeholder until source evidence type is known", () => {
  const card = taskAnalysisCard({
    task: { taskId: "task", checkId: "check", sourceArtifactIds: ["unknown"] },
    action: null,
    statusLabel: "",
  });
  expect(card).toContain('name="image"');
  expect(card).not.toContain('name="file-lines"');
});

it("keeps existing results visible and inert while registration is repaired", () => {
  const cards = analysisCards(
    {
      id: "restored",
      kind: "photo",
      analysis: {
        status: "queued",
        repairingRegistration: true,
        recovery: { state: "working" },
        tasks: [
          {
            taskId: "task",
            category: "Litter",
            label: "Pick up litter",
            userFriendlyLabel: "Litter near gate",
            guidance: "Pick up the litter",
            kind: "self",
          },
        ],
        conditions: [],
      },
    },
    "check",
  );
  expect(cards.join("")).toContain("Litter near gate");
  expect(cards.join("")).toContain('aria-busy="true" inert');
  expect(cards.join("")).not.toContain("analysis-card--pending");
});

it("renders single-issue clear results without the perimeter offer", () => {
  const evidence = item({
    id: "text",
    kind: "text",
    analysis: { status: "analyzed", tasks: [], conditions: [] },
  });
  const markup = analysisResultsTray([evidence], "report", {
    flowType: "single-problem",
  });
  expect(markup).toContain(escapeHtml(t("card.clearReport.title")));
  expect(markup).toContain(escapeHtml(t("card.clearReport.copy")));
  expect(markup).not.toContain('href="/problem"');
  expect(markup).not.toContain(escapeHtml(t("card.clear.title")));
  expect(analysisResultsTray([evidence], "check")).toContain(
    escapeHtml(t("card.clear.title")),
  );
});

it("distinguishes text, photo and unknown evidence in history", () => {
  const render = (evidence) =>
    taskAnalysisCard({
      task: { taskId: "history-task", status: "completed", evidence },
      history: true,
      action: null,
      statusLabel: "",
    });
  expect(render({ kind: "text" })).toContain('name="file-lines"');
  expect(render({ kind: "text" })).not.toContain('name="image"');
  expect(render(undefined)).toContain("history-card__unknown");
  expect(render({ kind: "photo", artifactId: "photo" })).not.toContain(
    "history-card__unknown",
  );
});
