import { describe, expect, it } from "vitest";

import {
  analysisActionPriority,
  analysisCards,
  analysisResultsTray,
  historicalCheckTitle,
  problemSummary,
  problemSummaryLabel,
  sortAnalysisCards,
  taskAnalysisCard,
} from "./analysis-results.templates.js";

/** Fixture helper — test items only need the fields the templates read. */
const item = (fields) => /** @type {any} */ (fields);

describe("historical check titles", () => {
  const now = new Date(2026, 8, 23, 12, 0);

  it("shows the time for a superseded check from today", () => {
    expect(historicalCheckTitle(new Date(2026, 8, 23, 9, 5), now)).toBe(
      "From today's 9:05 AM check",
    );
  });

  it("uses yesterday for the prior calendar day", () => {
    expect(historicalCheckTitle(new Date(2026, 8, 22, 9, 0), now)).toBe(
      "From yesterday's check",
    );
  });

  it("uses the weekday within the current calendar week", () => {
    expect(historicalCheckTitle(new Date(2026, 8, 21, 9, 0), now)).toBe(
      "From Monday's check",
    );
  });

  it("uses a numeric date before the current calendar week", () => {
    expect(historicalCheckTitle(new Date(2026, 8, 14, 9, 0), now)).toBe(
      "From the check on 09/14/26",
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
    expect(cards[0]).toContain("NEW • GUB-STJ-001");
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
    expect(cards[0]).toContain("NEW • legacy-assessment-id");
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
    expect(cards[0]).toContain("More details needed");
    expect(cards[0]).toContain(">NEW</span>");
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
    expect(cards[1]).toContain("More details needed");
    expect(cards[1]).toContain(
      "Is this animal owned by a site client or resident?",
    );
    expect(problemSummary(items)).toEqual({ visible: 2, hidden: 0 });
    expect(problemSummaryLabel(problemSummary(items))).toBe("2 problems found");
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
    expect(problemSummaryLabel(problemSummary([item]))).toBe("1 problem found");
  });

  it("renders a clarifying question instead of a generic condition title", () => {
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
    expect(cards[0]).toContain("More details needed");
    expect(cards[0]).toContain("Dogs are off-leash near traffic.");
    expect(cards[0]).toContain(
      "Is this animal owned by a site client or resident?",
    );
    expect(cards[0]).not.toContain("Dangerous animals");
    expect(cards[0]).toContain('data-analysis-action="answer"');
    expect(cards[0]).toContain('data-answer-key="affiliated"');
    expect(cards[0]).not.toContain("Condition found");
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
    expect(cards[0]).not.toContain("Condition found");
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
    expect(cards[0]).toContain("Your check was clear!");
    expect(cards[0]).toContain(
      "We didn't identify any perimeter issues in this check.",
    );
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

    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);
  });

  it("removes the clear card as soon as any issue is present", () => {
    const markup = analysisResultsTray(
      [
        {
          id: "clear_photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
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
      ],
      "check_1",
    );

    expect(markup).not.toContain("Your check was clear!");
    expect(markup).toContain("Litter");
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

    expect(card).toContain("Analyzing...");
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

    expect(card).toContain("Analyzing...");
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

    expect(card).toContain("Analyzing...");
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

    expect(card).toContain("Analysis didn't finish");
    expect(card).toContain("Try again");
    expect(card).toContain('data-analysis-action="retry"');
    expect(card).toContain("Waited 3m 0s.");
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

    expect(card).toContain("Upload failed");
    expect(card).toContain("Check your connection and try again.");
    expect(card).toContain('data-analysis-action="remove-item"');
    expect(card).not.toContain("Waited");
  });

  it("keeps an analyzer-side failure retryable without the remove affordance", () => {
    const card = analysisCards(
      item({
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "failed",
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

    expect(card).toContain(
      "The analysis service couldn&#39;t process this one.",
    );
    expect(card).toContain("Waited 4s.");
    expect(card).toContain('data-analysis-action="retry"');
    expect(card).not.toContain('data-analysis-action="remove-item"');
  });
});

describe("taskAnalysisCard", () => {
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

    expect(card).toContain("View details");
    expect(card).toContain('data-action="view311"');
    expect(card).not.toContain('data-analysis-action="edit"');
    expect(card).not.toContain('data-analysis-action="delete"');
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
