import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { getSupportedThinkingLevels, type RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register, { fetchModels, mapModel } from "../src/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const baseUrl = "https://router.example/v1";

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    baseUrl,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  };
}

test("maps current router capabilities and keeps an OpenAI wire envelope", () => {
  const model = mapModel({
    id: "ag/gemini-4",
    capabilities: { reasoning: true, vision: true, contextWindow: 1000000, maxOutput: 64000, thinkingFormat: "gemini-level", thinkingCanDisable: false },
    thinking_levels: ["low", "medium", "high"],
  }, baseUrl);
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 64000);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.compat?.thinkingFormat, "openai");
  assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high"]);
});

test("maps none to off and exposes xhigh/max only when advertised", () => {
  const model = mapModel({ id: "cx/gpt-6", capabilities: { reasoning: true }, thinking_levels: ["none", "low", "high", "xhigh", "max"] }, baseUrl);
  assert.equal(model.thinkingLevelMap?.off, "none");
  assert.equal(model.thinkingLevelMap?.max, "max");
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "high", "xhigh", "max"]);
});

test("supports binary thinking levels without sending a backend format", () => {
  const model = mapModel({ id: "glm", capabilities: { reasoning: true }, thinking_levels: ["none", "thinking"] }, baseUrl);
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
  assert.equal(model.thinkingLevelMap?.high, "high");
});

test("older routers retain defaults and cannot-disable capability", () => {
  const legacy = mapModel({ id: "legacy-model" }, baseUrl);
  assert.equal(legacy.reasoning, false);
  assert.equal(legacy.contextWindow, 128000);
  assert.equal(legacy.maxTokens, 4096);
  assert.equal(legacy.thinkingLevelMap, undefined);
  const always = mapModel({ id: "reasoner", capabilities: { thinkingCanDisable: false } }, baseUrl);
  assert.equal(always.thinkingLevelMap?.off, null);
});

test("reads new top-level limit aliases, clamps output and ignores invalid nested limits", () => {
  const model = mapModel({ id: "custom", context_length: "32,000", max_completion_tokens: 64000, capabilities: { contextWindow: Infinity, maxOutput: 0.2 } }, baseUrl);
  assert.equal(model.contextWindow, 32000);
  assert.equal(model.maxTokens, 32000);
  const explicit = mapModel({ id: "gemini-flash", capabilities: { reasoning: false, vision: false } }, baseUrl);
  assert.equal(explicit.reasoning, false);
  assert.deepEqual(explicit.input, ["text"]);
});

test("discovery honors pi's effective endpoint, credential and signal", async () => {
  const ctx = refreshContext({ baseUrl: "https://override.example/", credential: { type: "api_key", key: "test-key" } });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://override.example/v1/models");
    assert.equal(init?.signal, ctx.signal);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    return Response.json({ object: "list", data: [{ id: "ok" }, { name: "invalid" }, { id: " " }] });
  };
  const models = await fetchModels(ctx);
  assert.equal(models.length, 1);
  assert.equal(models[0].baseUrl, "https://override.example/v1");
});

test("discovery omits empty credentials and surfaces remote-auth failures", async () => {
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return new Response("API key required for remote API access", { status: 401 });
  };
  await assert.rejects(fetchModels(refreshContext()), /9router discovery failed: HTTP 401.*API key required/);
});

function captureTools() {
  const tools: ToolDefinition[] = [];
  register({
    on() {},
    registerProvider() {},
    registerTool(tool: ToolDefinition) { tools.push(tool); },
  } as unknown as ExtensionAPI);
  return tools;
}

function toolContext(): ExtensionToolContext {
  return {
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: "key", baseUrl: "https://effective.example/v1", headers: { "X-Custom": "yes", "X-Removed": null } } };
      },
      getProvider() { return { baseUrl }; },
    },
  } as unknown as ExtensionToolContext;
}

test("tools use native resolved endpoint/headers and honor cancellation", async () => {
  const search = captureTools().find((tool) => tool.name === "ninerouter_web_search")!;
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://effective.example/v1/models/web");
    assert.equal(new Headers(init?.headers).get("X-Custom"), "yes");
    assert.equal(new Headers(init?.headers).has("X-Removed"), false);
    assert.equal(init?.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  };
  const result = await search.execute("id", { query: "pi", search_type: "web" }, controller.signal, undefined, toolContext());
  assert.equal(result.isError, true);
});

test("large tool output is truncated with complete content saved to a private temp file", async () => {
  const tool = captureTools().find((entry) => entry.name === "ninerouter_web_fetch")!;
  const content = "line of page text\n".repeat(4000);
  globalThis.fetch = async (input) => String(input).endsWith("/models/web")
    ? Response.json({ data: [{ id: "exa/fetch", kind: "webFetch" }] })
    : Response.json({ url: "https://example.org", provider: "exa", content: { text: content } });
  const result = await tool.execute("id", { url: "https://example.org" }, undefined, undefined, toolContext());
  const text = result.content.find((block) => block.type === "text");
  assert.equal(text?.type, "text");
  if (text?.type !== "text") return;
  assert.ok(text.text.length < content.length);
  const path = /Full content saved to (.+)\]/.exec(text.text)?.[1];
  assert.ok(path);
  try {
    const full = await readFile(path, "utf8");
    assert.ok(full.includes(content.trim()));
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});
