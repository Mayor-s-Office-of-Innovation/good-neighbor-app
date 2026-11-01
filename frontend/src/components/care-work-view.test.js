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

it("retains server logs and refreshes queue labels without fetching offline", async () => {
  const component = view();
  await component._loadList();
  const originalNavigator = globalThis.navigator;
  vi.stubGlobal("navigator", { onLine: false });
  vi.mocked(listCareSubmissions).mockResolvedValue([
    {
      workId: "pending",
      kind: "power_washed",
      createdAt: "2026-10-27T13:00:00Z",
      status: "pending",
    },
  ]);
  try {
    await component._loadList();
    expect(listCareWork).toHaveBeenCalledOnce();
    expect(component.innerHTML).toContain('data-work="saved"');
    expect(component.innerHTML).toContain(t("card.recovery.offline"));
    expect(component.innerHTML).not.toContain("wa-spinner");
  } finally {
    vi.stubGlobal("navigator", originalNavigator);
  }
});

it("retains the last complete server snapshot when a refresh fails", async () => {
  const component = view();
  await component._loadList();
  vi.mocked(listCareWork).mockRejectedValueOnce(new Error("network"));
  await component._loadList();
  expect(component.innerHTML).toContain('data-work="saved"');
  expect(component.innerHTML).toContain(t("care.loadError"));
  vi.mocked(listCareWork).mockResolvedValueOnce({ work: [] });
  await component._loadList();
  expect(component.innerHTML).not.toContain('data-work="saved"');
});

it("does not retain another site's server logs", async () => {
  const component = view();
  await component._loadList();
  component._siteId = "other-site";
  vi.mocked(listCareWork).mockRejectedValueOnce(new Error("network"));
  await component._loadList();
  expect(component.innerHTML).not.toContain('data-work="saved"');
});
