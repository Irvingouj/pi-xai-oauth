import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "./xai/auth";
import { XAI_API_BASE_URL, XAI_PROVIDER_ID } from "./xai/constants";
import { MODELS } from "./xai/models";
import { createXaiOAuth } from "./xai/oauth";
import { streamSimpleXaiResponses } from "./xai/responses";
import { registerXaiTools } from "./xai/tools";

/**
 * Local fork intent: OAuth + Grok 4.5 (and other API models) for pi.
 * No Cursor/Grok CLI tool shims — use pi's native grep/bash/read/…
 * Want Composer? Use Grok CLI, not this package.
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider(XAI_PROVIDER_ID, {
    name: "xAI (OAuth)",
    baseUrl: XAI_API_BASE_URL,
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: createXaiOAuth({ getExistingCredentials: getGrokAuthCredentials }) as any,
  });

  registerXaiTools(pi);
}
