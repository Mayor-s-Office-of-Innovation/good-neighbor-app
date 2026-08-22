import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTranscribeSession } from "./web-speech-transcribe.js";

// Minimal stand-in for the browser SpeechRecognition. Tests drive it by hand:
// emitFinal() to feed a finalized phrase, emitError() to raise onerror, and
// start/stop/abort mirror the real lifecycle (stop/abort fire onend, like the API).
class FakeRecognition {
  constructor() {
    FakeRecognition.instances.push(this);
    this.started = false;
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  start() {
    this.started = true;
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
  emitFinal(transcript) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript }, isFinal: true }],
    });
  }
  emitInterim(transcript) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript }, isFinal: false }],
    });
  }
  emitError(error) {
    this.onerror?.({ error });
  }
}
FakeRecognition.instances = [];

describe("startTranscribeSession (Web Speech)", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws a clear error when the API is unavailable", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    await expect(startTranscribeSession({ siteId: "s" })).rejects.toThrow(
      /not supported/i,
    );
  });

  it("emits 'recording' then 'processing' and resolves the final transcript on stop", async () => {
    const states = [];
    const session = await startTranscribeSession({
      siteId: "s",
      onStateChange: (state) => states.push(state),
    });
    const engine = FakeRecognition.instances[0];
    expect(engine.started).toBe(true);
    expect(states).toEqual(["recording"]);

    engine.emitFinal("trash near the entrance");
    await session.stop();
    await expect(session.done).resolves.toEqual({
      text: "trash near the entrance",
    });
    expect(states).toEqual(["recording", "processing"]);
  });

  it("streams the cumulative live transcript via onTranscript as speech arrives", async () => {
    const live = [];
    const session = await startTranscribeSession({
      siteId: "s",
      onTranscript: (text) => live.push(text),
    });
    const engine = FakeRecognition.instances[0];
    engine.emitFinal("trash near");
    engine.emitInterim("the entrance");
    // Each result streams final-so-far + current interim, collapsed and trimmed.
    expect(live).toEqual(["trash near", "trash near the entrance"]);
    await session.stop();
    await expect(session.done).resolves.toEqual({
      text: "trash near the entrance",
    });
  });

  it("falls back to the last interim phrase when nothing was finalized", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    const engine = FakeRecognition.instances[0];
    // The user spoke, but the engine never finalized before stop — the interim
    // must still be recovered rather than reported as no speech.
    engine.emitInterim("pothole by the crosswalk");
    await session.stop();
    await expect(session.done).resolves.toEqual({
      text: "pothole by the crosswalk",
    });
  });

  it("rejects with a no-speech message when nothing was transcribed", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    await session.stop();
    await expect(session.done).rejects.toThrow(/no speech/i);
  });

  it("stop() never rejects even when the transcript errors", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    // done rejects (no speech), but the shutdown signal must resolve so callers
    // that `await session.stop()` don't raise an unhandled rejection.
    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.done).rejects.toThrow(/no speech/i);
  });

  it("resolves empty on cancel and aborts the engine", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    const engine = FakeRecognition.instances[0];
    engine.emitFinal("some text that should be discarded");
    await session.cancel();
    await expect(session.done).resolves.toEqual({ text: "" });
    expect(engine.aborted).toBe(true);
  });

  it("maps a permission-denied error to a user-facing message", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    const engine = FakeRecognition.instances[0];
    engine.emitError("not-allowed");
    await expect(session.done).rejects.toThrow(/microphone permission/i);
  });

  it("auto-restarts a fresh engine when it self-ends mid-recording", async () => {
    const session = await startTranscribeSession({ siteId: "s" });
    const first = FakeRecognition.instances[0];
    first.emitFinal("first phrase");
    // The engine ends itself after a pause; we're still recording, so a new one spins up.
    first.onend();
    expect(FakeRecognition.instances).toHaveLength(2);
    const second = FakeRecognition.instances[1];
    expect(second.started).toBe(true);

    second.emitFinal("second phrase");
    await session.stop();
    await expect(session.done).resolves.toEqual({
      text: "first phrase second phrase",
    });
  });
});
