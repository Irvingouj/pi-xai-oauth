import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeXaiImageInput } from "./images";
import { DEFAULT_XAI_MODEL } from "./constants";
import {
  grokSupportsReasoningEffort,
  isCliProxyRoutedModel,
  isGrokCliProxyModel,
  xaiCatalogModel,
} from "./models";
import { textFromResponsesContent } from "./text";

const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

function thinkingMapFor(modelId: string): Record<string, string | null> | undefined {
  const map = xaiCatalogModel(modelId)?.thinkingLevelMap as Record<string, string | null> | undefined;
  return map && typeof map === "object" ? map : undefined;
}

/** Map a pi thinking level onto a wire effort Grok actually advertises. */
export function mapGrokReasoningEffort(modelId: string, effort: string): string | undefined {
  if (!effort || effort === "none" || effort === "off") return undefined;
  const map = thinkingMapFor(modelId);
  if (map && Object.prototype.hasOwnProperty.call(map, effort)) {
    const mapped = map[effort];
    if (typeof mapped === "string" && mapped) return mapped;
    if (mapped === null) return nearestSupportedEffort(map, effort);
  }
  if (effort === "minimal") return "low";
  if (effort === "max") {
    if (typeof map?.xhigh === "string") return map.xhigh;
    if (typeof map?.high === "string") return map.high;
    return "high";
  }
  return effort;
}

function nearestSupportedEffort(map: Record<string, string | null>, effort: string): string | undefined {
  const start = THINKING_LADDER.indexOf(effort as (typeof THINKING_LADDER)[number]);
  if (start === -1) return undefined;
  for (let i = start - 1; i >= 0; i--) {
    const candidate = THINKING_LADDER[i];
    const mapped = map[candidate];
    if (typeof mapped === "string" && mapped) return mapped;
  }
  for (let i = start + 1; i < THINKING_LADDER.length; i++) {
    const candidate = THINKING_LADDER[i];
    const mapped = map[candidate];
    if (typeof mapped === "string" && mapped) return mapped;
  }
  return undefined;
}

/**
 * Grok CLI (`apply_response_defaults`) always asks for encrypted reasoning on
 * Responses, then replays typed `reasoning` items with `encrypted_content`
 * verbatim. `status` is output-only and 400s on input; content parts need an
 * explicit `reasoning_text` type.
 */
function normalizeReasoningInputItem(item: Record<string, any>): Record<string, any> {
  const next: Record<string, any> = { ...item, type: "reasoning" };
  delete next.status;
  if (Array.isArray(next.content)) {
    next.content = next.content.map((part: unknown) => {
      if (!part || typeof part !== "object") return part;
      const obj = part as Record<string, any>;
      if (typeof obj.text === "string" && (typeof obj.type !== "string" || !obj.type)) {
        return { ...obj, type: "reasoning_text" };
      }
      return obj;
    });
  }
  return next;
}

function ensureEncryptedReasoningInclude(body: Record<string, any>, enabled: boolean): void {
  const include = Array.isArray(body.include) ? body.include.filter((item: unknown) => typeof item === "string") : [];
  const without = include.filter((item: string) => item !== ENCRYPTED_REASONING_INCLUDE);
  if (enabled) {
    body.include = [ENCRYPTED_REASONING_INCLUDE, ...without];
    return;
  }
  if (without.length > 0) body.include = without;
  else delete body.include;
}

function normalizeResponsesImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResponsesImageParts);
  if (!value || typeof value !== "object") return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }
  if (obj.type === "image_url") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }
  if (obj.type === "input_image") {
    const imageUrl = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.url : obj.image_url;
    const detail = typeof obj.image_url === "object" && obj.image_url ? obj.image_url.detail : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }
  if (Array.isArray(obj.content)) obj.content = normalizeResponsesImageParts(obj.content);
  if (Array.isArray(obj.output)) obj.output = normalizeResponsesImageParts(obj.output);
  return obj;
}

function isResponsesInputImagePart(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && (value as Record<string, any>).type === "input_image";
}

function textForFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return output === undefined || output === null ? "" : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isResponsesInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0) chunks.push(`[${imageCount} image${imageCount === 1 ? "" : "s"} attached in the following user message]`);
  return chunks.join("\n") || (imageCount > 0 ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]` : "");
}

function normalizeXaiResponsesInput(input: unknown[], model: Model<Api>): unknown[] {
  const normalizedInput = input.map(normalizeResponsesImageParts) as Record<string, any>[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input) ? ((model as any).input as unknown[]) : [];
  const supportsImages = modelInputs.includes("image");

  for (const item of normalizedInput) {
    if (!item || typeof item !== "object" || item.type !== "function_call_output" || !Array.isArray(item.output)) {
      rewritten.push(item);
      continue;
    }

    // xAI rejects OpenAI Responses' image-bearing tool replay shape:
    //   { type: "function_call_output", output: [{ type: "input_text" }, { type: "input_image" }] }
    // with a 422 ModelInput deserialization error. Keep the required tool
    // output as text and replay images as a normal following user message.
    const outputParts = item.output;
    const imageParts = outputParts.filter(isResponsesInputImagePart);
    const outputText = textForFunctionCallOutput(outputParts);
    rewritten.push({ ...item, output: outputText || "(tool returned no text output)" });

    if (supportsImages && imageParts.length > 0) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ""} included ${imageParts.length} image${imageParts.length === 1 ? "" : "s"}. Use the attached image${imageParts.length === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

/** Rewrite generic OpenAI Responses payloads into xAI-compatible payloads. */
export function rewriteXaiResponsesPayload(payload: unknown, model: Model<Api>, options?: SimpleStreamOptions): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };
  // This fork is cli-chat-proxy only: coerce any non-CLI model id onto the
  // provider default (grok-4.6) so we never open paid api.x.ai.
  let modelId = String(body.model || model.id);
  if (!isCliProxyRoutedModel(modelId)) {
    modelId = isCliProxyRoutedModel(model.id) ? model.id : DEFAULT_XAI_MODEL;
    body.model = modelId;
  }
  const usesGrokCliProxy = isGrokCliProxyModel(modelId);

  // xAI's Responses API matches the OpenAI surface but has a few stricter
  // edges than pi's generic OpenAI Responses serializer. Hermes solves the
  // same Grok OAuth path with top-level instructions; xAI also rejects
  // image arrays in function_call_output.output, so normalize those here.
  if (Array.isArray(body.input)) {
    let input = normalizeXaiResponsesInput([...body.input], model) as Record<string, any>[];
    const instructionParts: string[] = [];

    if (usesGrokCliProxy) {
      input = input.flatMap((item) => {
        if (!item || typeof item !== "object") return [item];
        if (item.type === "reasoning") {
          // Composer is a non-reasoner; never replay encrypted blobs into it.
          if (xaiCatalogModel(modelId)?.reasoning === false) return [];
          return [normalizeReasoningInputItem(item)];
        }
        if (typeof item.content === "string" && item.content.length === 0) return [];
        if (item.role !== "developer" && item.role !== "system") return [item];
        const text = textFromResponsesContent(item.content).trim();
        if (text) instructionParts.push(text);
        return [];
      });
    } else {
      while (input.length > 0) {
        const first = input[0];
        if (!first || typeof first !== "object" || (first.role !== "developer" && first.role !== "system")) break;
        const text = textFromResponsesContent(first.content).trim();
        if (text) instructionParts.push(text);
        input.shift();
      }
    }

    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts].filter((part) => typeof part === "string" && part).join("\n\n");
    }
    body.input = input;
  } else if (typeof body.input === "string") {
    // String input is valid and should stay string-shaped.
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = body.reasoning.effort;
    const mapped = typeof effort === "string" ? mapGrokReasoningEffort(modelId, effort) : undefined;
    if (mapped && grokSupportsReasoningEffort(modelId)) {
      // Grok CLI sends `{ effort, summary: "concise" }`. Keep summary if present;
      // otherwise omit it rather than inventing OpenAI's "auto".
      const next: Record<string, string> = { effort: mapped };
      if (typeof body.reasoning.summary === "string" && body.reasoning.summary) {
        next.summary = body.reasoning.summary === "auto" ? "concise" : body.reasoning.summary;
      }
      body.reasoning = next;
    } else {
      delete body.reasoning;
    }
  }

  // Match Grok CLI `apply_response_defaults` for reasoners: request encrypted
  // reasoning so the next turn can replay exact tokens. Skip non-reasoners
  // (Composer).
  ensureEncryptedReasoningInclude(body, usesGrokCliProxy && xaiCatalogModel(modelId)?.reasoning !== false);

  // xAI doesn't implement OpenAI's prompt_cache_retention knobs. Keep the
  // cache key (Responses API body field), but remove retention.
  // Docs: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  // prompt_cache_key routes a conversation to the same server so cache hits
  // are reliable; without it multi-turn agent loops often pay full input price.
  delete body.prompt_cache_retention;
  const cacheKey =
    (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) ||
    (typeof options?.sessionId === "string" && options.sessionId.trim()) ||
    "";
  if (cacheKey) body.prompt_cache_key = cacheKey;
  else delete body.prompt_cache_key;

  return body;
}
