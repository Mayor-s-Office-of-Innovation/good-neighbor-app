import { afterAll, afterEach, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";

vi.mock("../services/api.js", () => ({
  getComplaint: vi.fn(),
  getComplaintMediaUrl: vi.fn(),
}));
vi.mock("../router.js", () => ({
  currentRoute: vi.fn(),
  navigate: vi.fn(),
  setPopstateGuard: vi.fn(),
}));
const { getComplaint, getComplaintMediaUrl } = await import(
  "../services/api.js"
);
/** @type {any} */
let View;
vi.stubGlobal(
  "HTMLElement",
  class {
    innerHTML = "";
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
  },
);
vi.stubGlobal("customElements", {
  define: (_name, constructor) => {
    View = constructor;
  },
});
await import("./complaint-view.js");
afterEach(() => vi.clearAllMocks());
afterAll(() => vi.unstubAllGlobals());

it.each([{}, { what: "", where: "", when: "", notes: "" }])(
  "renders a ready complaint and its attachment with optional fields %j",
  async (optional) => {
    vi.mocked(getComplaint).mockResolvedValue({
      complaint: {
        label: "Noise complaint",
        detail: "Noise was reported.",
        status: "ready",
        createdAt: "2026-10-26T17:00:00Z",
        ...optional,
      },
      artifacts: [
        {
          artifactId: "evidence-1",
          contentType: "application/pdf",
          name: "evidence.pdf",
        },
      ],
    });
    const view = new View();
    await view._renderDetail("complaint-1");
    expect(getComplaint).toHaveBeenCalledWith("complaint-1");
    expect(view.innerHTML).toContain("Noise complaint");
    expect(view.innerHTML).toContain("Noise was reported.");
    expect(view.innerHTML).toContain('data-media="evidence-1"');
    expect(view.innerHTML).toContain("evidence.pdf");
    expect(view.innerHTML).not.toContain(t("complaints.detailError"));
    expect(view.innerHTML).not.toContain("undefined");
  },
);

it("shows an image attachment as a thumbnail that opens the original", async () => {
  vi.mocked(getComplaint).mockResolvedValue({
    complaint: {
      label: "Noise complaint",
      status: "ready",
      createdAt: "2026-10-26T17:00:00Z",
    },
    artifacts: [
      { artifactId: "photo-1", contentType: "image/jpeg", name: "photo.jpg" },
    ],
  });
  vi.mocked(getComplaintMediaUrl).mockResolvedValue({
    downloadUrl: "https://s3.test/original",
    thumbnailUrl: "https://s3.test/original.thumb.webp",
  });
  const img = { addEventListener: vi.fn() };
  const tile = {
    dataset: { image: "photo-1" },
    innerHTML: "",
    querySelector: () => img,
  };
  const view = new View();
  view.querySelectorAll = (/** @type {string} */ selector) =>
    selector === "[data-image]" ? [tile] : [];
  await view._renderDetail("complaint-1");
  expect(getComplaintMediaUrl).toHaveBeenCalledWith("complaint-1", "photo-1");
  expect(tile.innerHTML).toContain("data-photo-lightbox");
  expect(tile.innerHTML).toContain('data-full-src="https://s3.test/original"');
  expect(tile.innerHTML).toContain('src="https://s3.test/original.thumb.webp"');
  expect(img.addEventListener).toHaveBeenCalledWith(
    "error",
    expect.any(Function),
  );
});
