import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";

vi.mock("../db.js", () => ({
  getSite: vi.fn(),
  listCareSubmissions: vi.fn(),
  deleteCareSubmission: vi.fn(),
}));
vi.mock("../services/api.js", () => ({
  listCareWork: vi.fn(),
  deleteCareWork: vi.fn(),
  getCareWork: vi.fn(),
  getCarePhoto: vi.fn(),
}));
vi.mock("../services/care-submissions.js", () => ({
  enqueueCareSubmission: vi.fn(),
  retryCareSubmission: vi.fn(),
  recoverCareSubmissions: vi.fn(),
}));
import { listCareSubmissions, deleteCareSubmission } from "../db.js";
import { listCareWork, getCareWork } from "../services/api.js";
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

it("does not restore a deleted row from a stale list page or saved local receipt", async () => {
  const component = view();
  await component._loadList();
  component._deletedWork.add("saved");
  vi.mocked(listCareSubmissions).mockResolvedValue([
    {
      workId: "saved",
      status: "saved",
      work: { workId: "saved", kind: "power_washed", photos: [] },
    },
  ]);
  await component._loadList();
  expect(component.innerHTML).not.toContain('data-work="saved"');
  component._siteId = "other-site";
  await component._loadList();
  expect(component._deletedWork.size).toBe(0);
});

it("does not replace the confirmation while deletion is in flight", async () => {
  const component = view();
  component.innerHTML = "confirmation";
  component._deletingWork = true;
  await component._loadList();
  expect(component.innerHTML).toBe("confirmation");
  expect(listCareWork).not.toHaveBeenCalled();
});

it("removes a saved receipt for a log deleted on another device after confirming the missing index row", async () => {
  vi.mocked(listCareWork).mockResolvedValue({ work: [] });
  vi.mocked(listCareSubmissions).mockResolvedValue([
    {
      workId: "gone",
      status: "saved",
      work: { workId: "gone", kind: "power_washed", photos: [] },
    },
  ]);
  vi.mocked(getCareWork).mockRejectedValue({ status: 404 });
  const component = view();
  await component._loadList();
  expect(getCareWork).toHaveBeenCalledWith("gone");
  expect(deleteCareSubmission).toHaveBeenCalledWith("site", "gone");
  expect(component.innerHTML).not.toContain('data-work="gone"');
});

it.each(["index lag", "network failure"])(
  "retains saved receipts during %s",
  async (failure) => {
    vi.mocked(listCareWork).mockResolvedValue({ work: [] });
    vi.mocked(listCareSubmissions).mockResolvedValue([
      {
        workId: "saved",
        status: "saved",
        work: { workId: "saved", kind: "power_washed", photos: [] },
      },
    ]);
    if (failure === "index lag")
      vi.mocked(getCareWork).mockResolvedValue({ work: { workId: "saved" } });
    else vi.mocked(getCareWork).mockRejectedValue({ status: 503 });
    const component = view();
    await component._loadList();
    expect(component.innerHTML).toContain('data-work="saved"');
    expect(deleteCareSubmission).not.toHaveBeenCalled();
  },
);

it("ignores a late missing-receipt response after leaving the view", async () => {
  vi.mocked(listCareWork).mockResolvedValue({ work: [] });
  vi.mocked(listCareSubmissions).mockResolvedValue([
    {
      workId: "saved",
      status: "saved",
      work: { workId: "saved", kind: "power_washed", photos: [] },
    },
  ]);
  /** @type {(reason: unknown) => void} */
  let rejectRead = () => {
    throw new Error("Expected a pending detail read");
  };
  vi.mocked(getCareWork).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectRead = reject;
      }),
  );
  const component = view();
  const loading = component._loadList();
  await vi.waitFor(() => expect(getCareWork).toHaveBeenCalled());
  component.isConnected = false;
  rejectRead({ status: 404 });
  await loading;
  expect(deleteCareSubmission).not.toHaveBeenCalled();
});
