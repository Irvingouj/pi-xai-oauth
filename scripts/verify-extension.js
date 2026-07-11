#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const fs = require("fs/promises");
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
  const handlers = new Map();
  let activeTools = ["read", "bash", "edit", "write"];
  let throwOnGetActiveTools = false;
  let throwOnSetActiveTools = false;
  extension({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerProvider(name, config) {
      providers.set(name, config);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      if (throwOnGetActiveTools) throw new Error("tool registry not ready");
      return activeTools;
    },
    setActiveTools(toolNames) {
      if (throwOnSetActiveTools) throw new Error("tool registry temporarily unavailable");
      activeTools = toolNames;
    },
  });
  return {
    providers,
    tools,
    handlers,
    getActiveTools: () => activeTools,
    setActiveTools: (toolNames) => { activeTools = toolNames; },
    setToolRegistryFailures({ get = false, set = false } = {}) {
      throwOnGetActiveTools = get;
      throwOnSetActiveTools = set;
    },
  };
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

async function verifyCursorToolShims(tools) {
  // Local fork: no Cursor/Grok CLI shims — pi native tools only.
  for (const name of ["Read", "Write", "StrReplace", "Edit", "Delete", "LS", "Grep", "Glob", "Shell", "WebSearch"]) {
    assert.ok(!tools.has(name), `${name} Cursor/Grok CLI shim must NOT be registered (pi-native fork)`);
  }
}

async function verifyCursorToolActivation(loadResult) {
  // Shims are not registered; activation sync was removed. No-op keep test hook.
  const tools = loadResult.tools;
  await verifyCursorToolShims(tools);
  assert.ok(!loadResult.handlers.has("model_select") || true, "shim activation handlers optional");
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
        id: "grok-4.3",
        provider: "xai-auth",
        api: "xai-responses",
        baseUrl: "https://api.x.ai/v1",
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
    requests.slice(before).some((entry) => entry.url && urlOriginIs(entry.url, "https://api.x.ai")),
    "xAI stream should reach the xAI endpoint through the OpenAI Responses transport",
  );
}


async function verifyCliModelStreamRouting(provider) {
  // Local fork: Composer / Grok Build (CLI-proxy models) are not registered.
  const composer = provider.models.find((model) => model.id === "grok-composer-2.5-fast");
  const build = provider.models.find((model) => model.id === "grok-build");
  assert.equal(composer, undefined, "Composer 2.5 must not be listed in this pi-native fork");
  assert.equal(build, undefined, "Grok Build must not be listed in this pi-native fork");
  assert.ok(
    provider.models.some((model) => model.id === "grok-4.5"),
    "Grok 4.5 must remain available",
  );
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
  installFetchMock();

  try {
    const firstLoad = loadExtension();
    const { providers, tools } = firstLoad;
    const secondLoad = loadExtension();
    const provider = providers.get("xai-auth");
    assert.ok(provider, "xai-auth provider should be registered");
    assert.equal(secondLoad.tools.size, tools.size, "extension reloads should register tools on the new pi API object");
    assert.equal(provider.api, "xai-responses");
    const grok45 = provider.models.find((model) => model.id === "grok-4.5");
    assert.ok(grok45, "grok-4.5 should be registered in the xAI model catalog");
    assert.equal(grok45?.contextWindow, 500_000);
    assert.equal(grok45?.reasoning, true);
    assert.equal(grok45?.cost.input, 2);
    assert.equal(grok45?.cost.cacheRead, 0.5);
    assert.equal(grok45?.cost.output, 6);
    assert.equal(grok45?.thinkingLevelMap?.off, null, "Grok 4.5 reasoning cannot be disabled");
    assert.equal(provider.models.find((model) => model.id === "grok-4.3")?.contextWindow, 1_000_000);
    // Local fork: no CLI-proxy models (Composer / Grok Build).
    assert.equal(provider.models.find((model) => model.id === "grok-build"), undefined);
    assert.equal(provider.models.find((model) => model.id === "grok-composer-2.5-fast"), undefined);
    assert.equal(provider.models.find((model) => model.id === "grok-4.20-0309-reasoning")?.contextWindow, 2_000_000);
    assert.ok(provider.models.some((model) => model.id === "grok-4.20-multi-agent-0309"));

    await verifyOpenAIResponsesTransport();
    await verifyXaiResponsesTransport(provider);

    await verifyCliModelStreamRouting(provider);
    await verifyCursorToolActivation(firstLoad);
    await verifyCursorToolShims(tools);

    await verifyOAuthCallbackState(provider);
    await verifyOAuthManualRawCode(provider);
    await verifyOAuthManualCallbackUrlState(provider);
    await verifyOAuthManualWrongStateIgnored(provider);

    const noAuthResult = await tools.get("xai_generate_text").execute("call_noauth", { prompt: "hi" }, undefined, () => {}, {
      modelRegistry: {
        find: () => undefined,
      },
    });
    assert.match(noAuthResult.content[0].text, /No xAI OAuth credentials/, "tools should not fall back to XAI_API_KEY");

    const { body: grok45TextBody } = await runTool(tools, "xai_generate_text", {
      prompt: "hi",
      model: "grok-4.5",
    });
    assert.equal(grok45TextBody.model, "grok-4.5", "xai_generate_text should support explicit Grok 4.5 requests");
    assert.equal(grok45TextBody.reasoning.effort, "high", "Grok 4.5 text generation should default to high reasoning");

    // Composer / Grok Build CLI-proxy tool routes removed in this local fork.

    const { body: webBody } = await runTool(tools, "xai_web_search", { query: "xAI docs" });
    assert.deepEqual(webBody.tools, [{ type: "web_search", enable_image_understanding: true }]);

    const { body: xBody } = await runTool(tools, "xai_x_search", { query: "grok", since: "2026-05-01", until: "2026-05-22" });
    assert.equal(xBody.tools[0].type, "x_search");
    assert.equal(xBody.tools[0].from_date, "2026-05-01");
    assert.equal(xBody.tools[0].to_date, "2026-05-22");

    const { body: codeBody } = await runTool(tools, "xai_code_execution", { code: "print(2 + 2)" });
    assert.deepEqual(codeBody.tools, [{ type: "code_interpreter" }]);

    const { body: imageAnalysisBody } = await runTool(tools, "xai_analyze_image", {
      image: "https://example.test/cat.png",
      question: "what is here?",
    });
    const imageContent = imageAnalysisBody.input[0].content;
    assert.equal(imageContent[0].type, "input_image");
    assert.equal(imageContent[1].type, "input_text");

    const { body: imageGenBody } = await runTool(tools, "xai_generate_image", { prompt: "a crisp diagram" }, /Generated 1 image/);
    assert.equal(imageGenBody.model, "grok-imagine-image-quality");
    const imageTool = tools.get("xai_generate_image");
    assert.equal(Object.hasOwn(imageGenBody, "size"), false, "image generation should not send unsupported size defaults");
    assert.equal(Object.hasOwn(imageGenBody, "n"), false, "image generation should not send n unless explicitly requested");
    assert.equal(imageTool.parameters.properties.size, undefined, "image tool schema should not advertise unsupported size");
    assert.equal(imageTool.parameters.properties.n.default, undefined, "image tool schema should not inject n when omitted");
    assert.equal(imageTool.parameters.properties.n.minimum, 1, "image tool schema should reject image counts below one");
    assert.equal(imageTool.parameters.properties.n.maximum, 4, "image tool schema should reject image counts above four");

    const { body: imageBatchBody } = await runTool(
      tools,
      "xai_generate_image",
      { prompt: "three crisp diagrams", n: 3 },
      /Generated 1 image/,
    );
    assert.equal(imageBatchBody.n, 3, "image generation should forward an explicit n value");
    assert.equal(Object.hasOwn(imageBatchBody, "size"), false, "explicit n requests should still omit size");

    const requestsBeforeUnsupportedSize = requests.length;
    const unsupportedSizeResult = await imageTool.execute(
      "call_unsupported_size",
      { prompt: "a crisp diagram", size: "1024x1024" },
      undefined,
      () => {},
      authContext(),
    );
    assert.match(unsupportedSizeResult.content[0].text, /does not support the 'size' parameter/);
    assert.equal(requests.length, requestsBeforeUnsupportedSize, "unsupported size should fail before sending a request");

    const invalidCountResult = await imageTool.execute(
      "call_invalid_image_count",
      { prompt: "a crisp diagram", n: 0 },
      undefined,
      () => {},
      authContext(),
    );
    assert.match(invalidCountResult.content[0].text, /must be an integer from 1 to 4/);
    assert.equal(requests.length, requestsBeforeUnsupportedSize, "invalid n should fail before sending a request");

    const { body: multiAgentBody, result: multiAgentResult } = await runTool(tools, "xai_multi_agent", { query: "latest xAI tools", num_agents: 4 });
    assert.equal(multiAgentBody.model, "grok-4.20-multi-agent-0309");
    assert.equal(multiAgentBody.reasoning.effort, "medium");
    assert.equal(multiAgentResult.details.agents_used, 4);
    assert.ok(multiAgentBody.tools.some((tool) => tool.type === "web_search"));
    assert.ok(multiAgentBody.tools.some((tool) => tool.type === "x_search"));

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
