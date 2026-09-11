import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError, withServerErrorsLogged } from "./log-server-error.js";

describe("logServerError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single-line structured JSON error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logServerError("api POST /v1/checks", new Error("boom"), {
      reqId: "req-1",
    });

    expect(error).toHaveBeenCalledTimes(1);
    const line = /** @type {string} */ (error.mock.calls[0]?.[0]);
    // Single line: no raw newlines from stacks leak into the output.
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "ERROR",
      route: "api POST /v1/checks",
      reqId: "req-1",
      name: "Error",
      message: "boom",
      stack: expect.stringContaining("Error: boom"),
    });
  });

  it("handles non-Error throwables (strings, objects)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logServerError("worker analyze", "plain string failure");
    logServerError("worker analyze", 42);

    const first = JSON.parse(/** @type {string} */ (error.mock.calls[0]?.[0]));
    expect(first.name).toBe("NonError");
    expect(first.message).toBe("plain string failure");
    expect(
      JSON.parse(/** @type {string} */ (error.mock.calls[1]?.[0])).message,
    ).toBe("42");
  });

  it("never throws on hostile error shapes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      logServerError(
        "api",
        /** @type {any} */ ({
          get message() {
            throw new Error("getter bomb");
          },
        }),
      ),
    ).not.toThrow();
  });

  it("merges extra context fields", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logServerError("worker x", new Error("e"), { extra: { messageId: "m1" } });

    expect(
      JSON.parse(/** @type {string} */ (error.mock.calls[0]?.[0])),
    ).toMatchObject({ messageId: "m1" });
  });
});

describe("withServerErrorsLogged", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the work value when nothing throws", async () => {
    await expect(
      withServerErrorsLogged("api t", () => Promise.resolve(7)),
    ).resolves.toBe(7);
  });

  it("logs structured then RETHROWS (platform converts to 500/redrive)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("handler exploded");

    await expect(
      withServerErrorsLogged("api GET /health", () => Promise.reject(boom)),
    ).rejects.toBe(boom);

    const line = /** @type {string} */ (error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "ERROR",
      route: "api GET /health",
      message: "handler exploded",
    });
  });

  it("logs + rethrows a SYNCHRONOUS throw from a sync handler", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("sync handler exploded");

    await expect(
      withServerErrorsLogged("api POST /future-sync", () => {
        throw boom; // sync throw — escapes a bare `work().catch(...)`
      }),
    ).rejects.toBe(boom);

    const line = /** @type {string} */ (error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "ERROR",
      route: "api POST /future-sync",
      message: "sync handler exploded",
    });
  });
});
