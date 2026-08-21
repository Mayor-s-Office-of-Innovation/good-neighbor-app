import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import providerModule from "@aws-sdk/credential-provider-node";

const { defaultProvider } = providerModule;

const WHAT_KEYWORDS = [
  "trash",
  "garbage",
  "litter",
  "graffiti",
  "feces",
  "needle",
  "debris",
  "sidewalk",
  "street",
  "encampment",
  "tent",
  "dumping",
  "biohazard",
  "broken",
  "overflowing",
  "urine",
  "hazard",
  "blocked",
  "pothole",
  "weeds",
  "wall",
  "curb",
];

const WHERE_KEYWORDS = [
  "near",
  "by",
  "at",
  "on",
  "in front of",
  "behind",
  "next to",
  "between",
  "across from",
  "entrance",
  "exit",
  "gate",
  "corner",
  "north",
  "south",
  "east",
  "west",
  "left",
  "right",
  "curb",
  "sidewalk",
  "alley",
  "wall",
  "fence",
  "door",
  "stairs",
  "ramp",
  "parking lot",
  "street",
  "block",
];

/**
 * @typedef {object} DescriptionValidationResult
 * @property {boolean} accepted
 * @property {boolean} whatYouCanSee
 * @property {boolean} whereItIs
 * @property {string} message
 */

const LOCAL_STUB_MODEL_ID = "local-stub-model";

/** @type {BedrockRuntimeClient | undefined} */
let client;

/**
 * Lazily create the Bedrock runtime client with the configured profile.
 * @returns {BedrockRuntimeClient}
 */
function getClient() {
  if (!client) {
    const profile =
      process.env.BEDROCK_AWS_PROFILE || process.env.TRANSCRIBE_AWS_PROFILE;
    client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: defaultProvider(profile ? { profile } : undefined),
    });
  }
  return client;
}

/**
 * Whether local heuristic validation is allowed in this process.
 * @returns {boolean}
 */
function isLocalValidationAllowed() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BEDROCK_ALLOW_LOCAL_STUB === "true" ||
    process.env.IS_OFFLINE === "true" ||
    process.env.AWS_SAM_LOCAL === "true"
  );
}

/**
 * @param {string} text
 * @param {string} side
 * @returns {string}
 */
function buildPrompt(text, side) {
  return [
    "You validate short field descriptions for a street-conditions reporting app.",
    "Return JSON only with keys accepted, whatYouCanSee, whereItIs, message.",
    "Rules:",
    "1. whatYouCanSee is true only if the text describes observable street or site conditions relevant to cleanliness, safety, access, damage, obstructions, dumping, graffiti, or similar field issues.",
    "2. whereItIs is true only if the text includes location or spatial context about where the issue is.",
    "3. accepted is true only if both booleans are true.",
    "4. message should be short and user-facing. If rejected, say what is missing.",
    `Side context: ${side}.`,
    `Text: ${JSON.stringify(text)}`,
  ].join("\n");
}

/**
 * @param {any} result
 * @returns {DescriptionValidationResult}
 */
function normalizeResult(result) {
  const whatYouCanSee = Boolean(result?.whatYouCanSee);
  const whereItIs = Boolean(result?.whereItIs);
  const accepted = whatYouCanSee && whereItIs;
  const fallbackMessage = accepted
    ? "Description looks usable."
    : !whatYouCanSee
      ? "Add what you can see and where it is."
      : "Add where the issue is.";
  return {
    accepted,
    whatYouCanSee,
    whereItIs,
    message:
      typeof result?.message === "string" && result.message.trim()
        ? result.message.trim()
        : fallbackMessage,
  };
}

/**
 * @param {string} text
 * @returns {any}
 */
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in Bedrock response.");
  }
  return JSON.parse(match[0]);
}

/**
 * Local/dev fallback when `BEDROCK_MODEL_ID=local-stub-model`.
 * @param {string} text
 * @returns {DescriptionValidationResult}
 */
function heuristicValidate(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const whatYouCanSee = WHAT_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
  const whereItIs = WHERE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
  const accepted = whatYouCanSee && whereItIs;
  let message = "Description looks usable.";
  if (!whatYouCanSee && !whereItIs) {
    message = "Describe what you can see and where the issue is.";
  } else if (!whatYouCanSee) {
    message = "Describe the street condition or issue you can see.";
  } else if (!whereItIs) {
    message = "Add where the issue is located.";
  }
  return { accepted, whatYouCanSee, whereItIs, message };
}

/**
 * @param {{ text: string, side: string, modelId?: string, client?: Pick<BedrockRuntimeClient, "send"> }} params
 * @returns {Promise<DescriptionValidationResult>}
 */
export async function validateDescription({
  text,
  side,
  modelId = process.env.BEDROCK_MODEL_ID || LOCAL_STUB_MODEL_ID,
  client: providedClient,
}) {
  const configuredModelId = String(modelId || "").trim();
  if (!configuredModelId || configuredModelId === LOCAL_STUB_MODEL_ID) {
    if (!isLocalValidationAllowed()) {
      const error = new Error(
        "Description validation model is not configured.",
      );
      /** @type {Error & { code: string }} */ (error).code =
        "description_validation_not_configured";
      throw error;
    }
    return heuristicValidate(text);
  }

  const runtime = providedClient || getClient();
  const command = new ConverseCommand({
    modelId: configuredModelId,
    messages: [
      {
        role: "user",
        content: [{ text: buildPrompt(text, side) }],
      },
    ],
    inferenceConfig: {
      temperature: 0,
      maxTokens: 250,
    },
  });
  const response = await runtime.send(command);
  const outputText =
    response.output?.message?.content
      ?.map((item) => ("text" in item ? item.text : ""))
      .join("")
      .trim() || "";
  return normalizeResult(extractJson(outputText));
}
