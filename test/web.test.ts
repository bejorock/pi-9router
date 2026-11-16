import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  formatFetchResponse,
  formatSearchResponse,
  get_web_models,
  web_fetch,
  web_search,
  type FetchResult,
  type WebSearchResponse,
} from "../src/web.ts";

const BASE = "http://localhost:20128/v1";
const KEY = "test-key";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Install a fetch mock backed by a queue of responders. */
function mockFetch(...responders: Array<(call: FetchCall) => Response | Promise<Response>>): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    const responder = responders.shift();
    if (!responder) throw new Error(`unexpected fetch: ${call.url}`);
    return responder(call);
  }) as typeof fetch;
}

function headersOf(call: FetchCall): Record<string, string> {
  return { ...(call.init?.headers as Record<string, string> | undefined) };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* get_web_models                                                      */
/* ------------------------------------------------------------------ */

test("get_web_models reads /models/web, sends auth, and filters by kind", async () => {
  mockFetch(
    () =>
      json({
        object: "list",
        data: [
          { id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" },
          { id: "tavily/fetch", kind: "webFetch", object: "model", owned_by: "tavily" },
        ],
      }),
    () =>
      json({
        object: "list",
        data: [
          { id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" },
          { id: "tavily/fetch", kind: "webFetch", object: "model", owned_by: "tavily" },
        ],
      }),
  );

  const controller = new AbortController();
  const all = await get_web_models(BASE, KEY, undefined, { signal: controller.signal });
  assert.equal(all.data.length, 2);

  const search = await get_web_models(BASE, KEY, "webSearch");
  assert.deepEqual(search.data.map((m) => m.id), ["exa/search"]);

  assert.equal(calls[0].url, `${BASE}/models/web`);
  assert.equal(headersOf(calls[0]).Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init?.signal, controller.signal);
});

test("get_web_models omits empty Authorization and forwards custom headers", async () => {
  mockFetch(() => json({ object: "list", data: [] }));

  await get_web_models(BASE, "", undefined, { headers: { "X-Api-Key": "header-key" } });

  const headers = headersOf(calls[0]);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-Api-Key"], "header-key");
});

test("get_web_models surfaces HTTP errors", async () => {
  mockFetch(() => new Response("boom", { status: 503 }));

  await assert.rejects(get_web_models(BASE, KEY), /get_web_models failed: HTTP 503 — boom/);
});

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const searchResponse: WebSearchResponse = {
  query: "typescript",
  provider: "exa",
  answer: { source: "exa", text: "Synthesized answer", model: "exa/gpt-5" },
  results: [
    {
      url: "https://example.com/a",
      title: "Example A",
      snippet: "Snippet text",
      display_url: "example.com/a",
      favicon_url: null,
      position: 1,
      score: 0.9,
      published_at: "2026-01-02T00:00:00Z",
      content: { format: "text", text: "Full page text", length: 14 },
      provider_raw: null,
      citation: { provider: "exa", rank: 1, retrieved_at: "2026-01-02T00:00:00Z" },
      metadata: {
        author: "Alice",
        image_url: null,
        language: "en",
        source_type: "article",
      },
    },
  ],
};

test("formatSearchResponse includes the chat-search answer object", () => {
  const formatted = formatSearchResponse(searchResponse);

  assert.match(formatted, /Query: typescript/);
  assert.match(formatted, /Provider: exa/);
  assert.match(formatted, /Answer:\nSynthesized answer/);
  assert.match(formatted, /\[1\] Example A/);
  assert.match(formatted, /Snippet: Snippet text/);
  assert.match(formatted, /Author: Alice/);
});

test("formatSearchResponse still accepts string answers and null answers", () => {
  assert.match(
    formatSearchResponse({ ...searchResponse, answer: "legacy answer" }),
    /Answer:\nlegacy answer/,
  );
  assert.doesNotMatch(
    formatSearchResponse({ ...searchResponse, answer: null }),
    /Answer:/,
  );
});

test("formatSearchResponse tolerates object content on results", () => {
  const formatted = formatSearchResponse({
    ...searchResponse,
    answer: null,
    results: [{ ...searchResponse.results[0], content: null }],
  });

  assert.match(formatted, /URL: https:\/\/example\.com\/a/);
});

const fetchResult: FetchResult = {
  url: "https://example.com/a",
  title: "Example A",
  provider: "jina",
  content: { format: "markdown", text: "# Heading\n\nBody", length: 16 },
  metadata: { author: null, language: "en", published_at: null },
  usage: { fetch_cost_usd: 0.001 },
  metrics: { response_time_ms: 120, upstream_latency_ms: 100 },
};

test("formatFetchResponse renders content object text", () => {
  const formatted = formatFetchResponse(fetchResult);

  assert.match(formatted, /Title: Example A/);
  assert.match(formatted, /Provider: jina/);
  assert.match(formatted, /# Heading/);
  assert.match(formatted, /Body/);
});

test("formatFetchResponse tolerates null metadata and null content", () => {
  const formatted = formatFetchResponse({
    ...fetchResult,
    metadata: null,
    content: null,
  });

  assert.match(formatted, /URL: https:\/\/example\.com\/a/);
  assert.equal(formatted.includes("undefined"), false);
});

/* ------------------------------------------------------------------ */
/* web_search                                                          */
/* ------------------------------------------------------------------ */

test("web_search sends the upstream-accepted search body and parses content objects", async () => {
  mockFetch(() => json(searchResponse));

  const result = await web_search(BASE, KEY, {
    model: "exa",
    query: "typescript",
    search_type: "web",
    max_results: 5,
    country: "US",
  });

  assert.equal(result.answer && typeof result.answer === "object" ? result.answer.text : null, "Synthesized answer");
  assert.deepEqual(result.results[0].content, { format: "text", text: "Full page text", length: 14 });

  assert.equal(calls[0].url, `${BASE}/search`);
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    model: "exa",
    query: "typescript",
    search_type: "web",
    max_results: 5,
    country: "US",
  });
  assert.equal(headersOf(calls[0])["Content-Type"], "application/json");
  assert.equal(headersOf(calls[0]).Authorization, `Bearer ${KEY}`);
});

test("web_search falls back across discovered providers in order", async () => {
  mockFetch(
    () =>
      json({
        object: "list",
        data: [
          { id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" },
          { id: "tavily/search", kind: "webSearch", object: "model", owned_by: "tavily" },
        ],
      }),
    () => new Response("upstream down", { status: 500 }),
    () => json({ ...searchResponse, provider: "tavily" }),
  );

  const result = await web_search(BASE, KEY, { query: "q", search_type: "web" });

  assert.equal(result.provider, "tavily");
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(String(calls[1].init?.body)).model, "exa");
  assert.equal(JSON.parse(String(calls[2].init?.body)).model, "tavily");
});

test("web_search surfaces all-provider failures", async () => {
  mockFetch(
    () =>
      json({
        object: "list",
        data: [{ id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" }],
      }),
    () => new Response("nope", { status: 500 }),
  );

  await assert.rejects(
    web_search(BASE, KEY, { query: "q", search_type: "web" }),
    /All webSearch providers failed:\nexa: HTTP 500 — nope/,
  );
});

test("web_search passes the abort signal to discovery and requests", async () => {
  const controller = new AbortController();
  mockFetch(
    () =>
      json({
        object: "list",
        data: [{ id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" }],
      }),
    () => json(searchResponse),
  );

  await web_search(BASE, KEY, { query: "q", search_type: "web" }, { signal: controller.signal });

  assert.equal(calls[0].init?.signal, controller.signal);
  assert.equal(calls[1].init?.signal, controller.signal);
});

test("web_search throws before any request when the signal is already aborted", async () => {
  mockFetch();

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    web_search(BASE, KEY, { query: "q", search_type: "web" }, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(calls.length, 0);
});

test("web_search does not fall back after an abort", async () => {
  const controller = new AbortController();

  mockFetch(
    () =>
      json({
        object: "list",
        data: [
          { id: "exa/search", kind: "webSearch", object: "model", owned_by: "exa" },
          { id: "tavily/search", kind: "webSearch", object: "model", owned_by: "tavily" },
        ],
      }),
    () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  );

  await assert.rejects(
    web_search(BASE, KEY, { query: "q", search_type: "web" }, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  // discovery + first provider only: the second provider was never attempted
  assert.equal(calls.length, 2);
});

/* ------------------------------------------------------------------ */
/* web_fetch                                                           */
/* ------------------------------------------------------------------ */

test("web_fetch sends the upstream-accepted fetch body and parses content objects", async () => {
  mockFetch(() =>
    json({
      ...fetchResult,
      links: ["https://example.com/b"],
    }),
  );

  const result = await web_fetch(BASE, KEY, "https://example.com/a", "jina/fetch");

  assert.deepEqual(result.content, {
    format: "markdown",
    text: "# Heading\n\nBody",
    length: 16,
  });

  assert.equal(calls[0].url, `${BASE}/web/fetch`);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    model: "jina/fetch",
    url: "https://example.com/a",
  });
});

test("web_fetch falls back across discovered providers and forwards headers", async () => {
  mockFetch(
    () =>
      json({
        object: "list",
        data: [
          { id: "jina/fetch", kind: "webFetch", object: "model", owned_by: "jina" },
          { id: "tavily/fetch", kind: "webFetch", object: "model", owned_by: "tavily" },
        ],
      }),
    () => new Response("bad", { status: 502 }),
    () => json({ ...fetchResult, provider: "tavily" }),
  );

  const result = await web_fetch(BASE, KEY, "https://example.com/a", undefined, {
    headers: { "X-Trace": "abc" },
  });

  assert.equal(result.provider, "tavily");
  assert.equal(calls.length, 3);
  assert.equal(headersOf(calls[0])["X-Trace"], "abc");
  assert.equal(headersOf(calls[1])["X-Trace"], "abc");
  assert.equal(headersOf(calls[2])["X-Trace"], "abc");
  assert.equal(JSON.parse(String(calls[1].init?.body)).model, "jina");
  assert.equal(JSON.parse(String(calls[2].init?.body)).model, "tavily");
});

test("web_fetch passes the abort signal and stops fallback on abort", async () => {
  const controller = new AbortController();

  mockFetch(
    () =>
      json({
        object: "list",
        data: [
          { id: "jina/fetch", kind: "webFetch", object: "model", owned_by: "jina" },
          { id: "tavily/fetch", kind: "webFetch", object: "model", owned_by: "tavily" },
        ],
      }),
    () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  );

  await assert.rejects(
    web_fetch(BASE, KEY, "https://example.com/a", undefined, { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(calls[0].init?.signal, controller.signal);
  assert.equal(calls.length, 2);
});

test("apiKey overrides a caller-provided Authorization header", async () => {
  mockFetch(() => json(fetchResult));

  await web_fetch(BASE, KEY, "https://example.com/a", "jina/fetch", {
    headers: { authorization: "Bearer caller-key", "X-Trace": "abc" },
  });

  const headers = headersOf(calls[0]);
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["X-Trace"], "abc");
});
