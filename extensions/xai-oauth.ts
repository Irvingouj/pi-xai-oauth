import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "./xai/auth";
import { XAI_CLI_BASE_URL, XAI_PROVIDER_ID } from "./xai/constants";
import { MODELS } from "./xai/models";
import { createXaiOAuth } from "./xai/oauth";
import { streamSimpleXaiResponses } from "./xai/responses";

/**
 * Local fork intent: SuperGrok cli-chat-proxy ONLY.
 *
 * - Models: grok-4.6 (default) + grok-4.5 + grok-build + grok-composer-2.5-fast
 * - Transport: cli-chat-proxy.grok.com (Grok CLI usage, not paid API)
 * - Reasoning: request + replay `reasoning.encrypted_content` like Grok CLI
 * - Uses pi's native tools
 * - No paid api.x.ai catalog models (4.3 / 4.20 multi-agent, etc.)
 * - No xai_* tools and no api.x.ai URLs in this package
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider(XAI_PROVIDER_ID, {
    name: "xAI (Grok Build OAuth)",
    baseUrl: XAI_CLI_BASE_URL,
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: createXaiOAuth({ getExistingCredentials: getGrokAuthCredentials }) as any,
  });

}
