// @ts-check
/*
  Ports for the stack the main e2e suite starts (playwright.config.js). They are
  all different from the `npm run dev` defaults, so the suite runs beside a dev
  stack without sharing a single server or emulator with it. A second suite
  finds them taken and Playwright stops it before any test runs.
*/
export const E2E_PORTS = {
  api: 3011,
  analyzer: 3111,
  app: 5183,
  sf311: 4009,
  ddb: 8010,
  mq: 9334,
  minio: 9010,
  minioConsole: 9011,
};

export const E2E_URLS = {
  api: `http://127.0.0.1:${E2E_PORTS.api}`,
  analyzer: `http://127.0.0.1:${E2E_PORTS.analyzer}`,
  app: `http://127.0.0.1:${E2E_PORTS.app}`,
  sf311: `http://127.0.0.1:${E2E_PORTS.sf311}`,
  ddb: `http://127.0.0.1:${E2E_PORTS.ddb}`,
  mq: `http://localhost:${E2E_PORTS.mq}`,
  minio: `http://localhost:${E2E_PORTS.minio}`,
};
