import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCustomXaiTools } from "./custom-tools";

const xaiToolRegistrations = new WeakSet<object>();

/**
 * Register xAI-only tools (web search, multi-agent, etc.).
 *
 * Intentionally does NOT register Cursor/Grok CLI shims (Grep, Shell, Read, …).
 * Those exist for Composer/Grok Build in stock pi-xai-oauth; this local fork
 * is OAuth + Grok API models + pi native tools only.
 */
export function registerXaiTools(pi: ExtensionAPI) {
  if (xaiToolRegistrations.has(pi as object)) return;
  xaiToolRegistrations.add(pi as object);

  registerCustomXaiTools(pi);
}
