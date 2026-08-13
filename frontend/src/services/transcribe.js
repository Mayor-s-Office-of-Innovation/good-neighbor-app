/*
  MOCK transcription. Phase 1 records audio locally and "transcribes on submit".
  Real live/streaming transcription is being designed in a separate session
  (reference: browser streams directly to Amazon Transcribe with short-lived STS
  creds — see notes/plans/lambda-transcription-client-direct.md).

  SWAP POINT: replace transcribe() with the real call. Same input (Blob) and
  output (string) means no UI change.
*/

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Blob} audioBlob
 * @returns {Promise<string>}
 */
export async function transcribe(audioBlob) {
  if (!audioBlob) return "";
  await delay(600);
  // Canned transcript; length nods to the recording size so it feels connected.
  const secs = Math.max(1, Math.round(audioBlob.size / 16000));
  return `(mock transcript, ~${secs}s) Noticed litter and some debris near the north entrance; will note it in the report.`;
}
