// @ts-check
/*
  Slow-motion control for headed runs. E2E_SLOW_MS (milliseconds, default 0)
  delays every Playwright action — clicks, navigations, file uploads, and each
  keystroke — so a human can watch the flow. The `test:headed` npm script sets
  it automatically; override from the shell for a custom pace:

    E2E_SLOW_MS=150 npx playwright test --headed     (from e2e/)

  Headless/CI runs are unaffected (the var is unset there).
*/
const slowMs = Number(process.env.E2E_SLOW_MS ?? 0);

/** Milliseconds between keystrokes in pressSequentially. */
export const typeDelay = slowMs;

/** True when slow motion is active (headed debugging). */
export const isSlowMo = slowMs > 0;

/**
 * Playwright contextOptions chunk enabling slowMo when configured.
 * @returns {{ launchOptions?: { slowMo?: number } }}
 */
export const slowMoOptions =
  slowMs > 0 ? { launchOptions: { slowMo: slowMs } } : {};
