import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";

vi.mock("../db.js", () => ({
  getSite: vi.fn(),
  listCareSubmissions: vi.fn(),
  deleteCareSubmission: vi.fn(),
}));
vi.mock("../services/api.js", () => ({
  listCareWork: vi.fn(),
  getCareWork: vi.fn(),
  getCarePhoto: vi.fn(),
}));
vi.mock("../services/care-submissions.js", () => ({
  enqueueCareSubmission: vi.fn(),
  retryCareSubmission: vi.fn(),
  recoverCareSubmissions: vi.fn(),
}));
import { listCareSubmissions, deleteCareSubmission } from "../db.js";
import { listCareWork } from "../services/api.js";
let CareWorkView;
beforeAll(async () => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("customElements", { define: vi.fn() });
  ({ CareWorkView } = await import("./care-work-view.js"));
});
afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  vi.mocked(listCareWork).mockResolvedValue({
    work: [
      {
        workId: "saved",
        kind: "power_washed",
        createdAt: "2026-10-27T12:00:00Z",
        photos: [],
      },
    ],
  });
  vi.mocked(listCareSubmissions).mockResolvedValue([]);
  vi.mocked(deleteCareSubmission).mockResolvedValue(undefined);
});
function view() {
  const result = new CareWorkView();
  result.isConnected = true;
  result._siteId = "site";
  result._bindList = vi.fn();
  result.querySelector = vi.fn(() => ({ addEventListener: vi.fn() }));
  result.insertAdjacentHTML = (_, html) => {
    result.innerHTML += html;
  };
  return result;
}
it("still loads saved logs and shows retry when both local reads fail", async () => {
  vi.mocked(listCareSubmissions).mockRejectedValue(
    new Error("storage unavailable"),
  );
  const component = view();
  await component._loadList();
  expect(listCareWork).toHaveBeenCalledOnce();
  expect(component.innerHTML).toContain('data-work="saved"');
  expect(component.innerHTML).toContain(t("care.queueLoadError"));
  expect(component.innerHTML).toContain("data-retry");
});
it("keeps the saved log visible when receipt cleanup fails", async () => {
  vi.mocked(listCareSubmissions).mockResolvedValue([
    {
      workId: "saved",
      status: "saved",
      work: {
        workId: "saved",
        kind: "power_washed",
        createdAt: "2026-10-27T12:00:00Z",
        photos: [],
      },
    },
  ]);
  vi.mocked(deleteCareSubmission).mockRejectedValue(
    new Error("cleanup failed"),
  );
  const component = view();
  await component._loadList();
  expect(component.innerHTML).toContain('data-work="saved"');
  expect(component.innerHTML).toContain(t("care.queueLoadError"));
});
it("clears the warning after storage recovers and retries", async () => {
  vi.mocked(listCareSubmissions).mockRejectedValueOnce(new Error("transient"));
  const component = view();
  await component._loadList();
  expect(component.innerHTML).toContain(t("care.queueLoadError"));
  await component._loadList();
  expect(component.innerHTML).not.toContain(t("care.queueLoadError"));
  expect(component.innerHTML).toContain('data-work="saved"');
});

it("reports both local queue and remote failures with a retry control", async () => {
  vi.mocked(listCareSubmissions).mockRejectedValue(new Error("local"));
  vi.mocked(listCareWork).mockRejectedValue(new Error("remote"));
  const component = view();
  await component._loadList();
  expect(component.innerHTML).toContain(t("care.queueLoadError"));
  expect(component.innerHTML).toContain(t("care.loadError"));
  expect(component.innerHTML).toContain("data-retry");
});
