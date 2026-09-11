import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({ evaluateAssessment: vi.fn() }));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import { evaluateAssessment } from "./api.js";
import { getCurrentCheck, updateItemAnalysis } from "../state/check-session.js";
import { refreshEvidenceAnalysis } from "./photo-analysis.js";

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
