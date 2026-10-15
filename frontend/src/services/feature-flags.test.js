import { beforeEach, expect, it, vi } from "vitest";
import {
  duplicateUiEnabled,
  setDuplicateUiSite,
  onDuplicateUiChange,
} from "./feature-flags.js";
import { duplicateCountLabel } from "../components/duplicate-issue.templates.js";
import { taskUpdateTimelineItem } from "../components/issue-updates.templates.js";
import { t } from "../i18n/i18n.js";
beforeEach(() => setDuplicateUiSite(null));
it("defaults off and requires an explicit true value from the current site", () => {
  expect(duplicateUiEnabled()).toBe(false);
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  expect(duplicateUiEnabled()).toBe(true);
  setDuplicateUiSite({});
  expect(duplicateUiEnabled()).toBe(false);
});
it("announces changes and unsubscribes listeners", () => {
  const changed = vi.fn();
  const stop = onDuplicateUiChange(changed);
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  expect(changed).toHaveBeenCalledOnce();
  stop();
  setDuplicateUiSite(null);
  expect(changed).toHaveBeenCalledOnce();
});
it("hides duplicate counts and timeline events without changing event data", () => {
  const event = {
    type: "duplicate_detected",
    occurredAt: "2026-10-15T12:00:00Z",
  };
  expect(duplicateCountLabel({ newCount: 1, duplicateCount: 2 })).toBe("");
  expect(taskUpdateTimelineItem(event, {}, new Map(), "")).toBe("");
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  expect(duplicateCountLabel({ newCount: 1, duplicateCount: 2 })).toContain(
    t("duplicate.counts", { newCount: 1, duplicateCount: 2 }),
  );
  expect(taskUpdateTimelineItem(event, {}, new Map(), "")).toContain(
    t("duplicate.timeline"),
  );
  expect(event.type).toBe("duplicate_detected");
});
