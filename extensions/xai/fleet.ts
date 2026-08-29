import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { XAI_PROVIDER_ID } from "./constants";
import { grokAuthPath, piAuthPath, readPiXaiCredentials, writeDualAuthStores } from "./stores";

export type XaiFleetRole = "source" | "replica";

export type XaiFleetConfig = {
  /** source = may refresh xAI + push; replica = pull first, never refresh while source reachable */
  role: XaiFleetRole;
  /** Mac (or other source): hosts to push dual auth to after refresh */
  pushTo?: string[];
  /** Station: scp source for dual auth, e.g. oujunyi@100.108.164.41 */
  pullFrom?: string;
  /** Extra ssh/scp args (BatchMode etc. are always included) */
  sshOpts?: string[];
  /** Optional identity file for pull/push (installed on replicas for Mac access) */
  identityFile?: string;
  /** Seconds for ConnectTimeout (default 5) */
  connectTimeoutSeconds?: number;
};

const FLEET_CONFIG_PATH = () => join(homedir(), ".pi", "agent", "xai-fleet.json");

export function loadFleetConfig(): XaiFleetConfig | null {
  const path = FLEET_CONFIG_PATH();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || (raw.role !== "source" && raw.role !== "replica")) return null;
    return raw as XaiFleetConfig;
  } catch {
    return null;
  }
}

function baseSshOpts(cfg: XaiFleetConfig): string[] {
  const timeout = cfg.connectTimeoutSeconds ?? 5;
  const opts = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeout}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (cfg.identityFile && existsSync(cfg.identityFile)) {
    opts.push("-i", cfg.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (Array.isArray(cfg.sshOpts)) opts.push(...cfg.sshOpts);
  return opts;
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * Push local dual auth files to every pushTo host.
 * Best-effort: logs nothing to stdout (extension context); failures are ignored per host.
 */
export function pushDualAuthToFleet(cfg: XaiFleetConfig = loadFleetConfig() || { role: "source" }): {
  ok: string[];
  failed: Array<{ host: string; error: string }>;
} {
  const hosts = cfg.pushTo || [];
  const ok: string[] = [];
  const failed: Array<{ host: string; error: string }> = [];
  if (!hosts.length) return { ok, failed };

  const pi = piAuthPath();
  const grok = grokAuthPath();
  if (!existsSync(pi)) {
    return { ok, failed: hosts.map((host) => ({ host, error: "local pi auth.json missing" })) };
  }

  const sshOpts = baseSshOpts(cfg);
  for (const host of hosts) {
    try {
      run("ssh", [...sshOpts, host, "mkdir -p ~/.pi/agent ~/.grok && chmod 700 ~/.pi/agent ~/.grok"]);
      run("scp", [...sshOpts, pi, `${host}:~/.pi/agent/auth.json`]);
      if (existsSync(grok)) {
        run("scp", [...sshOpts, grok, `${host}:~/.grok/auth.json`]);
      }
      run("ssh", [...sshOpts, host, "chmod 600 ~/.pi/agent/auth.json; [ -f ~/.grok/auth.json ] && chmod 600 ~/.grok/auth.json || true"]);
      ok.push(host);
    } catch (error) {
      failed.push({
        host,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok, failed };
}

/**
 * Pull dual auth from source host into local stores.
 * Returns pi xai-auth credentials after pull, or null on failure.
 */
export function pullDualAuthFromSource(cfg: XaiFleetConfig = loadFleetConfig() || { role: "replica" }): OAuthCredentials | null {
  const source = cfg.pullFrom;
  if (!source) return null;

  const sshOpts = baseSshOpts(cfg);
  const tmpDir = join(tmpdir(), `xai-fleet-pull-${process.pid}`);
  try {
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const remotePi = `${source}:.pi/agent/auth.json`;
    const remoteGrok = `${source}:.grok/auth.json`;
    const localPiTmp = join(tmpDir, "auth.json");
    const localGrokTmp = join(tmpDir, "grok-auth.json");

    run("scp", [...sshOpts, remotePi, localPiTmp]);
    try {
      run("scp", [...sshOpts, remoteGrok, localGrokTmp]);
    } catch {
      // grok file optional
    }

    // Validate pulled pi auth has xai-auth before replacing local.
    const pulled = JSON.parse(readFileSync(localPiTmp, "utf8"));
    const xa = pulled?.[XAI_PROVIDER_ID];
    if (!xa?.access || !xa?.refresh) {
      return null;
    }

    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true, mode: 0o700 });
    mkdirSync(join(homedir(), ".grok"), { recursive: true, mode: 0o700 });
    writeFileSync(piAuthPath(), readFileSync(localPiTmp), { mode: 0o600 });
    if (existsSync(localGrokTmp)) {
      writeFileSync(grokAuthPath(), readFileSync(localGrokTmp), { mode: 0o600 });
    }

    return readPiXaiCredentials();
  } catch {
    return null;
  }
}

/** After a successful local refresh on source: persist dual store + push fleet. */
export function onSourceCredentialsUpdated(credentials: OAuthCredentials): void {
  writeDualAuthStores(credentials);
  const cfg = loadFleetConfig();
  if (cfg?.role === "source" && cfg.pushTo?.length) {
    // Fire-and-forget style but sync here so the next station request sees it soon.
    // Failures must not break the refresh that already succeeded for Mac.
    try {
      pushDualAuthToFleet(cfg);
    } catch {
      // ignore
    }
  }
}
