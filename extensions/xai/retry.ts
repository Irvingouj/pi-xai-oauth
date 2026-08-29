/** Transient CLI-proxy / transport failures that should restart the stream. */
const RETRYABLE =
  /connection error|fetch failed|econnreset|socket hang up|other side closed|network error|undici|timed? out|timeout|terminated|overloaded|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|at capacity|high demand|stream ended|ended without|reset before headers|upstream.?connect/i;

const NON_RETRYABLE =
  /insufficient_quota|quota exceeded|out of budget|billing|unauthorized|invalid.?api.?key|401|403|422|aborted|encrypted_content/i;

export function isRetryableXaiStreamError(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  if (NON_RETRYABLE.test(trimmed)) return false;
  return RETRYABLE.test(trimmed);
}

export function resolveXaiRetryPolicy(): { maxAttempts: number; baseDelayMs: number } {
  const maxAttempts = positiveInt(process.env.PI_XAI_RETRY_ATTEMPTS, 5);
  const baseDelayMs = nonNegativeInt(process.env.PI_XAI_RETRY_BASE_MS, 1000);
  return { maxAttempts, baseDelayMs };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function retryDelayMs(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = baseDelayMs > 0 ? Math.floor(Math.random() * Math.min(250, baseDelayMs)) : 0;
  return exp + jitter;
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
