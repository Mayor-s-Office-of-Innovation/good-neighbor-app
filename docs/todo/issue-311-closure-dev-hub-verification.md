# issue-311-closure-dev-hub-verification

Status: open — verify against the real dev HUB before release

Created from `docs/todo/311-ticket-closure-plan.md` (implementation notes +
manual test steps). Once this verification passes, that plan doc can be
deleted and this issue closed.

## Why

311 ticket closure (`UpdateSR` `UpdateType: 11`, `ClosedReason` 8) was built
and verified against the **local fake** (`npm run local:sf311`), which accepts
anything. Two HUB payload details have **never been checked against the real
dev HUB** and will fail silently (recorded as failed closures, task still
completes) if wrong:

1. **`SRnum` field casing** — we send `SRnum` (matching the working photo-
   attachment payload); the HUB doc sample says `SRNum`. Attachments already
   work with `SRnum`, so closure should too, but it's unverified for
   UpdateType 11.
2. **Date format** — we send `YYYY-MM-DD HH:mm:ss` (space separator, no
   millis) via `hubDateTime`. Same format the attachment flow already sends,
   but unverified for UpdateType 11.

## How to verify

Full walkthrough: `docs/todo/311-ticket-closure-plan.md` → "Manual test
steps". Condensed:

1. Start the local stack + fake SF311 (see
   [dev-commands.md → Fake SF311 server](../dev-commands.md#fake-sf311-server))
   and file an informational (agency-76, `task_created`) ticket through the
   normal flow.
2. Then point `SF311_UPDATESR_URL` at the **real dev HUB** (value from your
   git-ignored `.env.local` — not committed config), complete the task from
   the done path, and confirm the closure succeeds: the recorded
   `close_311_ticket` result shows `status: "closed"` with an `updateId`,
   and the ticket shows closed in the HUB/311 system.
3. If it fails with return code `23`/`25`/`29`, capture the response body
   from the `close_311_ticket` result's `diagnostics` and adjust
   `buildCloseSrPayload` in `backend/src/integrations/sf311-client.js`.

## Definition of done

- [ ] One real dev-HUB closure succeeds with `SRnum` casing as-is
- [ ] One real dev-HUB closure succeeds with the current date format
- [ ] If either needed a code change, tests updated (`sf311-client.test.js`
      asserts the exact payload shape)
- [ ] `docs/todo/311-ticket-closure-plan.md` deleted
- [ ] Links to it removed from `docs/dynamodb-data-model.md` and
      `docs/guidance-policy-changelog.md`

## Notes

- A closure failure never blocks task completion — wrong casing/format would
  be easy to miss without checking `appActionResults` (this is why it must be
  verified explicitly, not discovered later).
- HUB reference: `UpdateSR` `UpdateType 11` = ClosedReason, error `26` =
  SendingAgency must equal the SR's ResponsibleAgency (we send agency 76,
  which is why only our own informational tickets are closeable).