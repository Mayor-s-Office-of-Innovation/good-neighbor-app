# Good Neighbor Admin Frontend

Static central-admin console for managing providers, sites, contacts, setup
codes, and devices.

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
