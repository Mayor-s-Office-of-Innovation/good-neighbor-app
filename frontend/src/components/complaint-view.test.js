import { afterAll, afterEach, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";

vi.mock("../services/api.js", () => ({
  getComplaint: vi.fn(),
  presignComplaintArtifact: vi.fn(),
  putMediaWithProgress: vi.fn(),
  registerComplaintArtifact: vi.fn(),
}));
vi.mock("../services/upload-reservation.js", () => ({
  reserveMediaUpload: vi.fn(),
}));
vi.mock("../router.js", () => ({
  currentRoute: vi.fn(),
  navigate: vi.fn(),
  setPopstateGuard: vi.fn(),
}));
const {
  getComplaint,
  presignComplaintArtifact,
  putMediaWithProgress,
  registerComplaintArtifact,
} = await import("../services/api.js");
const { reserveMediaUpload } = await import(
  "../services/upload-reservation.js"
);
const { currentRoute } = await import("../router.js");
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

it("gives identical complaint attachments separate identities and uses effective MIME types", async () => {
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.mocked(currentRoute).mockReturnValue("/complaints/new");
  vi.mocked(reserveMediaUpload).mockImplementation(
    async (_scope, _file, presign) => presign("synthetic-request"),
  );
  vi.mocked(presignComplaintArtifact).mockResolvedValue({
    artifactId: "synthetic-artifact",
    s3Key: "synthetic-key",
    uploadUrl: "https://upload.example.test/a",
    uploadHeaders: {},
  });
  vi.mocked(putMediaWithProgress).mockResolvedValue(undefined);
  vi.mocked(registerComplaintArtifact).mockResolvedValue({});
  const view = new View();
  view._renderDraft = vi.fn();
  view.connectedCallback();
  const first = new File(["identical"], "first.txt");
  const second = new File(["identical"], "second.txt");
  await view._selectFiles([first, second]);
  const calls = vi.mocked(reserveMediaUpload).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][0]).not.toBe(calls[1][0]);
  expect(calls[0][3]).toEqual({ contentType: "text/plain" });
  expect(calls[1][3]).toEqual({ contentType: "text/plain" });
  expect(presignComplaintArtifact).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ contentType: "text/plain" }),
    expect.any(AbortSignal),
  );
  view.disconnectedCallback();
});
