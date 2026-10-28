import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";
import { shareGrant } from "./site-access-state.js";

const grant = {
  enrollmentUrl:
    "https://example.test/#enrollment_grant=synthetic&enrollment_token=synthetic",
};

afterEach(() => vi.unstubAllGlobals());

describe("sharing an enrollment invitation", () => {
  it("supplies the message and URL to every native share target, including email", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });

    await shareGrant(grant);

    expect(share).toHaveBeenCalledExactlyOnceWith({
      title: t("access.title"),
      text: t("access.shareMessage"),
      url: grant.enrollmentUrl,
    });
  });

  it("copies the message and complete URL on separate lines without native sharing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await shareGrant(grant);

    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      `${t("access.shareMessage")}\n\n${grant.enrollmentUrl}`,
    );
  });

  it("does not copy credentials to the clipboard when the share dialog is dismissed", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", {
      share: vi.fn().mockRejectedValue(new DOMException("", "AbortError")),
      clipboard: { writeText },
    });

    await expect(shareGrant(grant)).resolves.toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
  });
});
