#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const { createJiti } = require("jiti");

const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });
const extensionModule = jiti(path.join(repoRoot, "extensions", "xai-oauth.ts"));
const extension = extensionModule.default || extensionModule;
const originalFetch = global.fetch;
const requests = [];

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1:")) {
      return originalFetch(url, init);
    }

    if (href === "https://auth.x.ai/.well-known/openid-configuration") {
      return jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      });
    }

    if (href === "https://auth.x.ai/oauth2/token") {
      const params = new URLSearchParams(String(init.body || ""));
      requests.push({ url: href, body: Object.fromEntries(params) });
      return jsonResponse({
        access_token: `access-${params.get("code") || "refresh"}`,
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }

    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: href, headers: init.headers || {}, body, signal: init.signal });
    if (href.endsWith("/images/generations")) {
      return jsonResponse({ data: [{ url: "https://example.test/image.png" }] });
    }
    return jsonResponse({ id: "resp_test", output_text: "OK" });
  };
}

function restoreFetchMock() {
  global.fetch = originalFetch;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

function urlOriginIs(url, expectedOrigin) {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function loadExtension() {
  const providers = new Map();
  const tools = new Map();
  extension({
    registerProvider(name, config) {
      providers.set(name, config);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  return { providers, tools };
}

function authContext() {
  return {
    modelRegistry: {
      find(provider, modelId) {
        return { provider, id: modelId, headers: {} };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "oauth-token" };
      },
    },
  };
}

async function runTool(tools, name, params = {}, expectedText = "OK", requestOrigin = "https://api.x.ai") {
  const controller = new AbortController();
  const before = requests.length;
  const result = await tools.get(name).execute("call_test", params, controller.signal, () => {}, authContext());
  const request = requests.slice(before).find((entry) => entry.url && urlOriginIs(entry.url, requestOrigin));
  if (expectedText instanceof RegExp) {
    assert.match(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  } else {
    assert.equal(result.content[0].text, expectedText, `${name} should surface mocked xAI text`);
  }
  assert.ok(request, `${name} should send a request`);
  assert.equal(headerValue(request.headers, "Authorization"), "Bearer oauth-token", `${name} should use OAuth token from pi model registry`);
  assert.strictEqual(request.signal, controller.signal, `${name} should pass the pi cancellation signal`);
  return { body: request.body, request, result };
}

function lastResultErrorMessage(result) {
  return result && typeof result.errorMessage === "string" ? result.errorMessage : "";
}

async function captureStreamResultMessage(createStream) {
  try {
    const result = await createStream().result();
    return lastResultErrorMessage(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function verifyOpenAIResponsesTransport() {
  const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
  const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
  const baseModel = {
    id: "grok-4.3",
    provider: "xai-auth",
    baseUrl: "https://api.x.ai/v1",
    headers: {},
    reasoning: true,
    input: ["text", "image"],
  };

  const before = requests.length;
  await captureStreamResultMessage(() =>
    streamSimple({ ...baseModel, api: "openai-responses" }, context, { apiKey: "oauth-token" }),
  );
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "OpenAI Responses transport should reach the configured xAI endpoint",
  );
}

async function verifyXaiResponsesTransport(provider) {
  const before = requests.length;
  const message = await captureStreamResultMessage(() =>
    provider.streamSimple(
      {
        id: "grok-build",
        provider: "xai-auth",
        api: "xai-responses",
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
        headers: {},
        reasoning: true,
        input: ["text", "image"],
      },
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { apiKey: "oauth-token", sessionId: "guard-session" },
    ),
  );
  assert.ok(typeof message === "string", "xAI provider stream should expose a terminal result message");
  assert.ok(
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com")),
    "Grok Build stream should reach the Grok CLI proxy endpoint",
  );
}


function verifyXaiRetryClassification() {
  const { isRetryableXaiStreamError, resolveXaiRetryPolicy, retryDelayMs } = jiti(
    path.join(repoRoot, "extensions", "xai", "retry.ts"),
  );
  assert.equal(isRetryableXaiStreamError("Connection error."), true);
  assert.equal(isRetryableXaiStreamError("fetch failed"), true);
  assert.equal(isRetryableXaiStreamError("Error Code null: The model is currently at capacity due to high demand."), true);
  assert.equal(isRetryableXaiStreamError("503 Service Unavailable"), true);
  assert.equal(isRetryableXaiStreamError("Request was aborted"), false);
  assert.equal(isRetryableXaiStreamError("insufficient_quota"), false);
  assert.equal(isRetryableXaiStreamError("401 Unauthorized"), false);
  assert.equal(
    isRetryableXaiStreamError("Could not decrypt the provided encrypted_content"),
    false,
    "encrypted_content mismatch is a new-session error, never a retry",
  );
  const prevAttempts = process.env.PI_XAI_RETRY_ATTEMPTS;
  const prevBase = process.env.PI_XAI_RETRY_BASE_MS;
  process.env.PI_XAI_RETRY_ATTEMPTS = "5";
  process.env.PI_XAI_RETRY_BASE_MS = "1000";
  assert.deepEqual(resolveXaiRetryPolicy(), { maxAttempts: 5, baseDelayMs: 1000 });
  assert.ok(retryDelayMs(1, 1000) >= 1000);
  assert.ok(retryDelayMs(3, 1000) >= 4000);
  if (prevAttempts === undefined) delete process.env.PI_XAI_RETRY_ATTEMPTS;
  else process.env.PI_XAI_RETRY_ATTEMPTS = prevAttempts;
  if (prevBase === undefined) delete process.env.PI_XAI_RETRY_BASE_MS;
  else process.env.PI_XAI_RETRY_BASE_MS = prevBase;
}

function verifyGrok46CliProxyPayloadRewrite() {
  const { rewriteXaiResponsesPayload, mapGrokReasoningEffort } = jiti(
    path.join(repoRoot, "extensions", "xai", "payload.ts"),
  );
  const rewritten = rewriteXaiResponsesPayload(
    {
      model: "grok-4.6",
      include: ["file_search_call.results"],
      reasoning: { effort: "xhigh", summary: "auto" },
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "reasoning",
          id: "rs_test",
          encrypted_content: "enc_blob",
          status: "completed",
          content: [{ text: "hidden chain" }],
        },
        { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
    },
    { id: "grok-4.6", provider: "xai-auth", input: ["text", "image"] },
  );
  assert.equal(rewritten.reasoning?.effort, "xhigh", "Grok 4.6 should keep xhigh reasoning effort");
  assert.equal(rewritten.reasoning?.summary, "concise", "OpenAI summary=auto maps to Grok CLI concise");
  assert.deepEqual(
    rewritten.include,
    ["reasoning.encrypted_content", "file_search_call.results"],
    "Grok 4.6 must request reasoning.encrypted_content like Grok CLI apply_response_defaults",
  );
  const reasoning = (rewritten.input || []).find((item) => item && item.type === "reasoning");
  assert.ok(reasoning, "Grok 4.6 must replay typed reasoning items");
  assert.equal(reasoning.encrypted_content, "enc_blob", "encrypted_content must round-trip verbatim");
  assert.equal(reasoning.status, undefined, "status is output-only and must be stripped on input");
  assert.equal(reasoning.content[0].type, "reasoning_text", "reasoning content parts need an explicit type");

  const rewritten45 = rewriteXaiResponsesPayload(
    { model: "grok-4.5", reasoning: { effort: "xhigh" } },
    { id: "grok-4.5", provider: "xai-auth", input: ["text", "image"] },
  );
  assert.equal(rewritten45.reasoning?.effort, "high", "Grok 4.5 must clamp unsupported xhigh to high");
  assert.equal(mapGrokReasoningEffort("grok-4.5", "xhigh"), "high");
  assert.equal(mapGrokReasoningEffort("grok-4.6", "max"), "xhigh");
  assert.equal(mapGrokReasoningEffort("grok-4.7", "max"), "xhigh");
  assert.equal(mapGrokReasoningEffort("grok-4.7-build-fast", "xhigh"), "xhigh");

  const rewrittenComposer = rewriteXaiResponsesPayload(
    {
      model: "grok-composer-2.5-fast",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      input: [{ type: "reasoning", id: "rs_x", encrypted_content: "enc" }],
    },
    { id: "grok-composer-2.5-fast", provider: "xai-auth", input: ["text", "image"] },
  );
  assert.equal(rewrittenComposer.reasoning, undefined, "Composer must not send reasoning effort");
  assert.ok(
    !(rewrittenComposer.include || []).includes("reasoning.encrypted_content"),
    "Composer must not request encrypted reasoning",
  );
  assert.ok(
    !(rewrittenComposer.input || []).some((item) => item && item.type === "reasoning"),
    "Composer must not replay reasoning items",
  );
}

async function verifyCliModelStreamRouting(provider) {
  const composer = provider.models.find((model) => model.id === "grok-composer-2.5-fast");
  const model = {
    ...composer,
    provider: "xai-auth",
    api: provider.api,
    baseUrl: provider.baseUrl,
  };
  const before = requests.length;
  const stream = provider.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "oauth-token", sessionId: "session-test" },
  );
  await stream.result();
  const request = requests.slice(before).find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
  assert.ok(request, "Composer 2.5 provider streams should route to the Grok CLI endpoint");
  assert.equal(request.body.model, "grok-composer-2.5-fast");
  assert.equal(request.body.reasoning, undefined, "Composer 2.5 provider streams should not send reasoning effort");
  assert.ok(
    !(request.body.include || []).includes("reasoning.encrypted_content"),
    "Composer 2.5 is a non-reasoner and must not request encrypted reasoning",
  );
  assert.equal(headerValue(request.headers, "Authorization"), "Bearer oauth-token");
  assert.equal(headerValue(request.headers, "x-xai-token-auth"), "xai-grok-cli");
  assert.equal(headerValue(request.headers, "x-grok-model-override"), "grok-composer-2.5-fast");
  assert.equal(headerValue(request.headers, "x-grok-conv-id"), "session-test");

  const grok46 = provider.models.find((model) => model.id === "grok-4.6");
  const before46 = requests.length;
  const stream46 = provider.streamSimple(
    { ...grok46, provider: "xai-auth", api: provider.api, baseUrl: provider.baseUrl },
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "oauth-token", sessionId: "session-46" },
  );
  await stream46.result();
  const request46 = requests.slice(before46).find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
  assert.ok(request46, "Grok 4.6 should stream via cli-chat-proxy");
  assert.equal(request46.body.model, "grok-4.6");
  assert.equal(headerValue(request46.headers, "x-grok-model-override"), "grok-4.6");
  assert.equal(headerValue(request46.headers, "x-grok-client-version"), "1.0.5");
  assert.equal(headerValue(request46.headers, "x-grok-session-id"), "session-46");
  assert.ok(
    (request46.body.include || []).includes("reasoning.encrypted_content"),
    "Grok 4.6 live streams must request encrypted reasoning like Grok CLI",
  );

  const grok45 = provider.models.find((model) => model.id === "grok-4.5");
  const before45 = requests.length;
  const stream45 = provider.streamSimple(
    { ...grok45, provider: "xai-auth", api: provider.api, baseUrl: provider.baseUrl },
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "oauth-token", sessionId: "session-45" },
  );
  await stream45.result();
  const request45 = requests.slice(before45).find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
  assert.ok(request45, "Grok 4.5 should stream via cli-chat-proxy");
  assert.equal(request45.body.model, "grok-4.5");
  assert.equal(headerValue(request45.headers, "x-grok-model-override"), "grok-4.5");

  for (const id of ["grok-4.7", "grok-4.7-build-fast"]) {
    const catalog = provider.models.find((model) => model.id === id);
    const before = requests.length;
    const stream = provider.streamSimple(
      { ...catalog, provider: "xai-auth", api: provider.api, baseUrl: provider.baseUrl },
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { apiKey: "oauth-token", sessionId: `session-${id}` },
    );
    await stream.result();
    const request = requests.slice(before).find((entry) => entry.url && urlOriginIs(entry.url, "https://cli-chat-proxy.grok.com"));
    assert.ok(request, `${id} should stream via cli-chat-proxy`);
    assert.equal(request.body.model, id);
    assert.equal(headerValue(request.headers, "x-grok-model-override"), id);
    assert.ok(
      (request.body.include || []).includes("reasoning.encrypted_content"),
      `${id} live streams must request encrypted reasoning like Grok CLI`,
    );
  }
}

async function verifyOAuthCallbackState(provider) {
  let authUrl;
  const login = provider.oauth.login({
    onPrompt: async () => "n",
    onProgress: () => {},
    onAuth(auth) {
      authUrl = new URL(auth.url);
      const redirectUri = authUrl.searchParams.get("redirect_uri");
      const expectedState = authUrl.searchParams.get("state");
      setTimeout(async () => {
        const bad = new URL(redirectUri);
        bad.searchParams.set("code", "bad-code");
        bad.searchParams.set("state", "wrong-state");
        const badResponse = await originalFetch(bad);
        assert.equal(badResponse.status, 400, "bad OAuth state should be rejected without resolving login");

        const good = new URL(redirectUri);
        good.searchParams.set("code", "good-code");
        good.searchParams.set("state", expectedState);
        await originalFetch(good);
      }, 10);
    },
  });

  const credentials = await login;
  assert.equal(credentials.access, "access-good-code", "login should ignore the bad callback and exchange the good code");
  assert.ok(authUrl, "login should provide an authorization URL");
}

async function verifyOAuthManualRawCode(provider) {
  const rawCode = "bMmOusw8w9arz1aNEuDCY02jhiOs22O5j-92yEKTzMCbPShyToONJWSc2KITti2CgoM0clOeFMUosJm76y_2MA";
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 500);
  let authUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress: () => {},
      onAuth(auth) {
        authUrl = new URL(auth.url);
      },
      onManualCodeInput: async () => rawCode,
      signal: controller.signal,
    });

    assert.equal(credentials.access, `access-${rawCode}`, "raw pasted xAI authorization code should be accepted and exchanged");
    assert.ok(authUrl, "login should provide an authorization URL before accepting manual code");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function verifyOAuthManualCallbackUrlState(provider) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 500);
  let callbackUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress: () => {},
      onAuth(auth) {
        const authUrl = new URL(auth.url);
        callbackUrl = new URL(authUrl.searchParams.get("redirect_uri"));
        callbackUrl.searchParams.set("code", "manual-url-code");
        callbackUrl.searchParams.set("state", authUrl.searchParams.get("state"));
      },
      onManualCodeInput: async () => callbackUrl.toString(),
      signal: controller.signal,
    });

    assert.equal(credentials.access, "access-manual-url-code", "manual callback URL with matching state should be exchanged");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function verifyOAuthManualWrongStateIgnored(provider) {
  const progress = [];
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 5_000);
  let authUrl;

  try {
    const credentials = await provider.oauth.login({
      onPrompt: async () => "n",
      onProgress(message) {
        progress.push(message);
      },
      onAuth(auth) {
        authUrl = new URL(auth.url);
        const redirectUri = authUrl.searchParams.get("redirect_uri");
        const expectedState = authUrl.searchParams.get("state");
        setTimeout(async () => {
          const good = new URL(redirectUri);
          good.searchParams.set("code", "manual-wrong-state-fallback-good");
          good.searchParams.set("state", expectedState);
          await originalFetch(good);
        }, 10);
      },
      onManualCodeInput: async () => "code=bad-manual-state-code&state=wrong-state",
      signal: controller.signal,
    });

    assert.equal(credentials.access, "access-manual-wrong-state-fallback-good", "manual callback query with wrong state should be ignored");
    assert.ok(progress.some((message) => /OAuth state did not match/.test(message)), "wrong-state manual callback should log that it was ignored");
    assert.ok(authUrl, "login should provide an authorization URL");
  } finally {
    clearTimeout(abortTimer);
  }
}

async function main() {
  process.env.HOME = path.join(repoRoot, ".tmp-empty-home-for-tests");
  process.env.XAI_API_KEY = "must-not-be-used";
  // Keep mocked stream tests on a single attempt so backoff cannot stall CI.
  process.env.PI_XAI_RETRY_ATTEMPTS = process.env.PI_XAI_RETRY_ATTEMPTS || "1";
  process.env.PI_XAI_RETRY_BASE_MS = process.env.PI_XAI_RETRY_BASE_MS || "0";
  installFetchMock();

  try {
    const { providers, tools } = loadExtension();
    const secondLoad = loadExtension();
    const provider = providers.get("xai-auth");
    assert.ok(provider, "xai-auth provider should be registered");
    assert.equal(secondLoad.tools.size, tools.size, "extension reloads should register tools on the new pi API object");
    assert.equal(provider.api, "xai-responses");
    assert.equal(provider.baseUrl, "https://cli-chat-proxy.grok.com/v1", "provider base must be Grok CLI proxy");
    assert.equal(
      provider.models.length,
      6,
      "CLI proxy catalog: grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5, grok-build, grok-composer-2.5-fast",
    );
    const grok47 = provider.models.find((model) => model.id === "grok-4.7");
    assert.ok(grok47, "grok-4.7 should be registered via cli-chat-proxy");
    assert.equal(grok47?.name, "Grok 4.7");
    assert.equal(grok47?.contextWindow, 500_000);
    assert.equal(grok47?.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(grok47?.cost?.input, 2);
    const grok47Fast = provider.models.find((model) => model.id === "grok-4.7-build-fast");
    assert.ok(grok47Fast, "grok-4.7-build-fast should be registered via cli-chat-proxy");
    assert.equal(grok47Fast?.name, "Grok 4.7 Fast");
    assert.equal(grok47Fast?.contextWindow, 500_000);
    assert.equal(grok47Fast?.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(grok47Fast?.cost?.input, 4);
    assert.equal(grok47Fast?.cost?.output, 12);
    const grok46 = provider.models.find((model) => model.id === "grok-4.6");
    assert.ok(grok46, "grok-4.6 should be registered via cli-chat-proxy");
    assert.equal(grok46?.contextWindow, 500_000);
    assert.equal(grok46?.thinkingLevelMap?.off, null);
    assert.equal(grok46?.thinkingLevelMap?.xhigh, "xhigh");
    const grok45 = provider.models.find((model) => model.id === "grok-4.5");
    assert.ok(grok45, "grok-4.5 should remain registered via cli-chat-proxy");
    assert.equal(grok45?.contextWindow, 500_000);
    assert.equal(grok45?.thinkingLevelMap?.off, null);
    assert.equal(grok45?.thinkingLevelMap?.xhigh, null);
    assert.equal(provider.models.find((model) => model.id === "grok-build")?.contextWindow, 512_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.contextWindow, 200_000);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast")?.reasoning, false);
    for (const id of ["grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-multi-agent-0309"]) {
      assert.equal(provider.models.find((model) => model.id === id), undefined, `${id} must not be registered`);
    }
    // Paid API custom tools must not be registered.
    for (const name of [
      "xai_generate_text",
      "xai_web_search",
      "xai_x_search",
      "xai_code_execution",
      "xai_multi_agent",
      "xai_generate_image",
      "xai_deep_research",
      "xai_critique",
      "xai_analyze_image",
    ]) {
      assert.ok(!tools.has(name), `${name} must not be registered (API billing)`);
    }

    await verifyOpenAIResponsesTransport();
    await verifyXaiResponsesTransport(provider);

    await verifyCliModelStreamRouting(provider);
    verifyGrok46CliProxyPayloadRewrite();
    verifyXaiRetryClassification();

    await verifyOAuthCallbackState(provider);
    await verifyOAuthManualRawCode(provider);
    await verifyOAuthManualCallbackUrlState(provider);
    await verifyOAuthManualWrongStateIgnored(provider);

    console.log("verify-extension: ok");
  } finally {
    restoreFetchMock();
  }
}

main().catch((error) => {
  restoreFetchMock();
  console.error(error);
  process.exit(1);
});
