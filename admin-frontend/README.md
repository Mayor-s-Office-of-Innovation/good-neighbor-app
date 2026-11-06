# Good Neighbor Admin Frontend

Static central-admin console for managing providers, full site information,
compliance-letter PDFs, contacts, setup codes, and devices, plus Insights
reporting (`index.html`). Insights replaced the Analytics page: the old
`analytics.html` bookmark is a static redirect in `public/` to `/analytics/`,
which opens Insights.

## Local Debug Mode

For local development, `config.js` enables `localDebugAdmin` and points API
calls at the local backend:

```js
window.GOOD_NEIGHBOR_ADMIN_CONFIG = {
  apiBase: "http://localhost:3001",
  localDebugAdmin: true,
};
```

Start the backend, then run the Vite admin dev server. Vite is needed here to
bundle the shared Web Awesome form controls used by the admin UI:

```sh
npm run dev --workspace backend
npm run dev:admin
```

Open <http://127.0.0.1:5175/>.

In debug mode, the admin frontend sends `X-Debug-Groups: central-admin` and
`X-Debug-Sub: local-admin`. The local API harness turns those headers into the
same Cognito-shaped claims the deployed admin handlers read.

The production admin site is built with `npm run build:admin`; its static output
is written to `admin-frontend/dist` and published by the deployment workflow.

## Deployed Config

Deployed environments should generate or replace `config.js` with real Cognito
settings and `localDebugAdmin: false`:

```js
window.GOOD_NEIGHBOR_ADMIN_CONFIG = {
  cognitoDomain: "https://YOUR_DOMAIN.auth.us-east-1.amazoncognito.com",
  clientId: "YOUR_ADMIN_APP_CLIENT_ID",
  redirectUri: "https://admin.goodneighborsf.org/auth/callback",
  logoutUri: "https://admin.goodneighborsf.org/",
  apiBase: "",
  localDebugAdmin: false,
  insightsEnabled: false,
};
```

### Insights switch

`insightsEnabled: true` shows the Manage / Insights tabs to admins whose
session grants `viewInsights`. It is off by default while Insights is built,
and turning it off again leaves Manage and System Status as they were. Deployed
environments switch it on with the `ADMIN_INSIGHTS_ENABLED` GitHub
environment variable set to `true`; `.github/workflows/deploy.yml` writes it
into their `config.js`.

### Local role switch

On loopback hosts with `localDebugAdmin: true` and a loopback API, the header
provides a tab-scoped Supervisor / Compliance manager (Maya Manager) switch.
Switching reloads the current page and confirms before discarding dirty forms.
The API still enforces actual directory status and Site assignments.

To prepare Maya's local directory record (without changing Site assignments):

```sh
node --env-file=.env.local backend/scripts/seed-local-compliance-manager.mjs
```

Run that command from the repository root. It refuses nonlocal emulator targets.
Maya starts unassigned. As Supervisor, assign Maya in a Site's Oversight tab and
save; switch to Maya to test editing there and read-only behavior elsewhere.
Switch back to Supervisor to remove the test assignment. No Cognito password or
real invitation is used. The switch is unavailable on deployed hosts.
