import { timingSafeEqual } from "node:crypto";
import { jsonResponse, readJsonBody } from "../http.js";
import { converse } from "./bedrock.js";
import { KNOWLEDGE_VERSION, sourceById } from "./knowledge.js";
import { LOCALES, SYSTEM_PROMPT } from "./prompt.js";

/** @param {unknown} value */
export function validateAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = /** @type {Record<string, any>} */ (value);
  if (Object.keys(result).sort().join() !== "answer,outcome,sourceIds")
    return null;
  if (!["answered", "unknown", "off_topic"].includes(result.outcome))
    return null;
  if (typeof result.answer !== "string" || !Array.isArray(result.sourceIds))
    return null;
  if (result.outcome !== "answered")
    return { outcome: result.outcome, answer: "", sources: [] };
  if (
    !result.answer.trim() ||
    result.answer.length > 1500 ||
    /[<>]|https?:\/\/|www\./i.test(result.answer)
  )
    return null;
  if (
    result.sourceIds.length < 1 ||
    result.sourceIds.length > 3 ||
    new Set(result.sourceIds).size !== result.sourceIds.length
  )
    return null;
  if (
    !result.sourceIds.every(
      (id) => typeof id === "string" && sourceById.has(id),
    )
  )
    return null;
  return {
    outcome: "answered",
    answer: result.answer.trim(),
    sources: result.sourceIds.map((id) => sourceById.get(id)),
  };
}

/** @param {string | undefined} actual @param {string | undefined} expected */
function originMatches(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Dependency injection keeps tests offline and never gives the model runtime tools.
 * @param {{invoke?:typeof converse, env?:NodeJS.ProcessEnv, log?:(entry:object)=>void}} [options]
 */
export function createSupportHandler({
  invoke = converse,
  env = process.env,
  log = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  /** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
  return async (event) => {
    if (env.SUPPORT_ENABLED !== "true")
      return jsonResponse(503, { error: "support_unavailable" });
    // Local harness supplies its own secret header; there is no runtime bypass.
    if (
      !originMatches(
        event.headers?.["x-support-origin"],
        env.SUPPORT_ORIGIN_TOKEN,
      )
    )
      return jsonResponse(403, { error: "support_forbidden" });
    if (event.requestContext?.http?.method !== "POST")
      return jsonResponse(405, { error: "method_not_allowed" });
    const raw = event.body || "";
    if (
      raw.length > 12000 ||
      Buffer.byteLength(
        event.isBase64Encoded ? Buffer.from(raw, "base64") : raw,
      ) > 8192
    )
      return jsonResponse(413, { error: "support_input_too_large" });
    let body;
    try {
      body = readJsonBody(event);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return jsonResponse(400, { error: "invalid_request" });
    const input = /** @type {Record<string, unknown>} */ (body);
    if (
      Object.keys(input).some((key) => !["question", "locale"].includes(key)) ||
      typeof input.question !== "string" ||
      !input.question.trim() ||
      input.question.length > 1000 ||
      typeof input.locale !== "string" ||
      !Object.hasOwn(LOCALES, input.locale)
    )
      return jsonResponse(400, { error: "invalid_request" });
    const region = env.AWS_REGION || "";
    const modelId = env.SUPPORT_MODEL_ID || "";
    if (
      !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
      !/^[a-zA-Z0-9.:-]+$/.test(modelId)
    )
      return jsonResponse(503, { error: "support_unavailable" });
    const started = Date.now();
    const controller = new globalThis.AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      // Race also bounds credential resolution, which does not accept a signal.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("support_timeout"));
        }, 15000);
      });
      const pending = invoke({
        region,
        modelId,
        signal: controller.signal,
        payload: {
          system: [{ text: SYSTEM_PROMPT }],
          messages: [
            {
              role: "user",
              content: [
                {
                  text: JSON.stringify({
                    language:
                      LOCALES[
                        /** @type {keyof typeof LOCALES} */ (input.locale)
                      ],
                    question: input.question.trim(),
                  }),
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 400, temperature: 0 },
        },
      });
      const response = /** @type {any} */ (
        await Promise.race([pending, deadline])
      );
      let answer = null;
      const content = response?.output?.message?.content;
      if (
        response?.stopReason === "end_turn" &&
        Array.isArray(content) &&
        content.length === 1 &&
        typeof content[0]?.text === "string" &&
        content[0].text.length <= 6000
      ) {
        try {
          answer = validateAnswer(JSON.parse(content[0].text));
        } catch {
          /* fixed fallback */
        }
      }
      log({
        marker: "SupportResponse",
        outcome: answer?.outcome || "invalid_output",
        durationMs: Date.now() - started,
        knowledgeVersion: KNOWLEDGE_VERSION,
        inputTokens: safeTokens(response?.usage?.inputTokens),
        outputTokens: safeTokens(response?.usage?.outputTokens),
      });
      return jsonResponse(200, {
        ...(answer || { outcome: "unknown", answer: "", sources: [] }),
        knowledgeVersion: KNOWLEDGE_VERSION,
      });
    } catch {
      log({
        marker: "SupportUnavailable",
        durationMs: Date.now() - started,
        knowledgeVersion: KNOWLEDGE_VERSION,
      });
      return jsonResponse(503, { error: "support_unavailable" });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** @param {unknown} value */
function safeTokens(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export const handler = createSupportHandler();
