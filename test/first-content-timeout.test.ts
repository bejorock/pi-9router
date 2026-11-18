import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, AssistantMessageEvent, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { FIRST_CONTENT_TIMEOUT_ERROR, FIRST_CONTENT_TIMEOUT_MS, guardProviderStreams } from "../src/stream-guard.ts";
import { mapModel } from "../src/index.ts";

const model = mapModel({ id: "deadline-probe" }, "http://localhost/v1");
const context = normalizeContext({ messages: [] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function partial(): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, model: model.id, provider: model.provider, stopReason: "pending", timestamp: Date.now(), usage: { input: 12, output: 0, totalTokens: 12, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function harness() {
  let childSignal: AbortSignal | undefined;
  let onTimeout: (() => void) | undefined;
  let cleared = false;
  let calls = 0;
  const inner = createAssistantMessageEventStream();
  const source = (_model: unknown, _context: unknown, opts?: StreamOptions) => {
    childSignal = opts?.signal;
    return inner; // intentionally ignores abort until tests release it
  };
  const api = guardProviderStreams({ stream: source, streamSimple: source }, () => 0, (callback, ms) => {
    assert.equal(ms, 240_000);
    calls++;
    onTimeout = callback;
    return () => { cleared = true; };
  });
  return { api, inner, fire() { if (!cleared) onTimeout?.(); }, get cleared() { return cleared; }, get calls() { return calls; }, get childSignal() { return childSignal; } };
}

for (const entry of ["stream", "streamSimple"] as const) {
  test(`${entry}: 240s before headers settles immediately, aborts child only, drops late events`, async () => {
    assert.equal(FIRST_CONTENT_TIMEOUT_MS, 240_000);
    const h = harness();
    const parent = new AbortController();
    const output = h.api[entry](model, context, { signal: parent.signal });
    h.fire(); // no native start/headers/event and no acknowledgement of abort
    const result = await output.result();
    const events = [];
    for await (const event of output) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(result.errorMessage, FIRST_CONTENT_TIMEOUT_ERROR);
    assert.equal(result.stopReason, "error");
    assert.equal(isRetryableAssistantError(result), true);
    assert.equal(result.provider, "9router");
    assert.equal(result.model, model.id);
    assert.deepEqual(result.content, []);
    assert.equal(h.childSignal?.aborted, true);
    assert.equal(parent.signal.aborted, false);
    assert.equal(h.cleared, true);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    h.inner.push({ type: "start", partial: partial() });
    h.inner.push({ type: "done", reason: "stop", message: { ...partial(), stopReason: "stop" } });
    h.inner.end();
    await tick();
    assert.equal(await output.result(), result);
  });
}

test("headers, starts, empty deltas and tool names do not count as first content; snapshots preserve usage", async () => {
  const h = harness();
  const output = h.api.stream(model, context);
  const message = partial();
  message.content = [{ type: "toolCall", id: "unfinished", name: "bash", arguments: {} }];
  h.inner.push({ type: "start", partial: message });
  h.inner.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) h.inner.push({ type, contentIndex: 0, delta: "", partial: message });
  await tick();
  assert.equal(h.cleared, false);
  h.fire();
  const result = await output.result();
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(result.errorMessage, FIRST_CONTENT_TIMEOUT_ERROR);
  message.content.length = 0;
  message.usage.input = 999;
  assert.equal(result.content.length, 1);
  assert.equal(result.usage.input, 12);
  const terminal = [];
  for await (const event of output) if (event.type === "done" || event.type === "error") terminal.push(event);
  assert.equal(terminal.length, 1);
  h.inner.end();
});

for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
  test(`${type}: first nonempty content permanently disarms deadline, including whitespace`, async () => {
    const h = harness();
    const output = h.api.stream(model, context);
    const message = partial();
    h.inner.push({ type: "start", partial: message });
    h.inner.push({ type, contentIndex: 0, delta: " ", partial: message });
    await tick();
    assert.equal(h.cleared, true);
    h.fire();
    assert.equal(h.childSignal?.aborted, false);
    assert.equal(h.calls, 1);
    const done: AssistantMessageEvent = { type: "done", reason: "stop", message: { ...message, stopReason: "stop" } };
    h.inner.push(done);
    h.inner.end();
    assert.equal((await output.result()).stopReason, "stop");
  });
}

for (const alreadyAborted of [false, true]) {
  test(`user cancellation remains non-retryable even with uncooperative adapter; pre-aborted=${alreadyAborted}`, async () => {
    const h = harness();
    const parent = new AbortController();
    if (alreadyAborted) parent.abort();
    const output = h.api.stream(model, context, { signal: parent.signal });
    parent.abort();
    h.fire();
    const result = await output.result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(isRetryableAssistantError(result), false);
    assert.equal(h.childSignal?.aborted, true);
    assert.equal(h.calls, alreadyAborted ? 0 : 1);
    h.inner.end();
  });
}

test("completed and failed native streams cancel deadline and keep original results", async () => {
  for (const failed of [false, true]) {
    const h = harness();
    const output = h.api.stream(model, context);
    const message = { ...partial(), stopReason: failed ? "error" as const : "stop" as const, ...(failed ? { errorMessage: "HTTP 401" } : {}) };
    h.inner.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
    h.inner.end();
    assert.equal(await output.result(), message);
    await tick();
    assert.equal(h.cleared, true);
    h.fire();
    assert.equal(h.childSignal?.aborted, false);
  }
});

test("production scheduler expires at exactly 240 seconds, not earlier", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const inner = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  const source = (_model: unknown, _context: unknown, opts?: StreamOptions) => { signal = opts?.signal; return inner; };
  const output = guardProviderStreams({ stream: source, streamSimple: source }).stream(model, context);
  t.mock.timers.tick(239_999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  const result = await output.result();
  assert.equal(signal?.aborted, true);
  assert.equal(result.errorMessage, FIRST_CONTENT_TIMEOUT_ERROR);
  inner.end();
});

test("synchronous setup failure clears deadline and preserves thrown error", () => {
  let cancelled = false;
  const error = new Error("missing auth");
  const source = () => { throw error; };
  const api: ProviderStreams = { stream: source, streamSimple: source };
  const guarded = guardProviderStreams(api, () => 0, () => () => { cancelled = true; });
  assert.throws(() => guarded.stream(model, context), e => e === error);
  assert.equal(cancelled, true);
});
