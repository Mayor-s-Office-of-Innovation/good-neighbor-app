# Home actions and public complaints — implementation plan

**Status:** implemented on the current feature branches; ready for review

**Date:** 2026-10-14

**Scope:** provider-facing web app, app API/worker, DynamoDB/S3, analyzer integration, Terraform, tests, and reference documentation

## 1. Outcome and scope

This change will:

- replace the home screen's two primary actions with a primary **Start a full check** button and an adjacent overflow-menu button;
- place **View or log public complaints** and **Flag a single issue** in that menu;
- keep the existing single-issue flow unchanged;
- add Site-scoped complaint list, create, detail, and delete experiences;
- accept complaint text and supported file evidence, upload files directly to private S3, and show upload progress/cancel controls;
- persist a complaint immediately in an `analyzing` state, then asynchronously extract structured complaint fields;
- update the list row when analysis completes and retain a recoverable failed state if it does not;
- omit maintenance actions from the menu and this release entirely.

This plan does **not** add issue linking, complaint editing, maintenance logging, offline complaint capture, or automatic actions based on complaint content.

### Confirmed product decisions

- The page title is **Public complaints** and its primary action is **Log a complaint**.
- The overflow item uses **View or log public complaints** (plural).
- **Log a maintenance action** is not shown.
- A complaint may contain both a typed description and uploaded files; all supplied material is analyzed together.
- The v1 upload set is JPEG, PNG, WebP, HEIC, PDF, TXT, and DOC. DOCX is explicitly deferred. The app verifies signatures/structure before registration, normalizes images, rejects encrypted or over-ten-page PDFs, and sends document bytes only through Bedrock's managed document input boundary.
- Upload limits are 10 MiB per file, 25 MiB total, five files per complaint, and ten pages per PDF.
- **Log complaint** enables only after every selected file is server-registered and validated. This guarantees the analysis job references complete, trusted evidence.
- Users may remove completed uploads before submission. Navigating away during an active upload requires confirmation.
- A terminal analysis failure appears as **Complaint log failed** with a **Retry** action on the row.
- Delete uses a confirmation modal, has no undo period, and physically deletes uploaded source files after confirmation.
- Ready and failed complaints may be deleted; analyzing complaints remain non-deletable.
- Complaint detail displays the generated `detail` field and uploaded files, but not separate `what`, `where`, `when`, or `notes` sections.
- Images preview in-app. PDF, TXT, and DOC source files open/download through short-lived signed links.
- Complaint source files and records that are not manually deleted are retained for one year, then physically expired/deleted under a complaint-specific lifecycle and record-retention process.
- Complaints are visible to every device authorized for the Site, including Provider Managers operating in that Site context.
- The `street-conditions-analysis` service will be updated to own the new complaint-extraction operation.

## 2. Repository findings and proposed architecture

### Existing pieces to reuse

- `/today` is rendered by `<today-view>`; its action markup is in `frontend/src/components/today-view.templates.js` and behavior in `today-view.js`.
- `/problem` already owns the single-issue flow. The menu can call its existing `single-problem` launch path, including the current location and draft behavior.
- The app has a History API router and route-to-component mapping in `frontend/src/components/app-root.js`.
- The existing upload boundary is appropriate: the browser requests a short-lived presigned URL, uploads bytes directly to private S3, then registers the artifact. Bytes do not pass through API Gateway or SQS.
- The current analyzer call is asynchronous through SQS and the worker. It enforces `store_input:false`, obtains the analyzer credential server-side, and avoids logging media.
- Shared date formatting, toast state, design tokens, native button classes, Web Awesome form controls/icons, localization catalogs, device-token authorization, structured error reporting, and media quotas should all be extended rather than duplicated.

### Recommended service boundary

The **app backend should own the complaint business process**: authorization, validation, complaint IDs and states, persistence, list/detail/delete APIs, upload registration, idempotency, enqueueing, retries, and mapping the analyzer response into the app's data model.

The **analyzer service should own the constrained multimodal AI operation** as a new complaint-extraction endpoint or analysis kind. The app worker should call it, passing text and/or normalized file content with `store_input:false`, then validate the returned JSON before updating DynamoDB.

This split is preferable to a direct Bedrock call from the app API because it:

- preserves the existing async, private-media security boundary and analyzer credential model;
- keeps the synchronous API Lambda below its 29-second budget;
- centralizes model selection, prompting, multimodal preprocessing, schema enforcement, and model observability in the analyzer;
- leaves complaint lifecycle/business rules in the app, where they belong;
- prevents model-specific response shapes from leaking into frontend contracts.

If the analyzer cannot add this capability on the required schedule, the fallback is a dedicated app-worker Bedrock adapter behind the same internal `extractComplaint()` interface. It must still run asynchronously in the worker, use a versioned prompt and JSON schema, and must not be called directly by the browser or synchronous API handler.

### Proposed state flow

`draft in browser → uploading → submitted/analyzing → ready | analysis_failed`

- `uploading` is client-only and is not shown in the persisted complaint list.
- The create endpoint atomically writes the complaint and registered evidence references with `status: "analyzing"`, then enqueues one complaint-analysis job.
- The list immediately shows the persisted fallback label **New complaint - analyzing** without a delete button.
- The worker writes `status: "ready"` and the structured fields when extraction succeeds.
- A permanent error or exhausted retry writes `status: "analysis_failed"` with safe retry metadata; it must not leave an immortal analyzing row. The UI shows **Complaint log failed** and a **Retry** action.

## 3. API and data contracts

### Proposed endpoints

All routes use the existing device-token authorizer and derive `siteId` from the principal:

- `GET /v1/complaints` — newest-first Site list; return list fields only.
- `POST /v1/complaints/{complaintId}/artifacts:presign` — reserve and presign one supported upload.
- `POST /v1/complaints` — idempotently create the complaint from text and/or previously presigned evidence references; return `202` and the analyzing row.
- `GET /v1/complaints/{complaintId}` — detail plus evidence metadata; never expose S3 keys.
- `GET /v1/complaints/{complaintId}/artifacts/{artifactId}/media` — validate complaint ownership and return a short-lived private GET URL.
- `DELETE /v1/complaints/{complaintId}` — after client confirmation, physically delete every complaint object from S3 and then remove the complaint records. If object deletion fails, return an error and retain/recover the complaint metadata so cleanup can be retried rather than silently orphaning private files.
- `POST /v1/complaints/{complaintId}/analysis:retry` — recommended for a visible permanent failure; idempotently enqueue only when retry is allowed.

The create call should accept an `Idempotency-Key` and a client-minted UUID complaint ID so a network retry cannot create duplicate rows or duplicate analysis jobs.

### Analyzer request and response

The app worker sends a versioned complaint-extraction request containing:

- `complaint_id` and non-sensitive trace identifiers;
- optional bounded description text;
- normalized images embedded in the request and document evidence referenced by five-minute, read-only S3 URLs so the analyzer can retrieve it within strict per-file and total byte limits without exceeding API Gateway's request ceiling;
- `storage.store_input: false` and no signed return URLs.

The required analyzer result is a strict object with these string fields:

```json
{
  "label": "Very short list label",
  "detail": "Concise summary of what, where, and when",
  "what": "Detailed description of the underlying complaint",
  "where": "Location information found in the supplied material",
  "when": "Timing information found in the supplied material",
  "notes": "Related information that does not fit elsewhere"
}
```

Contract rules:

- no extra keys; all six keys always exist, using an empty string when the source does not establish a value;
- explicit maximum lengths, including a short `label` suitable for one/two-line list display;
- factual extraction only: do not infer missing time/location, classify severity, or create an issue;
- schema validation in the analyzer and again in the app worker;
- prompt/schema version stored on the complaint for auditability;
- raw model output and uploaded content are never logged or stored as diagnostics.

### DynamoDB shape

Keep complaints in the authenticated Site partition and make the header sufficient for the list:

```text
pk = SITE#<siteId>
sk = COMPLAINT#<createdAt>#<complaintId>
type = complaint
complaintId, createdAt, createdBy, status
label, detail, what, where, when, notes
artifactCount, analysisVersion, analyzedAt, updatedAt
```

Evidence metadata can be child rows under a complaint-specific prefix or an array on the complaint if the final file-count limit is small. Prefer child rows so file metadata and future issue links do not inflate the list item. Add a stable complaint-ID lookup pointer if the timestamp-based list key would otherwise require a query to address detail/update/delete. Writes that create the header, evidence rows/pointers, and outbox/enqueue marker should be conditional and transactional where practical.

The list query must use key order and pagination, not a table scan or filter. Update the authoritative DynamoDB model and sample records after the shape is implemented.

## 4. Repository ownership and integration boundary

Implementation spans two repositories. Keep their changes independently reviewable and join them through a versioned HTTP contract plus integration fixtures.

### Changes in `good-neighbor-app` (this repository)

- Home action/menu UI, complaint routes, list/create/describe/detail screens, upload progress, confirmation modal, retry UI, localization, and accessibility behavior.
- Device-authenticated complaint APIs, Site-scoped DynamoDB model, presigned S3 upload/read/delete behavior, physical file deletion, pagination, idempotency, and validation.
- Complaint SQS message/outbox, worker orchestration, retries, terminal failure persistence, polling contract, metrics, alarms, Terraform, and operational documentation.
- Analyzer client call and strict validation of the response. This repository owns the app-facing canonical complaint record and never delegates authorization or persistence decisions to the analyzer.
- Image normalization may reuse the existing worker path. Add safe type-specific validation before analyzer submission as defense in depth: HEIC decode validation; PDF structure, encryption, and page limits; UTF-8/plain-text validation; and a proven legacy DOC parser/converter boundary. The analyzer repeats the relevant checks.
- Add complaint-specific one-year retention behavior for both S3 evidence and DynamoDB records. Manual confirmed deletion remains immediate and does not wait for lifecycle expiry.

### Changes in `street-conditions-analysis`

- Add a new authenticated, versioned complaint-extraction operation/analysis kind; do not overload the existing street-condition assessment schema.
- Accept optional description text plus multiple supported media parts in one request: JPEG, PNG, WebP, HEIC, PDF, TXT, and DOC.
- Safely validate and preprocess documents: verify signatures/structures, reject encrypted or malformed inputs, enforce byte/page limits, extract bounded text and/or render bounded pages, and strip or ignore active content, macros, embedded objects, and external references. HEIC must be decoded to a supported normalized image. Legacy DOC requires a sandboxed, maintained conversion/parser path; if the feasibility spike cannot establish one, return a documented `unsupported_media_type` rather than processing it unsafely. DOCX remains out of scope.
- Combine the description and every accepted file into one constrained Bedrock request so the result reflects all supplied material.
- Own model selection, prompt construction, multimodal formatting, and first-pass JSON-schema enforcement. Enforce `store_input:false` and content-free logging.
- Return exactly the versioned `label`, `detail`, `what`, `where`, `when`, and `notes` contract, using empty strings for facts not established by the evidence.
- Add contract, PDF, multimodal, prompt-regression, malformed-input, timeout, and Bedrock-response tests plus service observability.

### Cross-repository delivery contract

1. Agree and fixture the request/response schema, authentication, approved format matrix, 10 MiB/file + 25 MiB/complaint + five-file + ten-PDF-page limits, error taxonomy, timeout budget, and retryability before either side implements against assumptions.
2. Land/deploy the analyzer capability first or behind a backward-compatible versioned endpoint.
3. Point the app dev environment at that deployed capability and run mixed text + image + HEIC + PDF + TXT + DOC integration tests for every format proven safe in Phase 0.
4. Keep the public complaint entry point feature-flagged/off until both repositories and their operational alerts are deployed.

## 5. Phased implementation

### Phase 0 — decisions, contracts, and design acceptance

1. Run a focused feasibility spike for HEIC and DOC preprocessing in `street-conditions-analysis`, with special attention to a sandboxed and maintained legacy DOC conversion path. Confirm the exact libraries/runtime packaging and resource limits before enabling those MIME types. DOCX is deferred.
2. Finalize the cross-repository analyzer contract and all format-specific constraints.
3. Capture the referenced Figma frames as implementation acceptance references. The Figma canvas did not render reliably in the current browser session, so exact measurements must be rechecked before coding; repository tokens and `docs/frontend-design-system.md` remain the implementation source of truth.
4. Add an ADR only if the analyzer ownership decision or complaint retention policy is considered a durable architectural decision. Track the execution plan in the issue tracker; remove this working file after the work is complete, per `docs/README.md`.

**Exit:** signed-off API/schema, verified preprocessing path for every enabled format, one-year retention implementation, and screen/copy acceptance criteria. If legacy DOC cannot be processed safely, record that constraint and keep only DOC disabled rather than weakening validation.

### Phase 1 — home actions and routes

1. Replace the home action pair with **Start a full check** plus a 44px-minimum icon-only overflow button.
2. Implement a keyboard-operable menu using an established Web Awesome primitive if its installed API supports the required focus behavior; otherwise use a small native popover/menu implementation. Include `aria-haspopup`, `aria-expanded`, Escape/outside-click dismissal, arrow-key behavior, focus return, and visible focus.
3. Route **Flag a single issue** through the existing launcher without modifying that flow.
4. Do not render a maintenance-action item.
5. Add routes/components for `/complaints`, `/complaints/new`, `/complaints/new/describe`, and `/complaints/:complaintId` (or the repo-consistent fixed-prefix equivalent), including direct-load and browser-back behavior.
6. Add every string to all five translation catalogs; do not ship English literals in templates.

**Verification:** template/unit tests, router tests, keyboard menu tests, focus restoration, narrow viewport, light/dark themes, and no regression to full-check or single-issue launch.

### Phase 2 — persistence and read/delete APIs

1. Add complaint key helpers, repository/store functions, validation, and Site-scoped handlers.
2. Implement paginated newest-first list, detail, and evidence read authorization.
3. Implement deletion with a client confirmation modal, conditional ownership checks, idempotent behavior, and physical S3 object deletion. Do not add an undo grace period. Expose delete for ready and failed complaints, but not analyzing complaints.
4. Add one-year expiry/cleanup for complaint source files and records, with observable retry/reconciliation so DynamoDB metadata and S3 evidence cannot drift.
5. Add API Gateway routes, least-privilege IAM changes, WAF/rate considerations, metrics, and alarms.
6. Document the item shapes, access patterns, authorization boundary, and operational behavior.

**Verification:** handler/store tests for tenant isolation, pagination, malformed IDs, missing rows, concurrent/idempotent deletes, forbidden artifact references, and partial external failures.

### Phase 3 — complaint list and detail UI

1. Build a flat, token-based complaint hub using the existing home-hub archetype. Interpret requirement 6 as a top **Log a complaint** button under the **Public complaints** page title, followed by a semantic list.
2. Render label, localized timestamp, explicit status text, and an icon-only trash button with a translated accessible label. The whole ready row navigates to detail without nesting interactive controls; the delete button is a separate sibling action.
3. Hide deletion while analyzing. For `analysis_failed`, render **Complaint log failed** with both a **Retry** CTA and the confirmed delete action.
4. Add empty, loading, paginating, error, and retry states.
5. Build detail with title, timestamp, the generated `detail` field, and evidence links/previews. Show supported images in-app; open/download PDF, TXT, and DOC through short-lived signed links. Store the other structured fields but do not display them. Reserve the future linked-issue area without rendering empty chrome.

**Verification:** component/service tests, timestamps only through `i18n/dates.js`, screen-reader names, delete focus behavior, signed-media expiry recovery, empty/long/localized content, and mobile layouts.

### Phase 4 — draft entry, uploads, and text alternative

1. Build **Log a public complaint** using the flow-column pattern and specified title/subtitle/actions.
2. Use a visually styled `<label>`/native `<input type="file" multiple>` for the plus action so browser/OS file selection remains standard.
3. Add per-file rows with type icon, filename, human-readable size/status, progress bar, and an accessible cancel/remove button.
4. Use `XMLHttpRequest.upload` (or another platform API that exposes upload progress) for real byte progress; `fetch` cannot currently provide portable request-upload progress. Abort the request when cancel is selected and clean up an unregistered reservation through expiration or an explicit cancel endpoint if quotas require immediate release.
5. Extend backend validation and media normalization for JPEG, PNG, WebP, HEIC, PDF, TXT, and DOC, gated by the Phase 0 feasibility results. Do not infer support from file extensions; validate declared type, byte signature, decoded structure/page count, size, encryption status, and safe downstream conversion. Merely widening the input `accept` attribute or MIME allowlist is insufficient. DOCX remains deferred.
6. Add **Describe instead** as a routed text view using `wa-textarea`, a product-approved maximum (proposal: 4,000 characters to match existing analyzer text bounds), remaining-count/help text, and the existing keyboard-viewport utilities so the control and submit action remain visible above mobile keyboards.
7. Enable **Log complaint** only after every selected file is fully uploaded, server-registered, and validated, or a trimmed description meets the minimum with no pending/failed selected files. Disable it during submission and prevent double submit.
8. Allow removal of registered uploads before submission, including backend cleanup of their reserved objects/metadata. Confirm before leaving while an upload is active.
9. Preserve both description text and uploaded files in the draft and send all supplied material together for one analysis.

**Verification:** type/size/count validation, concurrent upload progress, cancel/retry, duplicate filenames, zero-byte and spoofed files, approved-format browser variability, keyboard clearance, restored focus, button enablement, and interrupted navigation.

### Phase 5 — asynchronous complaint analysis

1. In `street-conditions-analysis`, add the versioned complaint-extraction endpoint/analysis kind, multimodal prompt, HEIC/document preprocessing, schema enforcement, and contract fixtures described in section 4.
2. Add a typed SQS message discriminator and complaint worker so the shared worker dispatcher never confuses complaint messages with check artifacts or demo submissions.
3. On submit, conditionally persist the analyzing complaint and enqueue exactly once. Return `202` quickly.
4. Immediately navigate to the complaint list, show the global success toast **Complaint logged!**, and render the persisted analyzing row.
5. Refresh analyzing rows with bounded polling while the list is visible. Stop on terminal state, navigation, loss of connectivity, or timeout; use backoff/jitter and preserve accessible status announcements without noisy repeated speech.
6. Validate/normalize the analyzer response and conditionally update the same complaint row to ready. A stale retry must not overwrite a newer terminal result.
7. Record permanent failure after retry exhaustion and expose **Complaint log failed** with a safe **Retry** action. Add latency/failure/DLQ metrics keyed only by non-content identifiers.

**Verification:** worker unit/contract tests, retry/redrive and idempotency tests, schema-invalid output, timeout, missing S3 object, mixed text/files, stale writes, list polling, toast persistence across route change, and no content in logs.

### Phase 6 — hardening, end-to-end validation, and release

1. Add Playwright coverage for home menu → complaint list → upload/text → submit → analyzing → ready → detail → confirmed physical delete, plus the unchanged single-issue route and absence of a maintenance item.
2. Run format check, lint, typecheck, unit tests, build, Terraform formatting/validation, and relevant e2e suites.
3. Perform keyboard-only, accessibility-tree, contrast, 200% text zoom, reduced-motion, light/dark, mobile keyboard, slow-network, offline/error, and Core Web Vitals checks.
4. Verify S3 CORS for upload headers, CloudFront/API routing, CSP, WAF/rate limits, IAM least privilege, KMS encryption, lifecycle tags, DLQ alarms, and log redaction in dev before promotion.
5. Update architecture, DynamoDB model/sample records, media safeguards/runbook, localization docs if needed, and API/operational references. Create/close issue-tracker tasks per the repository SDLC process.
6. Roll out to dev, complete a live smoke test with non-sensitive fixtures, observe metrics, then promote under the existing two-environment pipeline.

**Exit:** acceptance criteria pass in dev, operational ownership is documented, and no open high-severity accessibility/security/data-loss findings remain.

## 6. Test and acceptance matrix

- **Home:** primary label is correct; overflow works by pointer, keyboard, and screen reader; single issue still launches; maintenance is absent.
- **List:** empty/populated/loading/error/pagination; newest first; analyzing row has no delete control; ready title updates without duplication; terminal failure reads **Complaint log failed** and exposes **Retry**.
- **Entry:** upload-only, text-only, and mixed text/files; disabled/enabled submit rules; double-click and reload safety; all evidence reaches one analysis request.
- **Files:** JPEG, PNG, WebP, HEIC, PDF, TXT, and DOC; invalid/spoofed signatures, malformed/encrypted/over-page-limit PDF, invalid text encoding, HEIC decode failure, malformed legacy DOC, oversize, excess count, cancellation, retry, expired presign, and partial batch failure.
- **Analysis:** success, transient retry, permanent failure, invalid JSON/schema, empty extracted fields, slow response, duplicate SQS delivery, and DLQ recovery.
- **Detail/media:** Site isolation across every authorized Site device, expired signed URL refresh, in-app image previews, signed PDF/TXT/DOC open/download behavior, only `detail` displayed from the structured result, long translated labels/details, and missing evidence.
- **Delete:** mandatory confirmation, no undo, analyzing/ready/failed availability policy, repeat request, concurrent detail read, verified physical S3 deletion, cleanup failure, and post-delete back navigation.
- **Quality gates:** all user-visible strings localized, no fixed locale outside date helpers, no raw colors, 44px targets, WCAG 2.2 AA, reduced motion, no new dependency without justification, and no media/content in logs.

## 7. Known risks and mitigations

- **HEIC, PDF, TXT, and DOC are not supported by the current check uploader.** Each requires an explicit validation and preprocessing path. Legacy DOC is the highest-risk format because it needs a maintained sandboxed binary parser/converter; if Phase 0 cannot establish a safe path, DOC alone must remain disabled and the constraint must be reported rather than weakening the boundary. DOCX is deferred.
- **A list row can remain analyzing after terminal failure.** Persist a terminal failure state and provide bounded retry/operations visibility.
- **SQS enqueue after DynamoDB write can fail.** Prefer a durable outbox pattern or equivalent reconciliation so persistence and work scheduling cannot drift.
- **Deletion spans DynamoDB and S3.** After confirmation, use an idempotent deletion state/lease, physically delete every S3 object, verify the API result, and only then remove final metadata. If cleanup fails, keep enough protected metadata to retry and report failure; do not show a false success.
- **Polling can create unnecessary load.** Poll only visible analyzing items with capped exponential backoff; consider push only if later scale proves polling insufficient.
- **Model output can invent missing facts.** Constrain the prompt/schema, require empty unknown fields, validate lengths/types, and present extracted content as a summary—not as verified fact or an automatically filed issue.
- **Sensitive complaint content increases privacy exposure.** Reuse encryption, private signed reads, short URL expiry, `store_input:false`, and content-free logs. Configure complaint evidence for one-year expiry and implement corresponding record cleanup; do not reuse the much shorter check-media lifecycle.

## 8. Open implementation gate

There are no remaining product questions. Phase 0 must verify a safe, deployable preprocessing path for HEIC and DOC—especially legacy DOC—and confirm the approved limits against the analyzer/Bedrock payload budget. DOCX is deferred. This is a technical feasibility gate, not permission to silently drop other formats: if a format cannot be supported safely, stop and return the evidence and options for product direction.

### Explicit post-MVP follow-ups

- [good-neighbor-app #487](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/issues/487): add opaque cursor pagination to the complaints API and a corresponding load-more/infinite-list interaction before any site approaches DynamoDB's 1 MiB query-page limit.
- [good-neighbor-app #486](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/issues/486): resolved structurally by storing complaint evidence in a dedicated one-year bucket and restoring the existing uploads bucket's bucket-wide 30-day retention backstop.
- [street-conditions-analysis #34](https://github.com/Mayor-s-Office-of-Innovation/street-conditions-analysis/issues/34): reassess DOCX only after bounded ZIP/package validation, external-relationship rejection, and analyzer-side resource limits have a tested implementation.

## 9. Suggested delivery slices

For reviewable changes, split implementation into these independently testable slices:

1. Home CTA/menu and complaint route shells.
2. Complaint data model plus list/detail/delete APIs.
3. Complaint list/detail frontend.
4. Image/document upload and combined text-entry draft flow in `good-neighbor-app`.
5. Complaint extraction endpoint, HEIC/PDF/TXT/DOC preprocessing, schema, and tests in `street-conditions-analysis`.
6. App worker integration, polling, success/failure/retry states, and cross-repository contract tests.
7. Infrastructure, physical-delete workflow, end-to-end tests, documentation, and dev rollout hardening.

Do not release slices 1–4 to production with a live complaint entry point until slice 6 is complete, unless the UI is explicitly feature-flagged off.
