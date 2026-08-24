/**
 * @typedef {"recording" | "processing"} VoiceState
 *
 * @typedef {object} StartTranscribeSessionOptions
 * @property {string | null | undefined} [siteId]
 * @property {(state: VoiceState) => void} [onStateChange]
 * @property {(liveText: string) => void} [onTranscript]
 *
 * @typedef {object} TranscribeSession
 * @property {() => Promise<{ text: string }>} stop
 * @property {() => Promise<{ text: string }>} cancel
 * @property {Promise<{ text: string }>} done
 */
/*
  Client-side voice transcription via the browser's built-in SpeechRecognition
  (Chrome/Edge behind `webkit`, Safari). Zero backend, zero cost, zero extra deps
  — it replaces the Amazon Transcribe record→downsample→POST pipeline while keeping
  the SAME session contract the UI depends on:

    startTranscribeSession({ siteId, onStateChange, onTranscript }) → { stop(), cancel(), done }
      onStateChange("recording" | "processing")
      onTranscript(liveText)    // cumulative transcript-so-far (final + current interim),
                                // fired on every result so the UI can show live text
      done: Promise<{ text }>   // resolves with the final transcript, or "" on cancel
                                // rejects with a user-facing Error otherwise

  Live text: finalized phrases plus the current interim are streamed via onTranscript
  as the user speaks; `done` still resolves with the final transcript on stop. `siteId`
  is accepted for contract parity but ignored (no credentials are vended; recognition
  runs in the browser).

  Caveat: on Chrome/Edge the audio is streamed to Google's servers for recognition
  (not on-device); Firefox has no SpeechRecognition and gets a clear unsupported
  error so the typing path still works. See the spike write-up that vetted this.
*/
// Match the Amazon path's 60s cap so a forgotten session can't run forever.
const MAX_TRANSCRIBE_MS = 60000;

/**
 * @param {unknown} error
 * @returns {Error}
 */
function mapSpeechError(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new Error("You’re offline. Connect to the internet to use voice.");
  }
  if (error === "not-allowed" || error === "service-not-allowed") {
    return new Error("Microphone permission was denied.");
  }
  if (error === "audio-capture") {
    return new Error("No microphone was found on this device.");
  }
  if (error === "network") {
    return new Error("Voice transcription failed. Check your connection.");
  }
  if (error instanceof Error) return error;
  return new Error("Voice transcription failed.");
}

/**
 * @param {StartTranscribeSessionOptions} [options]
 * @returns {Promise<TranscribeSession>}
 */
export async function startTranscribeSession({
  siteId, // accepted for contract parity; unused (no credentials needed)
  onStateChange = () => {},
  onTranscript = () => {},
} = {}) {
  void siteId;
  // Read the global lazily (browser: globalThis === window) so a missing API is
  // detected per call and the seam stays unit-testable.
  const SpeechRecognition =
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error("Voice transcription is not supported on this device.");
  }

  let finalText = "";
  // The most recent interim (not-yet-finalized) phrase. Chrome drops an in-flight
  // utterance when the engine ends / stop() is called before it finalizes, so we
  // keep the interim as a fallback — the transcript is never lost just because the
  // user stopped mid-phrase. It is never surfaced to the UI (no live text).
  let latestInterim = "";
  // Distinguishes "the engine stopped on its own after a pause" (auto-restart) from
  // "the user stopped / canceled" (settle and stay stopped).
  let wantRunning = true;
  let stopping = false;
  let canceled = false;
  let settled = false;
  let recognition = null;
  let autoStopTimer = null;

  let finishedResolve;
  let finishedReject;
  const done = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  function cleanup() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    if (recognition) {
      recognition.onend = null; // block the auto-restart path
      recognition.onresult = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
      recognition = null;
    }
  }

  function resolveWith(text) {
    if (settled) return;
    settled = true;
    cleanup();
    finishedResolve({ text });
  }

  function rejectWith(error) {
    if (settled) return;
    settled = true;
    cleanup();
    finishedReject(mapSpeechError(error));
  }

  function finalize() {
    if (canceled) {
      resolveWith("");
      return;
    }
    // Finalized phrases plus any still-dangling interim (the engine may not have
    // finalized the last phrase before stop). Combining — rather than falling back
    // only when empty — means the committed text always matches the live preview,
    // and a mid-phrase stop never drops speech. latestInterim is "" once its phrase
    // finalizes, so there's no duplication.
    const text = `${finalText} ${latestInterim}`.replace(/\s+/g, " ").trim();
    if (!text) {
      const error = Object.assign(new Error("No speech was detected. Try again."), {
        code: "no_speech",
      });
      rejectWith(error);
      return;
    }
    resolveWith(text);
  }

  function build() {
    const r = new SpeechRecognition();
    r.lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";
    r.continuous = true;
    // Interim results are tracked internally (see latestInterim) but never shown —
    // enabling them is what lets us recover a phrase the user stopped mid-way. The
    // "no live text" UX is preserved because nothing here reaches the field.
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      // event.results is cumulative; start at resultIndex to avoid re-appending.
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript.trim() + " ";
        } else {
          interim += result[0].transcript;
        }
      }
      // Remember the tail interim only while it hasn't been finalized; a final
      // result in this same batch means nothing is left dangling.
      latestInterim = interim.trim();
      // Stream the cumulative transcript (finalized phrases + current interim) so the
      // UI can show live text as the user speaks. finalText carries trailing spaces
      // between phrases; collapse + trim so the preview reads cleanly.
      onTranscript((finalText + latestInterim).replace(/\s+/g, " ").trim());
    };

    r.onerror = (event) => {
      // "no-speech"/"aborted" are normal in continuous use — let onend decide
      // whether to restart (still recording) or settle (user stopped).
      if (event.error === "no-speech" || event.error === "aborted") return;
      wantRunning = false;
      rejectWith(event.error);
    };

    r.onend = () => {
      // The engine ends itself after a pause even in continuous mode. If the user
      // hasn't stopped, spin up a fresh instance and keep accumulating.
      if (wantRunning && !stopping && !canceled) {
        try {
          recognition = build();
          recognition.start();
          return;
        } catch (error) {
          rejectWith(error);
          return;
        }
      }
      onStateChange("processing");
      finalize();
    };

    return r;
  }

  function finish(cancel) {
    if (stopping || settled) return;
    stopping = true;
    canceled = cancel;
    wantRunning = false;
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    if (!recognition) {
      onStateChange("processing");
      finalize();
      return;
    }
    try {
      // stop() flushes a trailing final result then fires onend; abort() drops it.
      if (cancel) recognition.abort();
      else recognition.stop();
    } catch {
      onStateChange("processing");
      finalize();
    }
  }

  try {
    recognition = build();
    onStateChange("recording");
    recognition.start();
  } catch (error) {
    cleanup();
    throw mapSpeechError(error);
  }

  autoStopTimer = setTimeout(() => finish(false), MAX_TRANSCRIBE_MS);

  return {
    // stop()/cancel() only sequence the shutdown; the transcript (and any error)
    // flows through `done`, which the caller handles separately. Swallow the
    // rejection here so `await session.stop()` never throws an unhandled rejection
    // — the caller isn't the place that reports transcription errors.
    stop() {
      finish(false);
      return done.catch(() => {});
    },
    cancel() {
      finish(true);
      return done.catch(() => {});
    },
    done,
  };
}
