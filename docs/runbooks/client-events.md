# Runbook: client analytics events (page views, device facts, camera hand-offs)

**Scope:** `frontend/src/services/analytics.js` → `POST /v1/client-events` → api Lambda
(`backend/src/handlers/client-events.js`) → PostHog as plain named events. No vendor SDK ships
in the app. This is the sibling of the error-tracking pipeline (`/v1/client-errors`, `$exception`
events) and the feedback pipeline (`/v1/feedback`, see [feedback-ops.md](./feedback-ops.md)); all
three share the same PostHog project key and the same log-only default.

## Why it exists (2026-10)

Field testing on older Android devices showed users returning from the camera to the home
screen instead of the active check. The browser was being killed while the camera was in the
foreground and relaunched at the entry URL. Error tracking cannot see that, and it carries no
browser or device detail for a healthy session. This pipeline gives every device a page-view
trail with browser, OS, screen, memory, and model attached, plus the specific events that
bracket the hand-off.

## Events

| Event | Fired by | Properties beyond the device facts |
|---|---|---|
| `$pageview` | every route landing (`main.js` → `startPageViewTracking`) | `$current_url` (origin + pathname, never the query), `$pathname`; first view of a document also carries `navigation_type` (`navigate` / `reload` / `back_forward`) and `$referring_domain` |
| `site_setup_completed` | `app-root` on `sitebound` | `switching_site` |
| `camera_opened` | `perimeter-check` / `problem-report` `_openCamera` | `flow` |
| `photo_picked` | the file input's `change` | `flow`, `photo_bytes`, `photo_type` |
| `capture_resumed` | `app-root` boot when a check is auto-resumed after a relaunch | `route`, `flow`, `marker_age_s`, `navigation_type`, `landing_path`, `$referring_domain` |

A `camera_opened` with no `photo_picked` after it, followed by a `$pageview` with
`navigation_type=navigate` on `/today` and then a `capture_resumed`, is the Android relaunch
signature.

**Device facts on every event.** From the client: `$screen_width/height`, `$viewport_width/height`,
`device_pixel_ratio`, `$browser_language`, `device_memory_gb`, `hardware_concurrency`,
`connection_type`, `display_mode` (`standalone` / `browser`), `platform`, `ua_mobile`, and the UA
client hints `platform_version` and `device_model` where the browser grants them. From the server,
parsed out of the `user-agent` header (`backend/src/lib/user-agent.js`): `$browser`,
`$browser_version`, `$os`, `$os_version`, `$device_type`, `android_webview`, `$raw_user_agent`.
Events are anonymous (`$process_person_profile: false`); the shared `gnp:distinct-id` groups them
per browser alongside errors and feedback.

## Allowlists (the only things the pipeline can carry)

Event names and property keys are allowlisted in
`backend/src/handlers/scrub-client-event.js`. Anything else is dropped at intake, and URL-ish
values are query-stripped again server-side. Adding an event or property means adding it there
(and its test) first; the client cannot widen what is accepted.

## Kill switches

- Per device: `localStorage['gnp:analytics'] = 'off'` (`'on'` forces it on, including under tests).
- Globally: the forwarder is log-only whenever the PostHog project key is unset (same secret as
  error tracking, [feedback-ops.md §2](./feedback-ops.md)). Log-only still writes every event and
  its device properties to CloudWatch, so the device picture is available before egress is on.
- WAF: `ClientEventsRateLimit` blocks an IP above 1000 requests per 5 minutes on this path.

## Is it working? (CloudWatch, api Lambda log group)

One structured line per event:

| Marker | Meaning |
|---|---|
| `ClientEventLogOnly` | Key not set. Validated and logged with properties, never sent. |
| `ClientEventForwarded` | PostHog accepted the batch. |
| `ClientEventForwardFailed` | Secret read or PostHog ingest failed (WARN). |
| `ClientEventDropped` | Payload rejected by the scrubber (WARN). |

Logs Insights:

```
fields @timestamp, marker, event, properties.$os, properties.$os_version, properties.$browser, properties.device_model, properties.$pathname
| filter marker like /ClientEvent/
| sort @timestamp desc
```

If `ClientEventLogOnly` dominates, the key was never put in Secrets Manager and nothing has
reached PostHog. In PostHog, the events appear under Activity with `$lib = gnp-client-events`;
`$pageview` feeds the Web Analytics views directly.

## Local development

`npm run dev` (backend harness) serves `POST /v1/client-events` and the Vite proxy forwards it,
so beacons land in the harness log. Under vitest the service is off unless forced on.
