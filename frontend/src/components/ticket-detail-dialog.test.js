import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Node environment (no DOM): the element's pure detail builder is covered
  here; the <dialog> wiring is thin glue around it.
*/

beforeEach(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildTicketDetail", () => {
  it("prefers the task's own label and description over the request's", async () => {
    const { buildTicketDetail } = await import("./ticket-detail-dialog.js");
    const detail = buildTicketDetail(
      {
        userFriendlyLabel: "Trash in tree well",
        description: "Card text",
        mediaUrl: "https://cdn.example/photo.jpg",
      },
      { name: "Alpha" },
      { problemType: "Litter", description: "311 text", status: "Open" },
    );
    expect(detail.title).toBe("Trash in tree well");
    expect(detail.description).toBe("Card text");
    expect(detail.status).toBe("Open");
    expect(detail.mediaUrl).toBe("https://cdn.example/photo.jpg");
  });

  it("uses the analyzer translations matching the active locale", async () => {
    vi.resetModules();
    vi.doMock("../i18n/locale.js", async (importOriginal) => ({
      ...(await importOriginal()),
      getLocale: () => "es",
    }));
    const { buildTicketDetail } = await import("./ticket-detail-dialog.js");
    const detail = buildTicketDetail(
      {
        userFriendlyLabel: "Trash in tree well",
        description: "Card text",
        translations: {
          language: "es",
          user_friendly_label: "Basura en el pozo del árbol",
          description: "Texto de tarjeta",
        },
      },
      {},
      { problemType: "Litter", description: "311 text" },
    );
    expect(detail.title).toBe("Basura en el pozo del árbol");
    expect(detail.description).toBe("Texto de tarjeta");
    vi.doUnmock("../i18n/locale.js");
  });

  it("reads the per-locale translations map for the active locale", async () => {
    vi.resetModules();
    vi.doMock("../i18n/locale.js", async (importOriginal) => ({
      ...(await importOriginal()),
      getLocale: () => "vi",
    }));
    const { buildTicketDetail } = await import("./ticket-detail-dialog.js");
    const detail = buildTicketDetail(
      {
        userFriendlyLabel: "Trash in tree well",
        description: "Card text",
        translations: {
          es: { user_friendly_label: "Basura", description: "Texto" },
          vi: { user_friendly_label: "Rác trong hố cây" },
        },
      },
      {},
      { problemType: "Litter", description: "311 text" },
    );
    expect(detail.title).toBe("Rác trong hố cây");
    // No Vietnamese description yet: the English card text stays.
    expect(detail.description).toBe("Card text");
    vi.doUnmock("../i18n/locale.js");
  });

  it("ignores analyzer translations for a different locale", async () => {
    vi.resetModules();
    vi.doMock("../i18n/locale.js", async (importOriginal) => ({
      ...(await importOriginal()),
      getLocale: () => "en",
    }));
    const { buildTicketDetail } = await import("./ticket-detail-dialog.js");
    const detail = buildTicketDetail(
      {
        userFriendlyLabel: "Trash in tree well",
        description: "Card text",
        translations: {
          language: "es",
          user_friendly_label: "Basura en el pozo del árbol",
          description: "Texto de tarjeta",
        },
      },
      {},
      { problemType: "Litter" },
    );
    expect(detail.title).toBe("Trash in tree well");
    expect(detail.description).toBe("Card text");
    vi.doUnmock("../i18n/locale.js");
  });

  it("falls back to the request's problem type and description", async () => {
    const { buildTicketDetail } = await import("./ticket-detail-dialog.js");
    const detail = buildTicketDetail(
      {},
      {},
      { problemType: "Graffiti", description: "Tagged wall" },
    );
    expect(detail.title).toBe("Graffiti");
    expect(detail.description).toBe("Tagged wall");
    expect(typeof detail.location).toBe("string");
  });
});

describe("ticket evidence hydration", () => {
  it("defers a dialog rerender until an open photo lightbox closes", async () => {
    const listeners = new Map();
    vi.stubGlobal("document", {
      querySelector: vi.fn().mockReturnValueOnce({}).mockReturnValue(null),
      addEventListener: vi.fn((type, listener) =>
        listeners.set(type, listener),
      ),
    });
    const { TicketDetailDialog } = await import("./ticket-detail-dialog.js");
    const dialog = new TicketDetailDialog();
    dialog._task = { taskId: "task-1", mediaUrl: "old.jpg" };
    dialog._detail = { mediaUrl: "old.jpg" };
    Object.defineProperty(dialog, "isConnected", { value: true });
    dialog._render = vi.fn();

    dialog.updateTask({ taskId: "task-1", mediaUrl: "new.jpg" });

    expect(dialog._detail.mediaUrl).toBe("old.jpg");
    expect(dialog._render).not.toHaveBeenCalled();
    listeners.get("photolightboxclosed")();
    expect(dialog._detail.mediaUrl).toBe("new.jpg");
    expect(dialog._render).toHaveBeenCalledOnce();
  });
});

describe("311 issue updates", () => {
  it("loads saved documentation, hydrates photos, and appends older pages", async () => {
    vi.resetModules();
    const task = {
      taskId: "t1",
      checkId: "c1",
      status: "in_progress",
      appActionResults: [
        { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
      ],
    };
    const getTaskUpdates = vi
      .fn()
      .mockResolvedValueOnce({
        task,
        updates: [
          {
            type: "note_photo_update",
            notes: ["Saved note"],
            photoKeys: ["p1"],
          },
          { type: "311_ticket_filed" },
        ],
        nextToken: "older",
      })
      .mockResolvedValueOnce({
        task: { ...task, status: "completed" },
        updates: [{ type: "additional_action", text: "Earlier action" }],
      });
    const getMediaUrl = vi.fn().mockResolvedValue({ downloadUrl: "photo.jpg" });
    vi.doMock("../services/api.js", () => ({
      get311RequestDetail: vi
        .fn()
        .mockResolvedValue({ request: { status: "Open", events: [] } }),
      getTaskUpdates,
      getMediaUrl,
    }));
    try {
      const { TicketDetailDialog } = await import("./ticket-detail-dialog.js");
      const dialog = new TicketDetailDialog();
      dialog._render = vi.fn();
      await dialog.open(task);
      expect(dialog._detail.updates).toHaveLength(1);
      expect(dialog._detail.mediaUrls.get("p1")).toBe("photo.jpg");
      expect(dialog._detail.nextToken).toBe("older");
      await dialog._load("older");
      expect(getTaskUpdates).toHaveBeenLastCalledWith("t1", "older");
      expect(dialog._detail.updates.map((update) => update.type)).toEqual([
        "note_photo_update",
        "additional_action",
      ]);
      expect(dialog._detail.task.status).toBe("completed");
      expect(dialog._detail.nextToken).toBeUndefined();
    } finally {
      vi.doUnmock("../services/api.js");
    }
  });
});
