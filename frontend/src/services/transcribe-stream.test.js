import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTranscribeSession } from "./transcribe-stream.js";

class FakeMediaRecorder {
  static instances = [];

  constructor(stream) {
    this.stream = stream;
    this.state = "inactive";
    this.mimeType = "audio/webm";
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  requestData() {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
    });
  }

  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.onstop?.();
    });
  }
}

class FakeAudioContext {
  async decodeAudioData() {
    return {
      sampleRate: 16000,
      getChannelData() {
        return new Float32Array([0.1, 0.2, 0.3, 0.4]);
      },
    };
  }

  close() {
    return Promise.resolve();
  }
}

describe("startTranscribeSession", () => {
  let trackStop;

  beforeEach(() => {
    vi.useFakeTimers();
    trackStop = vi.fn();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("navigator", {
      onLine: true,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ text: "Detected speech" }),
      }),
    );
  });

  afterEach(() => {
    FakeMediaRecorder.instances.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves transcription when the recording auto-stops", async () => {
    const states = [];
    const session = await startTranscribeSession({
      siteId: "site-1",
      onStateChange: (state) => states.push(state),
    });

    await vi.advanceTimersByTimeAsync(60000);
    await expect(session.done).resolves.toEqual({ text: "Detected speech" });

    expect(states).toEqual(["recording", "processing"]);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });
});
