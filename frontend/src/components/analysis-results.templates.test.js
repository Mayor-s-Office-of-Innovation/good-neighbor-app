import { describe, expect, it } from "vitest";

import {
  analysisCards,
  problemSummary,
  problemSummaryLabel,
  taskAnalysisCard,
} from "./analysis-results.templates.js";

/** Fixture helper — test items only need the fields the templates read. */
const item = (fields) => /** @type {any} */ (fields);

describe("analysis result summaries", () => {
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

  it("keeps no-issue cards editable without offering delete", () => {
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
    expect(cards[0]).toContain("No issues found");
    expect(cards[0]).toContain('data-analysis-action="edit"');
    expect(cards[0]).not.toContain('data-analysis-action="delete"');
  });
});

describe("pending progress cards", () => {
  it("shows upload progress before the analyzer is involved", () => {
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

    expect(card).toContain("Uploading photo...");
    expect(card).not.toContain("Waiting for results");
    // Upload stage not reached yet, analyzer stage dimmed.
    expect(card).toContain('class="analysis-card__stage ');
    expect(card).toContain('class="visually-hidden">In progress. </span>');
  });

  it("shows the uploaded + sent checkpoints and an elapsed timer once polling", () => {
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

    expect(card).toContain("Photo uploaded");
    expect(card).toContain("Sent to analyzer");
    expect(card).toContain("Waiting for results");
    expect(card).toContain('data-elapsed-since="2026-09-15T10:00:02Z"');
    // Stage state is in text for screen readers, not only the glyph — both
    // stages have stamps here, so both read "Done."
    expect(card).toContain('class="visually-hidden">Done. </span>');
    expect(card).not.toContain("In progress. </span>");
    expect(card).not.toContain("skeleton-line");
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

    expect(card).toContain("Analyzing description...");
    expect(card).not.toContain("Photo uploaded");
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

  it("omits action, edit, and delete controls for read-only task cards", () => {
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
      action: { label: "Cleaned it up", variant: "ink", kind: "done" },
      statusLabel: "YESTERDAY · 10:00AM",
      isNew: false,
      includeControls: false,
    });

    expect(card).not.toContain("Cleaned it up</button>");
    expect(card).not.toContain('data-analysis-action="edit"');
    expect(card).not.toContain('data-analysis-action="delete"');
  });
});
