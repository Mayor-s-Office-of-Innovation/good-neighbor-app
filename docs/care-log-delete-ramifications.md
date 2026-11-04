# Care log delete — backend ramifications

The care work log list (`/care-work`) now offers per-row delete with the same
confirm-dialog flow as public complaints (branch `ui/care-log-rows`). The UI
calls a client function that does not have a server route yet:

```
DELETE /v1/care-work/{workId}
```

- Frontend: `deleteCareWork(workId)` in `frontend/src/services/api.js`,
  invoked from `care-work-view.js` after the user confirms in the
  `#care-delete` dialog. On failure the dialog shows
  `care.delete.error` and stays open, so the UI degrades safely until the
  route exists.
- Backend today: `backend/src/handlers/care-work.js` supports list/get/create
  plus photo presign/media only; logs are append-only ("changed payloads
  cannot edit it").
- Needed: a Site-scoped DELETE handler mirroring the complaint delete —
  remove the log row and its photo objects (the complaint handler's
  "permanently removes the complaint and its files" semantics; the dialog
  copy promises the same for photos).
- Open questions for the team: whether delete should be restricted to the
  author or any site member, and whether reports that count care work need
  tombstones rather than hard deletes.
