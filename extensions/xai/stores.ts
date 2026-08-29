import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  XAI_GROK_CLI_AUTH_SCOPE_KEY,
  XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_REFRESH_SKEW_MS,
  XAI_PROVIDER_ID,
} from "./constants";

export function piAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

export function grokAuthPath(): string {
  return join(homedir(), ".grok", "auth.json");
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read xai-auth credentials from pi's auth.json. */
export function readPiXaiCredentials(): OAuthCredentials | null {
  const path = piAuthPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const entry = data?.[XAI_PROVIDER_ID];
    if (!entry || typeof entry !== "object") return null;
    const access = String(entry.access || "");
    if (!access) return null;
    return {
      refresh: String(entry.refresh || ""),
      access,
      expires: typeof entry.expires === "number" ? entry.expires : undefined,
      tokenEndpoint: String(entry.tokenEndpoint || `${XAI_OAUTH_ISSUER}/oauth2/token`),
      tokenType: String(entry.tokenType || "Bearer"),
      idToken: String(entry.idToken || ""),
    };
  } catch {
    return null;
  }
}

/** Load reusable OAuth credentials from the official Grok CLI auth file. */
export function getGrokAuthCredentials(): OAuthCredentials | null {
  const authPath = grokAuthPath();
  if (!existsSync(authPath)) return null;

  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));

    const oidc = data?.[XAI_GROK_CLI_AUTH_SCOPE_KEY];
    if (oidc && typeof oidc === "object") {
      const access = String(oidc.key || oidc.access_token || oidc.token || "");
      if (access) {
        const expires = parseExpiry(oidc.expires_at) || Date.now() + 6 * 60 * 60 * 1000;
        return {
          refresh: String(oidc.refresh_token || oidc.refresh || ""),
          access,
          expires: expires - XAI_OAUTH_REFRESH_SKEW_MS,
          tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
          tokenType: "Bearer",
        };
      }
    }

    const legacy = data?.[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
    const legacyAccess =
      legacy && typeof legacy === "object" ? legacy.key || legacy.access_token || legacy.token : "";
    if (legacyAccess) {
      return {
        refresh: "",
        access: String(legacyAccess),
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
    }

    const topLevelAccess = data?.access_token || data?.token;
    if (topLevelAccess) {
      return {
        refresh: String(data.refresh_token || data.refresh || ""),
        access: String(topLevelAccess),
        expires: parseExpiry(data.expires_at || data.expires) || Date.now() + 30 * 24 * 60 * 60 * 1000,
        tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
        tokenType: String(data.token_type || "Bearer"),
      };
    }
  } catch {
    return null;
  }

  return null;
}

/** Collect unique refresh tokens from local dual store (pi first, then grok). */
export function listLocalRefreshTokens(primary?: string): string[] {
  const out: string[] = [];
  const add = (value?: string) => {
    const v = (value || "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  add(primary);
  add(readPiXaiCredentials()?.refresh);
  add(getGrokAuthCredentials()?.refresh);
  return out;
}

/**
 * Write credentials into BOTH local stores so Grok Build and pi stay aligned.
 * Best-effort: never throws.
 */
export function writeDualAuthStores(credentials: OAuthCredentials): void {
  try {
    writePiXaiCredentials(credentials);
  } catch {
    // ignore
  }
  try {
    writeGrokAuthCredentials(credentials);
  } catch {
    // ignore
  }
}

function writePiXaiCredentials(credentials: OAuthCredentials): void {
  const path = piAuthPath();
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true, mode: 0o700 });
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      data = {};
    }
  }
  const prev = (data[XAI_PROVIDER_ID] && typeof data[XAI_PROVIDER_ID] === "object"
    ? (data[XAI_PROVIDER_ID] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  data[XAI_PROVIDER_ID] = {
    ...prev,
    type: "oauth",
    access: credentials.access,
    refresh: credentials.refresh || prev.refresh || "",
    expires: credentials.expires ?? prev.expires,
    tokenEndpoint: credentials.tokenEndpoint || prev.tokenEndpoint || `${XAI_OAUTH_ISSUER}/oauth2/token`,
    tokenType: credentials.tokenType || prev.tokenType || "Bearer",
    ...(credentials.idToken ? { idToken: credentials.idToken } : {}),
  };
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function writeGrokAuthCredentials(credentials: OAuthCredentials): void {
  const path = grokAuthPath();
  mkdirSync(join(homedir(), ".grok"), { recursive: true, mode: 0o700 });
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      data = {};
    }
  }
  const scopeKey = XAI_GROK_CLI_AUTH_SCOPE_KEY;
  const prev = (data[scopeKey] && typeof data[scopeKey] === "object"
    ? (data[scopeKey] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  data[scopeKey] = {
    ...prev,
    key: credentials.access,
    refresh_token: credentials.refresh || prev.refresh_token || "",
    expires_at: credentials.expires
      ? new Date(credentials.expires).toISOString()
      : prev.expires_at || new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
