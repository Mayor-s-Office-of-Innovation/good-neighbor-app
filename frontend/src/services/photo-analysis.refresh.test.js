import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  evaluateAssessment: vi.fn(),
  getAssessmentGuidance: vi.fn(),
  submitConditionAnswers: vi.fn(),
}));
vi.mock("../state/check-session.js", () => ({
  findCheckForItem: vi.fn(() => null),
  getCheck: vi.fn(() => null),
  getCurrentCheck: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import {
  evaluateAssessment,
  getAssessmentGuidance,
  submitConditionAnswers,
} from "./api.js";
import { getCurrentCheck, updateItemAnalysis } from "../state/check-session.js";
import {
  refreshEvidenceAnalysis,
  refreshRecoveredQuestion,
  answerAnalysisQuestion,
} from "./photo-analysis.js";

beforeEach(() => vi.resetAllMocks());

describe("refresh after a delayed deletion", () => {
  it.each([false, true])(
    "only updates the originating session (navigated to another check: %s)",
    async (navigated) => {
      const check = {
        id: "original-check",
        siteId: "site",
        flowType: "perimeter",
        window: "morning",
        startedAt: "2026-09-11T10:00:00Z",
        status: "in-progress",
        items: [
          {
            id: "item",
            analysis: {
              artifactId: "artifact",
              assessment: { assessmentId: "previous" },
            },
          },
        ],
      };
      vi.mocked(getCurrentCheck).mockReturnValue(check);
      let finish = () => {};
      vi.mocked(evaluateAssessment).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({ assessment: {}, conditions: [], tasks: [] });
          }),
      );
      const refresh = refreshEvidenceAnalysis(
        "item",
        {
          assessment: {
            identified_conditions_of_concern: [
              { condition_id: "remaining", category: "Litter", severity: 1 },
            ],
          },
        },
        { rejectedConditionId: "deleted" },
      );
      expect(evaluateAssessment).toHaveBeenCalledWith(
        expect.objectContaining({ previousAssessmentId: "previous" }),
      );
      if (navigated)
        vi.mocked(getCurrentCheck).mockReturnValue({
          ...check,
          id: "another-check",
        });
      finish();
      await refresh;
      if (navigated) expect(updateItemAnalysis).not.toHaveBeenCalled();
      else
        expect(updateItemAnalysis).toHaveBeenCalledWith(
          "item",
          expect.objectContaining({ rejectedConditionIds: ["deleted"] }),
        );
    },
  );
});

describe("refresh conflict reconciliation", () => {
  const response = { assessment: { identified_conditions_of_concern: [] } };
  const check = {
    id: "check",
    items: [
      {
        id: "item",
        analysis: {
          artifactId: "artifact",
          assessment: { assessmentId: "previous" },
        },
      },
    ],
  };
  const conflict = Object.assign(new Error("conflict"), {
    status: 409,
    body: { code: "AssessmentRevisionConflict" },
  });
  beforeEach(() =>
    vi.mocked(getCurrentCheck).mockReturnValue(/** @type {any} */ (check)),
  );

  it("evaluates empty results and retries an answer conflict without repeating the amendment", async () => {
    vi.mocked(evaluateAssessment)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        assessment: { assessmentId: "next" },
        conditions: [],
        tasks: [],
      });
    vi.mocked(getAssessmentGuidance).mockResolvedValue({
      assessment: { assessmentId: "previous" },
      conditions: [],
      tasks: [],
    });
    await refreshEvidenceAnalysis("item", response);
    expect(evaluateAssessment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(evaluateAssessment).mock.calls[0][0]).toEqual(
      vi.mocked(evaluateAssessment).mock.calls[1][0],
    );
    expect(updateItemAnalysis).toHaveBeenCalledTimes(1);
  });

  it("uses a winning successor's persisted analysis without replaying stale edits", async () => {
    vi.mocked(evaluateAssessment).mockRejectedValueOnce(conflict);
    const latest = {
      assessment: {
        assessmentId: "newer",
        rawAssessment: {
          grade: "Good",
          concerns: [{ category: "Newer finding" }],
        },
      },
      conditions: [],
      tasks: [{ taskId: "kept" }],
    };
    vi.mocked(getAssessmentGuidance).mockResolvedValue(latest);
    await refreshEvidenceAnalysis("item", response);
    expect(evaluateAssessment).toHaveBeenCalledTimes(1);
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      "item",
      expect.objectContaining({
        assessment: latest.assessment,
        tasks: latest.tasks,
        sourceAnalysis: expect.objectContaining({
          concerns: latest.assessment.rawAssessment.concerns,
        }),
      }),
    );
  });

  it("bounds retries and leaves local guidance untouched on exhaustion", async () => {
    vi.mocked(evaluateAssessment).mockRejectedValue(conflict);
    vi.mocked(getAssessmentGuidance).mockResolvedValue({
      assessment: { assessmentId: "previous" },
      conditions: [],
      tasks: [],
    });
    await expect(refreshEvidenceAnalysis("item", response)).rejects.toBe(
      conflict,
    );
    expect(evaluateAssessment).toHaveBeenCalledTimes(3);
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });

  it("does not retry unrelated failures", async () => {
    vi.mocked(evaluateAssessment).mockRejectedValue(new Error("offline"));
    await expect(refreshEvidenceAnalysis("item", response)).rejects.toThrow(
      "offline",
    );
    expect(evaluateAssessment).toHaveBeenCalledTimes(1);
    expect(getAssessmentGuidance).not.toHaveBeenCalled();
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });

  it("retains backend assessment coordinates when the local item has none", async () => {
    vi.mocked(evaluateAssessment).mockResolvedValue({
      assessment: { assessmentId: "next" },
      conditions: [],
      tasks: [],
    });
    const responseWithLocation = {
      assessment: {
        metadata: {
          reported_at: "2026-09-15T10:00:00Z",
          latitude: 37.7793,
          longitude: -122.4192,
        },
        identified_conditions_of_concern: [
          {
            category: "Litter",
            severity: 3,
            user_friendly_label: "Lots of trash in tree well",
          },
        ],
      },
    };

    await refreshEvidenceAnalysis("item", responseWithLocation);

    expect(evaluateAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        assessment: {
          metadata: expect.objectContaining({
            latitude: 37.7793,
            longitude: -122.4192,
          }),
        },
        conditions: [
          expect.objectContaining({
            category: "Litter",
            userFriendlyLabel: "Lots of trash in tree well",
          }),
        ],
      }),
    );
  });

  it("drops the analyzer's 0,0 placeholder coordinates", async () => {
    vi.mocked(evaluateAssessment).mockResolvedValue({
      assessment: { assessmentId: "next" },
      conditions: [],
      tasks: [],
    });

    await refreshEvidenceAnalysis("item", {
      assessment: {
        metadata: { latitude: 0, longitude: 0 },
        identified_conditions_of_concern: [{ category: "Litter", severity: 3 }],
      },
    });

    expect(vi.mocked(evaluateAssessment).mock.calls[0][0]).not.toHaveProperty(
      "assessment",
    );
  });
});

it("does not let a delayed answer restore a replaced assessment", async () => {
  const check = {
    id: "check",
    items: [
      {
        id: "item",
        analysis: {
          assessment: { assessmentId: "old" },
          conditions: [],
          tasks: [],
        },
      },
    ],
  };
  vi.mocked(getCurrentCheck).mockReturnValue(/** @type {any} */ (check));
  let finish = () => {};
  vi.mocked(submitConditionAnswers).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            assessmentItem: { assessmentId: "old", assessmentRevision: 1 },
            conditionItem: null,
            taskItem: null,
            evaluation: null,
          });
      }),
  );
  const pending = answerAnalysisQuestion(
    "item",
    "couch",
    "provider_generated",
    true,
  );
  check.items[0].analysis.assessment = { assessmentId: "new" };
  finish();
  await pending;
  expect(updateItemAnalysis).not.toHaveBeenCalled();
});

it("publishes an edited recovered question without a local session", async () => {
  vi.mocked(evaluateAssessment).mockResolvedValue({
    assessment: {},
    conditions: [],
    tasks: [],
  });
  await refreshRecoveredQuestion(
    {
      checkId: "original-check",
      analysis: {
        artifactId: "original-artifact",
        assessment: { assessmentId: "previous" },
      },
    },
    {
      analysis_id: "amended-analysis",
      assessment: {
        identified_conditions_of_concern: [
          { condition_id: "remaining", category: "Litter", severity: 1 },
        ],
      },
    },
  );
  expect(evaluateAssessment).toHaveBeenCalledWith(
    expect.objectContaining({
      checkId: "original-check",
      previousAssessmentId: "previous",
    }),
  );
  expect(updateItemAnalysis).not.toHaveBeenCalled();
});

const recovered = {
  checkId: "check",
  analysis: {
    artifactId: "artifact",
    assessment: { assessmentId: "previous" },
    conditions: [{ source: { latitude: 37.76, longitude: -122.42 } }],
  },
};
const amendment = {
  analysis_id: "amended",
  assessment: {
    identified_conditions_of_concern: [{ category: "Litter", severity: 1 }],
  },
};
const conflict = { status: 409, body: { code: "AssessmentRevisionConflict" } };
const published = {
  assessment: { assessmentId: "published" },
  conditions: [],
  tasks: [],
};

it.each([false, true])(
  "preserves recovered coordinates, preferring amended coordinates when supplied: %s",
  async (amendedLocation) => {
    vi.mocked(evaluateAssessment).mockResolvedValue(published);
    const metadata = { latitude: 37.78, longitude: -122.44 };
    await refreshRecoveredQuestion(recovered, {
      ...amendment,
      assessment: {
        ...amendment.assessment,
        ...(amendedLocation ? { metadata } : {}),
      },
    });
    expect(vi.mocked(evaluateAssessment).mock.calls[0][0]).toMatchObject({
      assessment: {
        metadata: amendedLocation
          ? metadata
          : recovered.analysis.conditions[0].source,
      },
    });
  },
);
it("retries a recovered amendment after an answer conflict using one stable assessment ID", async () => {
  vi.mocked(evaluateAssessment)
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce(published);
  vi.mocked(getAssessmentGuidance).mockResolvedValue({
    assessment: { assessmentId: "previous" },
    conditions: [],
    tasks: [],
  });
  expect(await refreshRecoveredQuestion(recovered, amendment)).toEqual(
    published,
  );
  const calls = vi.mocked(evaluateAssessment).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][0]).toEqual(calls[1][0]);
});
it("adopts a winning recovered-edit successor without replaying the old amendment", async () => {
  vi.mocked(evaluateAssessment).mockRejectedValueOnce(conflict);
  vi.mocked(getAssessmentGuidance).mockResolvedValue(published);
  expect(await refreshRecoveredQuestion(recovered, amendment)).toEqual(
    published,
  );
  expect(evaluateAssessment).toHaveBeenCalledOnce();
});
it("bounds recovered-edit conflict retries", async () => {
  vi.mocked(evaluateAssessment).mockRejectedValue(conflict);
  vi.mocked(getAssessmentGuidance).mockResolvedValue({
    assessment: { assessmentId: "previous" },
    conditions: [],
    tasks: [],
  });
  await expect(refreshRecoveredQuestion(recovered, amendment)).rejects.toEqual(
    conflict,
  );
  expect(evaluateAssessment).toHaveBeenCalledTimes(3);
});

it("persists a no-task answer against validated successor guidance without losing sibling conditions", async () => {
  const check = {
    id: "check",
    items: [
      {
        id: "item",
        analysis: {
          assessment: { assessmentId: "old", assessmentRevision: 9 },
          conditions: [{ conditionId: "outdated" }],
          tasks: [],
        },
      },
    ],
  };
  vi.mocked(getCurrentCheck).mockReturnValue(/** @type {any} */ (check));
  const sibling = { conditionId: "sibling", status: "needs_answer" };
  const answered = {
    conditionId: "question",
    status: "completed",
    needsAnswer: null,
  };
  vi.mocked(submitConditionAnswers).mockResolvedValue({
    assessmentItem: { assessmentId: "current", assessmentRevision: 2 },
    conditionItem: answered,
    taskItem: null,
    evaluation: null,
  });
  await answerAnalysisQuestion("item", "question", "provider_generated", true, {
    assessment: { assessmentId: "current", assessmentRevision: 1 },
    conditions: [{ conditionId: "question", status: "needs_answer" }, sibling],
    tasks: [],
  });
  expect(submitConditionAnswers).toHaveBeenCalledWith("current", "question", {
    answers: { provider_generated: true },
  });
  expect(updateItemAnalysis).toHaveBeenCalledWith(
    "item",
    expect.objectContaining({
      assessment: { assessmentId: "current", assessmentRevision: 2 },
      conditions: [answered, sibling],
      tasks: [],
    }),
  );
});
