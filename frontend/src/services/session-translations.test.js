import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.js", () => ({ getCheck: vi.fn() }));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: vi.fn(),
  updateItemAnalysis: vi.fn(),
}));

import { getCheck } from "./api.js";
import { getCurrentCheck, updateItemAnalysis } from "../state/check-session.js";
import { setLocale } from "../i18n/i18n.js";
import {
  refreshSessionTranslations,
  refreshSessionTranslationsOnLocaleChange,
} from "./session-translations.js";

const trash = {
  userFriendlyLabel: "Trash scattered along curb",
  description: "Several wrappers along the curb.",
};
const es = { user_friendly_label: "Basura", description: "Envolturas." };
const vi_ = { user_friendly_label: "Rác", description: "Giấy gói." };

/**
 * @param {Record<string, unknown>} [analysis]
 * @returns {any}
 */
const sessionWith = (analysis = {}) => ({
  id: "chk_1",
  items: [
    {
      id: "item",
      analysis: {
        status: "analyzed",
        sourceAnalysis: {
          concerns: [{ ...trash, explanation: trash.description }],
        },
        conditions: [{ conditionId: "c1", ...trash }],
        tasks: [{ taskId: "t1", ...trash }],
        ...analysis,
      },
    },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(async () => {
  await setLocale("en");
  vi.useRealTimers();
});

describe("refreshSessionTranslations", () => {
  it("merges the backend's filled-in locale into concerns, conditions, and tasks by text", async () => {
    await setLocale("es");
    vi.mocked(getCurrentCheck).mockReturnValue(sessionWith());
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({
        analyses: [
          {
            artifactId: "art_1",
            concerns: [
              {
                userFriendlyLabel: trash.userFriendlyLabel,
                explanation: trash.description,
                translations: { es, vi: vi_ },
              },
              {
                userFriendlyLabel: "Something else",
                explanation: "Different text",
                translations: {
                  es: { user_friendly_label: "Otro", description: "x" },
                },
              },
            ],
          },
        ],
      }),
    );

    await expect(refreshSessionTranslations()).resolves.toBe(true);

    expect(getCheck).toHaveBeenCalledWith("chk_1");
    expect(updateItemAnalysis).toHaveBeenCalledTimes(1);
    const [itemId, patch] = vi.mocked(updateItemAnalysis).mock.calls[0];
    expect(itemId).toBe("item");
    expect(patch.sourceAnalysis.concerns[0].translations).toEqual({
      es,
      vi: vi_,
    });
    expect(patch.conditions[0].translations).toEqual({ es, vi: vi_ });
    expect(patch.tasks[0].translations).toEqual({ es, vi: vi_ });
    // Untouched fields on the records survive the patch.
    expect(patch.conditions[0].conditionId).toBe("c1");
    expect(patch.tasks[0].taskId).toBe("t1");
  });

  it("keeps the capture-time locale when merging and upgrades a legacy block", async () => {
    await setLocale("vi");
    vi.mocked(getCurrentCheck).mockReturnValue(
      sessionWith({
        conditions: [
          {
            conditionId: "c1",
            ...trash,
            translations: { language: "es", ...es },
          },
        ],
        tasks: [],
        sourceAnalysis: { concerns: [] },
      }),
    );
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({
        analyses: [
          {
            concerns: [
              {
                userFriendlyLabel: trash.userFriendlyLabel,
                explanation: trash.description,
                translations: { vi: vi_ },
              },
            ],
          },
        ],
      }),
    );

    await expect(refreshSessionTranslations()).resolves.toBe(true);
    const patch = vi.mocked(updateItemAnalysis).mock.calls[0][1];
    expect(patch.conditions[0].translations).toEqual({ es, vi: vi_ });
  });

  it("does nothing in English or when every record already has the locale", async () => {
    vi.mocked(getCurrentCheck).mockReturnValue(sessionWith());
    await expect(refreshSessionTranslations()).resolves.toBe(true);
    expect(getCheck).not.toHaveBeenCalled();

    await setLocale("es");
    vi.mocked(getCurrentCheck).mockReturnValue(
      sessionWith({
        sourceAnalysis: { concerns: [] },
        conditions: [{ ...trash, translations: { es } }],
        tasks: [{ ...trash, translations: { es } }],
      }),
    );
    await expect(refreshSessionTranslations()).resolves.toBe(true);
    expect(getCheck).not.toHaveBeenCalled();
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });

  it("reports false, without writing, when the backend has not filled the locale yet", async () => {
    await setLocale("fil");
    vi.mocked(getCurrentCheck).mockReturnValue(sessionWith());
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({
        analyses: [
          {
            concerns: [
              {
                userFriendlyLabel: trash.userFriendlyLabel,
                explanation: trash.description,
                translations: { es },
              },
            ],
          },
        ],
      }),
    );

    await expect(refreshSessionTranslations()).resolves.toBe(false);
    // Spanish is new to the session, so it is still merged in.
    expect(updateItemAnalysis).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed fetch and leaves the session alone", async () => {
    await setLocale("es");
    vi.mocked(getCurrentCheck).mockReturnValue(sessionWith());
    vi.mocked(getCheck).mockRejectedValue(new Error("offline"));
    await expect(refreshSessionTranslations()).resolves.toBe(false);
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });

  it("ignores the response if the user moved to another check meanwhile", async () => {
    await setLocale("es");
    vi.mocked(getCurrentCheck)
      .mockReturnValueOnce(sessionWith())
      .mockReturnValue({ ...sessionWith(), id: "chk_2" });
    vi.mocked(getCheck).mockResolvedValue(
      /** @type {any} */ ({ analyses: [] }),
    );
    await refreshSessionTranslations();
    expect(updateItemAnalysis).not.toHaveBeenCalled();
  });
});

describe("refreshSessionTranslationsOnLocaleChange", () => {
  it("looks a second time after a delay while the worker is still running", async () => {
    vi.useFakeTimers();
    await setLocale("es");
    vi.mocked(getCurrentCheck).mockReturnValue(sessionWith());
    vi.mocked(getCheck)
      .mockResolvedValueOnce(/** @type {any} */ ({ analyses: [] }))
      .mockResolvedValueOnce(
        /** @type {any} */ ({
          analyses: [
            {
              concerns: [
                {
                  userFriendlyLabel: trash.userFriendlyLabel,
                  explanation: trash.description,
                  translations: { es },
                },
              ],
            },
          ],
        }),
      );

    const run = refreshSessionTranslationsOnLocaleChange({ retryDelayMs: 500 });
    await vi.advanceTimersByTimeAsync(499);
    expect(getCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(getCheck).toHaveBeenCalledTimes(2);
    expect(updateItemAnalysis).toHaveBeenCalledTimes(1);
  });

  it("stops after the first look when everything is already in place", async () => {
    await setLocale("es");
    vi.mocked(getCurrentCheck).mockReturnValue(
      sessionWith({
        sourceAnalysis: { concerns: [] },
        conditions: [{ ...trash, translations: { es } }],
        tasks: [],
      }),
    );
    await refreshSessionTranslationsOnLocaleChange({ retryDelayMs: 0 });
    expect(getCheck).not.toHaveBeenCalled();
  });
});
