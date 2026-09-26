import { DEFAULT_XAI_MODEL, XAI_CLI_BASE_URL, XAI_GROK_CLIENT_VERSION } from "./constants";

/**
 * Grok CLI proxy catalog (cli-chat-proxy.grok.com only — never api.x.ai).
 *
 * Matches models exposed by Grok CLI / Grok Build (see ~/.grok/models_cache.json).
 */
export const MODELS = [
  {
    id: "grok-4.7",
    name: "Grok 4.7",
    reasoning: true,
    input: ["text", "image"],
    // Short-context rates. At ≥200k prompt tokens xAI bills 2× (same shape as 4.6).
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
  {
    id: "grok-4.7-build-fast",
    name: "Grok 4.7 Fast",
    reasoning: true,
    input: ["text", "image"],
    // Same model on faster infra. Grok Build bills 2× the 4.7 short-context rates.
    cost: { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      // xAI treats xhigh as high on 4.5; omit so pi does not advertise it.
      xhigh: null,
    },
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 },
    contextWindow: 512_000,
    maxTokens: 30_000,
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5 Fast",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
];

const CLI_PROXY_MODEL_IDS = new Set([
  "grok-4.7",
  "grok-4.7-build-fast",
  "grok-4.6",
  "grok-4.5",
  "grok-build",
  "grok-composer-2.5-fast",
]);

/** True when this catalog model id is routed via cli-chat-proxy (all registered models). */
export function isCliProxyRoutedModel(modelId: string): boolean {
  return CLI_PROXY_MODEL_IDS.has(normalizedXaiModelId(modelId));
}

/** Normalize provider/model-prefixed xAI model ids for routing comparisons. */
export function normalizedXaiModelId(modelId: string): string {
  return (modelId || "").toLowerCase().split("/").pop() || "";
}

/**
 * True for every catalog model this fork sends through cli-chat-proxy.
 *
 * Payload rewrite uses this for CLI-proxy quirks (developer→instructions,
 * image tool-result shape). Reasoning items and `reasoning.encrypted_content`
 * are kept: Grok CLI (`xai-org/grok-build`) requests encrypted reasoning and
 * replays the typed items verbatim so the server can restore exact tokens.
 */
export function isGrokCliProxyModel(modelId: string): boolean {
  return isCliProxyRoutedModel(modelId);
}

/** Catalog entry for a (possibly provider-prefixed) xAI model id. */
export function xaiCatalogModel(modelId: string) {
  const normalized = normalizedXaiModelId(modelId);
  return MODELS.find((model) => model.id === normalized);
}

/** Resolve the base URL used by a model. Always CLI proxy for this fork. */
export function xaiBaseUrlForModel(_modelId: string): string {
  return XAI_CLI_BASE_URL;
}

/** Build Grok CLI proxy headers for Composer/Grok Build requests. */
export function grokCliProxyHeaders(modelId: string, sessionId?: string): Record<string, string> {
  const normalized = normalizedXaiModelId(modelId);
  const override = isCliProxyRoutedModel(normalized) ? normalized : DEFAULT_XAI_MODEL;
  const headers: Record<string, string> = {
    "x-grok-client-identifier": "pi-xai-oauth",
    "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-model-override": override,
  };
  if (sessionId) {
    headers["x-grok-conv-id"] = sessionId;
    headers["x-grok-session-id"] = sessionId;
  }
  return headers;
}

/** Build extra request headers needed for a given xAI model. Always CLI headers. */
export function xaiModelRequestHeaders(modelId: string, sessionId?: string): Record<string, string> {
  return grokCliProxyHeaders(modelId, sessionId);
}

/** Return true when xAI accepts an explicit Responses reasoning effort. */
export function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = normalizedXaiModelId(modelId);
  // Composer rejects reasoning effort; Grok Build is treated as CLI-managed.
  // Paid API models are not in this fork's catalog.
  return (
    normalized.startsWith("grok-3-mini") ||
    normalized.startsWith("grok-4.20-multi-agent") ||
    normalized.startsWith("grok-4.3") ||
    normalized.startsWith("grok-4.5") ||
    normalized.startsWith("grok-4.6") ||
    normalized.startsWith("grok-4.7")
  );
}
