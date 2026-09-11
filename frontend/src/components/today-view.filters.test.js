import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null }));
vi.mock("../db.js", () => ({ getSite: async () => ({ siteId: "site-1" }) }));
vi.mock("../services/api.js", () => ({
  listChecks: async () => ({ checks: [] }),
  listTasks: async () => ({ tasks: [] }),
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => session.current,
  hasDraft: async () => Boolean(session.current),
  loadSubmitted: async () => null,
  onCheckSessionChange: () => () => {},
}));

let TodayView;
beforeAll(async () => {
  vi.stubGlobal(
    "HTMLElement",
    class {
      addEventListener() {}
      removeEventListener() {}
    },
  );
  vi.stubGlobal("window", {
    addEventListener() {},
    clearTimeout() {},
    location: {},
  });
  vi.stubGlobal("document", { addEventListener() {} });
  vi.stubGlobal("customElements", {
    define: (name, component) => {
      if (name === "today-view") TodayView = component;
    },
  });
  await import("./today-view.js");
});
afterEach(() => {
  session.current = null;
});

async function mount(search) {
  window.location.search = search;
  const view = new TodayView();
  view._renderHome = vi.fn();
  view._hydrateVisibleHomeTasks = vi.fn();
  await view.connectedCallback();
  return view;
}

describe("worklist URL initialization", () => {
  it.each(["needs_action", "in_progress", "resolved", "archived"])(
    "restores %s on remount without reopening or discarding an active draft",
    async (filter) => {
      const draft = {
        id: "draft-1",
        status: "in-progress",
        flowType: "perimeter",
      };
      session.current = draft;
      for (let remount = 0; remount < 2; remount++) {
        const view = await mount(`?filter=${filter}`);
        expect(view._homeFilter).toBe(filter);
        expect(view._viewPhase).toBe("home");
        expect(view._renderHome).toHaveBeenCalledWith(
          expect.objectContaining({ captureSession: null }),
        );
        expect(session.current).toBe(draft);
        view.disconnectedCallback();
      }
    },
  );
  it.each(["", "?filter=unknown"])("defaults safely for %s", async (search) => {
    const view = await mount(search);
    expect(view._homeFilter).toBe("needs_action");
    view.disconnectedCallback();
  });
  it("still resumes capture when no recognized worklist filter was requested", async () => {
    session.current = {
      id: "draft-1",
      status: "in-progress",
      flowType: "perimeter",
    };
    const view = await mount("?filter=unknown");
    expect(view._viewPhase).toBe("capture");
    view.disconnectedCallback();
  });
});
