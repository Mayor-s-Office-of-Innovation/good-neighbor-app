import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming";
import providerModule from "@aws-sdk/credential-provider-node";
import { jsonResponse, readJsonBody } from "../http.js";

/**
 * @typedef {import("@aws-sdk/client-transcribe-streaming").StartStreamTranscriptionCommandInput} StartStreamTranscriptionCommandInput
 */

const { defaultProvider } = providerModule;

/** @type {TranscribeStreamingClient | undefined} */
let client;

function getClient() {
  if (!client) {
    const profile = process.env.TRANSCRIBE_AWS_PROFILE;
    client = new TranscribeStreamingClient({
      region: process.env.AWS_REGION || "us-west-2",
      credentials: defaultProvider(profile ? { profile } : undefined),
    });
  }
  return client;
}

/**
 * @param {Uint8Array} audioBuffer
 */
async function* audioStream(audioBuffer) {
  const chunkSize = 4096;
  for (let index = 0; index < audioBuffer.length; index += chunkSize) {
    yield {
      AudioEvent: {
        AudioChunk: audioBuffer.subarray(index, index + chunkSize),
      },
    };
  }
}

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export async function handler(event) {
  let parsed;
  try {
    parsed = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const body =
    parsed && typeof parsed === "object"
      ? /** @type {{ audio?: unknown, mediaType?: unknown }} */ (parsed)
      : null;

  if (typeof body?.audio !== "string" || !body.audio.trim()) {
    return jsonResponse(400, { error: "missing_audio" });
  }

  try {
    const audioBuffer = Buffer.from(body.audio, "base64");
    const transcribe = getClient();
    /** @type {StartStreamTranscriptionCommandInput} */
    const commandParams = {
      LanguageCode: "en-US",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 16000,
      AudioStream: audioStream(audioBuffer),
    };

    if (process.env.AWS_TRANSCRIBE_VOCABULARY_NAME) {
      commandParams.VocabularyName = process.env.AWS_TRANSCRIBE_VOCABULARY_NAME;
    }

    const command = new StartStreamTranscriptionCommand(commandParams);
    const response = await transcribe.send(command);
    const transcriptStream = response.TranscriptResultStream;
    if (!transcriptStream) {
      throw new Error("No transcript stream returned by Transcribe.");
    }

    const finalParts = [];
    let lastPartial = "";
    for await (const eventPart of transcriptStream) {
      const results = eventPart.TranscriptEvent?.Transcript?.Results ?? [];
      for (const result of results) {
        const text = result.Alternatives?.[0]?.Transcript?.trim() || "";
        if (!text) continue;
        if (result.IsPartial) {
          lastPartial = text;
          continue;
        }
        finalParts.push(text);
      }
    }

    return jsonResponse(200, {
      text: (finalParts.join(" ").trim() || lastPartial).trim(),
    });
  } catch (error) {
    console.error("transcribe failed", error);
    return jsonResponse(502, {
      error: "transcribe_failed",
      message: "Voice transcription failed.",
    });
  }
}
