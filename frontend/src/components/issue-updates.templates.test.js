import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../lib/html.js";
import { taskUpdateTimelineItem } from "./issue-updates.templates.js";

/** @param {Record<string, any>} fields */
function item(fields) {
  return taskUpdateTimelineItem(
    {
      updateId: "update-1",
      type: "additional_action",
      label: "Action taken",
      occurredAt: "2026-11-05T18:00:00.000Z",
      cityHelpNeeded: false,
      ...fields,
    },
    {},
    new Map(),
    "",
  );
}

describe("City note state on the task timeline", () => {
  it.each(["pending", "sending", "unknown"])(
    "says the note is on its way while it is %s",
    (status) => {
      const html = item({ cityNoteStatus: status });
      expect(html).toContain(`data-city-note-status="${status}"`);
      expect(html).toContain(escapeHtml(t("taskUpdate.cityNote.sending")));
      expect(html).not.toContain(escapeHtml(t("taskUpdate.cityNote.failed")));
    },
  );

  it("says the note couldn't be sent once it failed, with no retry control", () => {
    const html = item({ cityNoteStatus: "failed" });
    expect(html).toContain('data-city-note-status="failed"');
    expect(html).toContain(escapeHtml(t("taskUpdate.cityNote.failed")));
    expect(html).not.toContain(escapeHtml(t("taskUpdate.cityNote.sending")));
    expect(html).not.toContain(t("common.retry"));
  });

  it.each(["sent", "suppressed", undefined])(
    "adds nothing when the status is %s",
    (status) => {
      const html = item({ cityNoteStatus: status });
      expect(html).not.toContain("data-city-note-status");
      expect(html).not.toContain(escapeHtml(t("taskUpdate.cityNote.sending")));
      expect(html).not.toContain(escapeHtml(t("taskUpdate.cityNote.failed")));
    },
  );
});

it("shows resolution note progress and terminal failure from per-ticket checkpoints", () => {
  const cityNotes = [
    { cityNoteStatus: "failed" },
    { cityNoteStatus: "pending" },
  ];
  expect(item({ cityNotes })).toContain(
    escapeHtml(t("taskUpdate.cityNote.sending")),
  );
  cityNotes[1].cityNoteStatus = "sent";
  expect(item({ cityNotes })).toContain(
    escapeHtml(t("taskUpdate.cityNote.failed")),
  );
});
