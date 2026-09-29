import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rejectAnalysisCondition: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  },
}));
const analysis = vi.hoisted(() => ({ refreshEvidenceAnalysis: vi.fn() }));
const session = vi.hoisted(() => ({ current: null }));
vi.mock("../services/api.js", () => api);
vi.mock("../services/photo-analysis.js", () => analysis);
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => session.current,
}));

const problem = {
  itemId: "item-1",
  checkId: "check-1",
  artifactId: "artifact-1",
  taskId: "task-1",
  conditionId: "condition-1",
  actionKind: "",
  title: "Litter",
  description: "",
};

function handlers() {
  return {
    requestId: "req-1",
    deleteLocally: vi.fn(),
    onRefreshFailure: vi.fn(),
  };
}

beforeEach(() => {
  api.rejectAnalysisCondition.mockReset();
  analysis.refreshEvidenceAnalysis.mockReset();
  session.current = { id: "check-1" };
});

describe("problemFromCard", () => {
  it("reads the data attributes with safe defaults", async () => {
    const { problemFromCard } = await import("./analysis-problem-actions.js");
    const attrs = { "data-item-id": "i", "data-condition-id": "c" };
    const card = { getAttribute: (name) => attrs[name] ?? null };
    expect(problemFromCard(/** @type {any} */ (card))).toEqual({
      itemId: "i",
      checkId: "",
      artifactId: "",
      taskId: "",
      conditionId: "c",
      actionKind: "",
      title: "problem",
      description: "",
    });
  });
});

describe("missingConditionMessage", () => {
  it("distinguishes no condition from missing coordinates", async () => {
    const { missingConditionMessage } = await import(
      "./analysis-problem-actions.js"
    );
    expect(missingConditionMessage({ conditionId: "" }, "deleted")).toMatch(
      /does not have a problem condition that can be deleted/,
    );
    expect(missingConditionMessage({ conditionId: "c" }, "edited")).toMatch(
      /cannot be edited\. Take a new photo/,
    );
  });
});

describe("rejectProblemCondition", () => {
  it("refreshes the item's analysis after a saved rejection", async () => {
    const { rejectProblemCondition } = await import(
      "./analysis-problem-actions.js"
    );
    const result = { assessment: { id: "a" } };
    api.rejectAnalysisCondition.mockResolvedValue(result);
    analysis.refreshEvidenceAnalysis.mockResolvedValue(undefined);
    const h = handlers();
    await rejectProblemCondition(problem, h);
    expect(api.rejectAnalysisCondition).toHaveBeenCalledWith(
      "check-1",
      "artifact-1",
      "condition-1",
      {
        reason: { key: "not_a_problem" },
        taskId: "task-1",
        caller: { request_id: "req-1" },
      },
    );
    expect(analysis.refreshEvidenceAnalysis).toHaveBeenCalledWith(
      "item-1",
      result,
      { rejectedConditionId: "condition-1" },
    );
    expect(h.deleteLocally).not.toHaveBeenCalled();
    expect(h.onRefreshFailure).not.toHaveBeenCalled();
  });

  it("hands a failed refresh to the caller", async () => {
    const { rejectProblemCondition } = await import(
      "./analysis-problem-actions.js"
    );
    api.rejectAnalysisCondition.mockResolvedValue({ assessment: {} });
    analysis.refreshEvidenceAnalysis.mockRejectedValue(new Error("nope"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = handlers();
    await rejectProblemCondition(problem, h);
    expect(h.onRefreshFailure).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("drops the card locally when the backend has no assessment", async () => {
    const { rejectProblemCondition } = await import(
      "./analysis-problem-actions.js"
    );
    api.rejectAnalysisCondition.mockResolvedValue({});
    const h = handlers();
    await rejectProblemCondition(problem, h);
    expect(h.deleteLocally).toHaveBeenCalledOnce();
    expect(analysis.refreshEvidenceAnalysis).not.toHaveBeenCalled();
  });

  it("treats a 404 as already deleted, only for the current check", async () => {
    const { rejectProblemCondition } = await import(
      "./analysis-problem-actions.js"
    );
    api.rejectAnalysisCondition.mockRejectedValue(new api.ApiError(404));
    let h = handlers();
    await rejectProblemCondition(problem, h);
    expect(h.deleteLocally).toHaveBeenCalledOnce();

    session.current = { id: "other-check" };
    h = handlers();
    await rejectProblemCondition(problem, h);
    expect(h.deleteLocally).not.toHaveBeenCalled();
  });

  it("rethrows other API errors", async () => {
    const { rejectProblemCondition } = await import(
      "./analysis-problem-actions.js"
    );
    api.rejectAnalysisCondition.mockRejectedValue(new api.ApiError(500));
    await expect(rejectProblemCondition(problem, handlers())).rejects.toThrow(
      "HTTP 500",
    );
  });
});
