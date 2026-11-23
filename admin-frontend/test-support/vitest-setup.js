import { afterEach, vi } from "vitest";

// Vitest keeps fake timers on across tests unless they're turned off.
afterEach(() => {
  vi.useRealTimers();
});
