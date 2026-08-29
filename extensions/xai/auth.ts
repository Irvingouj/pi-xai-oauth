import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
  DEFAULT_XAI_MODEL,
  XAI_PROVIDER_ID,
} from "./constants";
import { ensureFreshXaiCredentials } from "./oauth";
import { getGrokAuthCredentials, writeDualAuthStores } from "./stores";

export { getGrokAuthCredentials } from "./stores";

/** Resolve an xAI OAuth access token from pi context or reusable Grok CLI credentials. */
export async function resolveXaiAuthToken(ctx: any): Promise<string | null> {
  const registryModel = ctx?.modelRegistry?.find?.(XAI_PROVIDER_ID, DEFAULT_XAI_MODEL);
  if (registryModel && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function") {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
    if (auth?.ok && auth.apiKey) return auth.apiKey;
    const authorization =
      auth?.ok && typeof auth.headers?.Authorization === "string" ? auth.headers.Authorization : "";
    if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice("bearer ".length);
  }
  if (ctx?.apiKey) return ctx.apiKey;

  const credentials = getGrokAuthCredentials();
  if (!credentials?.access) return null;

  const fresh = await ensureFreshXaiCredentials(credentials);
  writeDualAuthStores(fresh);
  return fresh.access;
}
