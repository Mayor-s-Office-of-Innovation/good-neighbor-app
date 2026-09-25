# Good Neighbor Admin Frontend

Static central-admin console for managing providers, sites, contacts, setup
codes, and devices (`index.html`), plus an Analytics page (`analytics.html`)
that runs canned queries over the reporting lake (ADR 0013).

## Analytics page

`analytics.html` lists the query catalog served by
`GET /admin/v1/analytics/queries` as buttons grouped by topic. Clicking one
runs it (with its default parameters) through
`POST /admin/v1/analytics/queries/{queryId}`; queries with parameters (days
back, site) show a small form first. Results render as a table with a CSV
download, and an "Advanced" section shows the SQL behind the last query and
lets you edit and run it via `POST /admin/v1/analytics/query`.

Everything on the page reads the Parquet lake (six-hourly exports), never the
live app database; the "as of" line shows the newest export stamp. Add or
change canned queries in `backend/src/analytics/catalog.js` — no frontend
change needed.

Locally, the analytics routes need `LAKE_BUCKET` and `LAKE_AWS_PROFILE` in
`.env.local` (see `.env.example`); without them the page loads but queries
fail with a lake error.

## Local Debug Mode

For local development, `config.js` enables `localDebugAdmin` and points API
calls at the local backend:

```js
window.GOOD_NEIGHBOR_ADMIN_CONFIG = {
  apiBase: "http://localhost:3001",
  localDebugAdmin: true,
};
```

Start the backend, then serve this directory:

```sh
npm run dev --workspace backend
cd admin-frontend
python3 -m http.server 5175 --bind 127.0.0.1
```

Open <http://127.0.0.1:5175/>.

In debug mode, the admin frontend sends `X-Debug-Groups: central-admin` and
`X-Debug-Sub: local-admin`. The local API harness turns those headers into the
same Cognito-shaped claims the deployed admin handlers read.

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
};
```
