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
