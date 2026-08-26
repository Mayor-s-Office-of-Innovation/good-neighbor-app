import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: { pathname: "/today" },
  });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("customElements", {
    define: vi.fn(),
  });
});

describe("isStalePendingSession", () => {
  it("keeps a ready review session when the newest backend check is the same UI id", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "submitted" }, [
        { id: "chk_1", status: "submitted" },
      ]),
    ).toBe(false);
  });

  it("clears a ready review session when a newer backend check has replaced it", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "submitted" }, [
        { id: "chk_2", status: "submitted" },
      ]),
    ).toBe(true);
  });

  it("keeps an analyzing session once the same backend check is completed", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "analyzing" }, [
        { id: "chk_1", status: "submitted" },
      ]),
    ).toBe(false);
  });
});

describe("newestTasksFirst", () => {
  it("sorts task cards by most recent createdAt first", async () => {
    const { newestTasksFirst } = await import("./today-view.js");

    expect(
      newestTasksFirst([
        { taskId: "older", createdAt: "2026-08-20T10:00:00.000Z" },
        { taskId: "newest", createdAt: "2026-08-26T16:17:51.304Z" },
        { taskId: "middle", createdAt: "2026-08-25T12:00:00.000Z" },
      ]).map((task) => task.taskId),
    ).toEqual(["newest", "middle", "older"]);
  });
});
