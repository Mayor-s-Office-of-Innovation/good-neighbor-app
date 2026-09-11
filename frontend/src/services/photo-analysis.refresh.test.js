import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({
  evaluateAssessment: vi.fn(),
  getAssessmentGuidance: vi.fn(),
  submitConditionAnswers: vi.fn(),
}));
vi.mock("../state/check-session.js", () => ({
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
        activePlaceIndex: 0,
        placeOrder: ["sidewalk"],
        status: "in-progress",
        places: {
          sidewalk: {
            id: "sidewalk",
            name: "Sidewalk",
            skipped: false,
            description: null,
            items: [
              {
                id: "item",
                analysis: {
                  artifactId: "artifact",
                  assessment: { assessmentId: "previous" },
                },
              },
            ],
          },
        },
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
        "sidewalk",
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
          "sidewalk",
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
    places: {
      sidewalk: {
        items: [
          {
            id: "item",
            analysis: {
              artifactId: "artifact",
              assessment: { assessmentId: "previous" },
            },
          },
        ],
      },
    },
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
    await refreshEvidenceAnalysis("sidewalk", "item", response);
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
    await refreshEvidenceAnalysis("sidewalk", "item", response);
    expect(evaluateAssessment).toHaveBeenCalledTimes(1);
    expect(updateItemAnalysis).toHaveBeenCalledWith(
      "sidewalk",
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
    await expect(
      refreshEvidenceAnalysis("sidewalk", "item", response),
    ).rejects.toBe(conflict);
    expect(evaluateAssessment).toHaveBeenCalledTimes(3);
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });

  it("does not retry unrelated failures", async () => {
    vi.mocked(evaluateAssessment).mockRejectedValue(new Error("offline"));
    await expect(
      refreshEvidenceAnalysis("sidewalk", "item", response),
    ).rejects.toThrow("offline");
    expect(evaluateAssessment).toHaveBeenCalledTimes(1);
    expect(getAssessmentGuidance).not.toHaveBeenCalled();
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });
});

it("does not let a delayed answer restore a replaced assessment", async () => {
  const check = {
    id: "check",
    places: {
      sidewalk: {
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
      },
    },
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
    "sidewalk",
    "item",
    "couch",
    "provider_generated",
    true,
  );
  check.places.sidewalk.items[0].analysis.assessment = { assessmentId: "new" };
  finish();
  await pending;
  expect(updateItemAnalysis).not.toHaveBeenCalled();
});
