# Live Transcription — STATUS & RESUME (start here)

**Last updated:** 2026-08-06
**Purpose:** Single source of truth for picking this workstream back up cold in a new session.
Read this first, then the architecture doc.

---

## What this workstream is

Adding **live voice-note transcription** to the **gnp** field-conditions reporting app
(vanilla Web Components + Vite + Web Awesome + PWA + IndexedDB; see `../PLAN.md`, `../spec.md`).

The chosen design is care-connect's **"Option C" / client-direct** approach: the browser streams
microphone audio **directly to Amazon Transcribe** using short-lived credentials, so **audio never
passes through our compute**. UX = **live partial results** (text appears as the person speaks).

**Design/plan doc:** `./transcription-architecture.md` — read it in full; it has the reasoning,
the security model, and the sequenced build plan. This STATUS doc is just the "where are we / what
next" layer on top.

---

## Decisions locked (do not relitigate without reason)

1. **Client-direct streaming (Option C).** Browser → Amazon Transcribe directly. Audio off Lambda.
2. **UX = live partial results** (not record-then-transcribe).
3. **Cost-only blast radius REJECTED.** We are building a **real gate**. This ruled out the Cognito
   _unauthenticated_ Identity Pool and the open Lambda endpoint.
4. **Gate = per-site invite codes over email.** An admin generates a code per site and emails it;
   the site administrator enters it at the app URL; we validate server-side, register the device,
   and unlock recording (and future gated features) for that device.
5. **Custom device-token backend (Direction C)**, not Cognito. This backend (DynamoDB + Lambdas)
   is deliberately the **first brick of the future sync backend** (which will handle multi-device
   per-site task sync and, later, real auth/SSO). Transcription rides on the same device identity.
6. **Transcription is an identity/credential concern, not a compute service** (unlike AI photo
   analysis, whose payload flows through compute). Its cred-vending lives with the identity backend.

### Still open (proposed defaults in architecture doc §7 — none blocking)

- Invite-code lifecycle (proposed: reusable per site, 90-day expiry, revocable).
- Rate-limit / daily per-device cap (proposed: ~60 transcription min/device/day + throttling + cost alarm).
- `microphone-stream` vs. hand-rolled AudioWorklet (decide from spike result).
- Custom vocabulary (proposed: defer).
- Offline fallback behavior (proposed: keep a record-to-Blob fallback).
- Backend stack/IaC (proposed: Node Lambda + CloudFormation/SAM under `aws/`, mirroring care-connect).

---

## Progress

| Item                                                            | State                                       |
| --------------------------------------------------------------- | ------------------------------------------- |
| Architecture + security design                                  | ✅ Done — `./transcription-architecture.md` |
| **Workstream A: audio spike** (throwaway, de-risk the pipeline) | 🟡 **Built, NOT yet tested**                |
| Workstream B: backend (invite codes + cred vending)             | ⬜ Not started                              |
| Client: site-setup invite-code flow                             | ⬜ Not started                              |
| Client: real streaming component (rework `capture-audio.js`)    | ⬜ Not started                              |
| Client: wire live transcript into `report-form.js`              | ⬜ Not started                              |

### What's built: the spike (`../spike/transcribe/`)

A zero-install, self-contained page proving mic → AudioWorklet (16 kHz PCM) →
`@aws-sdk/client-transcribe-streaming` → live partials. Files:

- `pcm-worklet.js` — hand-rolled AudioWorklet, decimates to 16 kHz signed-16-bit-LE PCM.
- `main.js` — wiring + pushable async stream + live/final UI. Imports SDK via native ESM (esm.sh).
- `index.html` — minimal UI (paste temp creds, Start/Stop, Partial/Final panes, 180 s cap).
- `README.md` — run steps, temp-cred command, and an **empty "Spike result" section to fill in**.

**⚠️ The spike has not been run yet.** It needs a real mic + live AWS creds in a browser (can't be
driven headless). Testing it is the immediate next action.

---

## NEXT ACTIONS (in order)

1. **Test the spike** (Workstream A). Serve + open + paste temp creds + talk:
   ```sh
   npx http-server /Users/aaron.hans/dev/gnp/spike/transcribe -p 8080 -c-1
   # open http://localhost:8080
   aws sts get-session-token --duration-seconds 3600   # paste AKID / Secret / SessionToken
   ```
   Then record the outcome in `../spike/transcribe/README.md` → "Spike result", and note the
   `microphone-stream` vs. hand-rolled decision here + in architecture doc §7.
   - **If esm.sh / the SDK browser build misbehaves:** fallback is a small Vite setup with
     `@aws-sdk/client-transcribe-streaming` as a real dep (print the install cmd, don't run it).
   - **If the worklet is fussy on the target browsers:** swap to `microphone-stream`.
2. **Backend (Workstream B)** — architecture doc §5.0: DynamoDB (`SITE`/`INVITE`/`DEVICE`, codes +
   tokens hashed), two Lambdas behind API Gateway — `POST /register` (invite code → device token)
   and `POST /transcribe-credentials` (device token → scoped short-lived STS creds), the scoped
   single-action IAM role, an invite-code-minting CLI, plus rate limits + cost alarms. IaC under
   `aws/` mirroring care-connect's CloudFormation pattern.
3. **Client site-setup** — architecture doc §5.2: rework `src/components/site-setup.js` to take an
   invite code → `POST /register` → store `{ siteId, name, deviceToken }` in IndexedDB.
4. **Client streaming component** — architecture doc §5.3: rework `src/components/capture-audio.js`
   to live-stream (creds from `/transcribe-credentials`); lazy-load the SDK out of the PWA precache.
5. **Wire into form** — architecture doc §5.4: live transcript into the `#desc` field in
   `src/components/report-form.js`; keep `src/services/transcribe.js` mock as offline fallback.
6. **Verify** on the real 400-site device/browser matrix (architecture doc §5.6).

---

## Key files & references

**In this repo (gnp):**

- `docs/transcription-STATUS.md` — this file.
- `docs/transcription-architecture.md` — full design, security model, build plan.
- `spike/transcribe/` — the built (untested) audio spike.
- `PLAN.md` / `spec.md` — the overall app (Phase 1: no-backend, offline, device-bound, mocked AI).
- `src/services/transcribe.js` — current **mock** (clean swap point, `Blob → Promise<string>`).
- `src/components/capture-audio.js` — current record-to-Blob component (to be reworked).
- `src/components/report-form.js` — calls transcribe() on submit today (to be reworked for live).
- `src/components/site-setup.js` — first-run site binding (to gain the invite-code flow).

**Reference — the original Option C design (another project's notes):**

- `../../notes/plans/lambda-transcription-client-direct.md`
- `../../notes/plans/lambda-eliminate-docker-feasibility.md` (broader serverless context)

**Reference — care-connect's real implementation (pattern to adapt, not copy):**

- `../../care-connect/server/routes/api/ai/transcribe.js` — server-side Transcribe streaming
  (the `audioStream()` generator shape we reuse client-side).
- `../../care-connect/client/src/components/AudioRecorder.jsx` — `downsampleToInt16` logic.
- `../../care-connect/aws/transcribe.json` + `transcribe.sh` — CloudFormation IAM pattern
  (note: uses _static IAM keys_ — exactly what our design replaces with short-lived STS creds).

> ⚠️ The two reference groups above live **outside the gnp repo** (sibling dirs under
> `~/dev/`). A fresh session in a different environment may not have them — the design doc
> captures the essentials, but grab these paths if available.

---

## One-paragraph resume summary (paste into a new session if needed)

> We're adding live voice transcription to the gnp field-reporting web app using care-connect's
> "Option C": the browser streams mic audio directly to Amazon Transcribe with short-lived creds
> (audio never touches our Lambda), showing live partial results. Security gate is **per-site
> invite codes emailed to admins**, validated by a small **custom device-token backend**
> (DynamoDB + two Lambdas) that is intentionally the first brick of gnp's future sync backend —
> we rejected any cost-only/no-gate option. Full design in `docs/transcription-architecture.md`;
> status/next-steps in `docs/transcription-STATUS.md`. A throwaway audio spike in
> `spike/transcribe/` is **built but not yet tested** — testing it (and recording the
> microphone-stream-vs-worklet decision) is the immediate next step, then build the backend.
