import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { isCliProxyRoutedModel, xaiBaseUrlForModel, xaiModelRequestHeaders } from "./models";
import { DEFAULT_XAI_MODEL } from "./constants";
import { rewriteXaiResponsesPayload } from "./payload";
import { isRetryableXaiStreamError, resolveXaiRetryPolicy, retryDelayMs, sleepAbortable } from "./retry";

type AssistantStreamEvent = Record<string, any>;

type OpenAIResponsesStreamSimple = (
  model: Model<"openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
) => AsyncIterable<AssistantStreamEvent> & { result?: () => Promise<any> };

/**
 * Resolve pi's OpenAI Responses streamSimple across loader environments:
 * - Pi jiti aliases `@earendil-works/pi-ai` → compat (exports streamSimpleOpenAIResponses)
 * - Plain Node resolves package root index (no legacy aliases) or the /api/* subpath
 */
async function loadStreamSimpleOpenAIResponses(): Promise<OpenAIResponsesStreamSimple> {
  const tryModule = async (specifier: string, exportName: string) => {
    try {
      const mod: any = await import(specifier);
      const fn = mod?.[exportName];
      return typeof fn === "function" ? (fn as OpenAIResponsesStreamSimple) : undefined;
    } catch {
      return undefined;
    }
  };

  return (
    (await tryModule("@earendil-works/pi-ai", "streamSimpleOpenAIResponses")) ||
    (await tryModule("@earendil-works/pi-ai/compat", "streamSimpleOpenAIResponses")) ||
    (await tryModule("@earendil-works/pi-ai/api/openai-responses", "streamSimple")) ||
    (() => {
      throw new Error(
        "Unable to load OpenAI Responses streamSimple from @earendil-works/pi-ai (root/compat/api)",
      );
    })()
  );
}

function resultFromStreamEvent(event: AssistantStreamEvent): any {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function createForwardingAssistantStream() {
  const queue: AssistantStreamEvent[] = [];
  const waiting: Array<(result: IteratorResult<AssistantStreamEvent>) => void> = [];
  let done = false;
  let resolveResult: (result: any) => void = () => {};
  const resultPromise = new Promise<any>((resolve) => {
    resolveResult = resolve;
  });

  function finish(result: any) {
    if (done) return;
    done = true;
    resolveResult(result);
  }

  return {
    push(event: AssistantStreamEvent) {
      const finalResult = resultFromStreamEvent(event);
      const isTerminal = event.type === "done" || event.type === "error";
      if (isTerminal) finish(finalResult);
      if (done && !isTerminal) return;
      const waiter = waiting.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end(result?: any) {
      finish(result);
      while (waiting.length > 0) {
        waiting.shift()?.({ value: undefined as any, done: true });
      }
    },
    result() {
      return resultPromise;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (done) {
          return;
        } else {
          const result = await new Promise<IteratorResult<AssistantStreamEvent>>((resolve) => waiting.push(resolve));
          if (result.done) return;
          yield result.value;
        }
      }
    },
  };
}

function streamErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return causeText && !error.message.includes(causeText) ? `${error.message}: ${causeText}` : error.message;
}

function streamErrorMessage(model: Model<Api>, error: unknown) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: streamErrorText(error),
    timestamp: Date.now(),
  };
}

function eventErrorText(event: AssistantStreamEvent): string {
  const err = event?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    if (typeof err.errorMessage === "string") return err.errorMessage;
    if (typeof err.message === "string") return err.message;
  }
  return "";
}

function isAborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

/**
 * Stream pi's simple Responses flow through xAI with payload normalization.
 *
 * The transport is delegated to pi's OpenAI Responses helper with a temporary
 * `openai-responses` API tag expected by pi's transport, while xAI
 * routing headers, request URLs, and payload rewriting continue to use the
 * original xAI model metadata. Returned events are forwarded through an
 * assistant stream exposing async iteration and `result()`. Delegate load or
 * stream failures are converted into terminal error events with xAI provider
 * metadata instead of escaping as unstructured promise failures.
 *
 * @param model xAI provider model selected by pi.
 * @param context Conversation messages and tool context to stream.
 * @param options Simple stream options, including OAuth token, session ID, cancellation, and payload hooks.
 * @returns A forwarding assistant stream compatible with pi's async iterator and `result()` contract.
 */
export function streamSimpleXaiResponses(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  // Prefer pi's stable session id for cache routing. For Grok CLI proxy only,
  // fall back to a per-stream id so x-grok-conv-id is always present.
  // Docs: Responses API uses body.prompt_cache_key; Chat Completions / CLI
  // proxy also benefit from the x-grok-conv-id header.
  // https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
  const sessionId = options?.sessionId;
  // Grok Build-only: always stamp a conversation id for the CLI proxy.
  const routingSessionId = sessionId || randomUUID();
  const streamModel = {
    ...model,
    // Coerce any stale/API model id onto a CLI-proxy model for headers/URL.
    id: isCliProxyRoutedModel(model.id) ? model.id : DEFAULT_XAI_MODEL,
    baseUrl: xaiBaseUrlForModel(model.id),
    headers: {
      ...(model as any).headers,
      ...xaiModelRequestHeaders(model.id, routingSessionId),
    },
  };
  // Keep the xAI stream model for routing/payload rewriting, but delegate with
  // the API tag expected by pi's OpenAI Responses transport.
  const openAIResponsesModel = {
    ...streamModel,
    api: "openai-responses" as const,
  };
  const headers = { ...(options?.headers || {}) };
  if (routingSessionId && !headers["x-grok-conv-id"]) headers["x-grok-conv-id"] = routingSessionId;
  if (routingSessionId && !headers["x-grok-session-id"]) headers["x-grok-session-id"] = routingSessionId;

  const stream = createForwardingAssistantStream();
  void (async () => {
    try {
      const streamSimpleOpenAIResponses = await loadStreamSimpleOpenAIResponses();
      const { maxAttempts, baseDelayMs } = resolveXaiRetryPolicy();
      let lastRetryableError: AssistantStreamEvent | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isAborted(options?.signal)) {
          const message = streamErrorMessage(model, Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
          return;
        }

        const inner = streamSimpleOpenAIResponses(openAIResponsesModel as Model<"openai-responses">, context, {
          ...options,
          // OpenAI SDK connection retries (before SSE starts). Default in pi-ai is 0.
          maxRetries: options?.maxRetries ?? 2,
          sessionId: sessionId || routingSessionId,
          headers,
          async onPayload(payload) {
            const rewritten = rewriteXaiResponsesPayload(payload, streamModel, {
              ...options,
              sessionId: sessionId || routingSessionId,
            });
            const userRewritten = await options?.onPayload?.(rewritten, streamModel);
            return userRewritten === undefined ? rewritten : userRewritten;
          },
        });

        const buffered: AssistantStreamEvent[] = [];
        let retryableError: AssistantStreamEvent | undefined;
        try {
          for await (const event of inner as AsyncIterable<AssistantStreamEvent>) {
            if (isAborted(options?.signal)) {
              const message = streamErrorMessage(model, Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
              message.stopReason = "aborted";
              stream.push({ type: "error", reason: "aborted", error: message });
              stream.end(message);
              return;
            }
            if (
              event.type === "error" &&
              attempt < maxAttempts &&
              isRetryableXaiStreamError(eventErrorText(event))
            ) {
              retryableError = event;
              break;
            }
            buffered.push(event);
            if (event.type === "done" || event.type === "error") break;
          }
        } catch (error) {
          const text = streamErrorText(error);
          if (attempt < maxAttempts && isRetryableXaiStreamError(text) && !isAborted(options?.signal)) {
            retryableError = { type: "error", reason: "error", error: streamErrorMessage(model, error) };
          } else {
            const message = streamErrorMessage(model, error);
            stream.push({ type: "error", reason: message.stopReason, error: message });
            stream.end(message);
            return;
          }
        }

        if (!retryableError) {
          for (const event of buffered) stream.push(event);
          stream.end();
          return;
        }

        lastRetryableError = retryableError;
        try {
          await sleepAbortable(retryDelayMs(attempt, baseDelayMs), options?.signal);
        } catch {
          const message = streamErrorMessage(model, Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
          return;
        }
      }
      if (lastRetryableError) stream.push(lastRetryableError);
      stream.end();
    } catch (error) {
      const message = streamErrorMessage(model, error);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
  })();
  return stream;
}
