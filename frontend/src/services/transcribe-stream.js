// @ts-nocheck -- browser transcription uses MediaRecorder + Web Audio APIs.
const MAX_TRANSCRIBE_MS = 60000;
const TARGET_SAMPLE_RATE = 16000;
const RECORDER_TIMESLICE_MS = 250;
const LEADING_SILENCE_MS = 250;

async function requestTranscription(pcmData) {
  const response = await fetch("/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audio: int16ToBase64(pcmData),
      mediaType: "audio/pcm",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || "Voice transcription failed.";
    const error = new Error(message);
    error.code = payload?.error || "transcribe_failed";
    throw error;
  }
  return payload?.text?.trim() || "";
}

function downsampleToInt16(audioBuffer) {
  const inputData = audioBuffer.getChannelData(0);
  const inputRate = audioBuffer.sampleRate;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(inputData.length / ratio);
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sample = inputData[Math.floor(index * ratio)];
    output[index] = Math.max(
      -32768,
      Math.min(32767, Math.floor(sample * 32767)),
    );
  }

  return output;
}

function prependLeadingSilence(pcmData) {
  const silenceSamples = Math.floor(
    TARGET_SAMPLE_RATE * (LEADING_SILENCE_MS / 1000),
  );
  if (silenceSamples <= 0) return pcmData;

  const output = new Int16Array(silenceSamples + pcmData.length);
  output.set(pcmData, silenceSamples);
  return output;
}

async function decodeBlobToPcm(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return prependLeadingSilence(downsampleToInt16(audioBuffer));
  } finally {
    void audioContext.close();
  }
}

function int16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function mapTranscribeError(error) {
  if (!navigator.onLine) {
    return new Error("You’re offline. Connect to the internet to use voice.");
  }
  if (error?.code === "transcribe_not_configured") return error;
  if (error?.code === "transcribe_failed") return error;
  if (error?.name === "NotSupportedError") {
    return new Error("Voice transcription is not supported on this device.");
  }
  if (error?.name === "NotAllowedError") {
    return new Error("Microphone permission was denied.");
  }
  if (error?.name === "AbortError") {
    return new Error("The recording session was interrupted.");
  }
  return new Error(error?.message || "Voice transcription failed.");
}

export async function startTranscribeSession({
  siteId,
  onStateChange = () => {},
}) {
  if (!siteId) {
    throw new Error("This device is not bound to a site yet.");
  }
  if (
    typeof MediaRecorder === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === "undefined"
  ) {
    throw new Error("Voice transcription is not supported on this device.");
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw mapTranscribeError(error);
  }

  const recorder = new MediaRecorder(stream);
  const chunks = [];
  let autoStopTimer = null;
  let stopped = false;
  let canceled = false;
  let finishedResolve;
  let finishedReject;

  const done = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  function settleFailure(error) {
    finishedReject(mapTranscribeError(error));
  }

  recorder.ondataavailable = (event) => {
    if (event.data?.size > 0) {
      chunks.push(event.data);
    }
  };

  onStateChange("recording");
  recorder.start(RECORDER_TIMESLICE_MS);

  recorder.onerror = () => {
    settleFailure(new Error("The recording session was interrupted."));
  };
  recorder.onstop = async () => {
    try {
      stream.getTracks().forEach((track) => track.stop());
      if (canceled) {
        finishedResolve({ text: "" });
        return;
      }
      onStateChange("processing");
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      const pcmData = await decodeBlobToPcm(blob);
      const text = await requestTranscription(pcmData);
      if (!text) {
        const error = new Error("No speech was detected. Try again.");
        error.code = "no_speech";
        throw error;
      }
      finishedResolve({ text });
    } catch (error) {
      settleFailure(error);
    }
  };

  function finish(cancel = false) {
    if (stopped) return;
    stopped = true;
    canceled = cancel;
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    if (recorder.state !== "inactive") {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
      recorder.stop();
      return;
    }
    stream.getTracks().forEach((track) => track.stop());
  }

  autoStopTimer = setTimeout(() => finish(false), MAX_TRANSCRIBE_MS);

  return {
    async stop() {
      finish(false);
      return done;
    },
    cancel() {
      finish(true);
      return done;
    },
    done,
  };
}
