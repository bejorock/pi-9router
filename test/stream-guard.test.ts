import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, AssistantMessageEvent, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { ArgumentRepetitionDetector, guardProviderStreams, REPETITION_ERROR } from "../src/stream-guard.ts";
import { mapModel } from "../src/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/argument-loop.json", import.meta.url), "utf8")) as { deltas: [number, string][] };

test("replays the actual incident chunking and timing, stopping near 52s instead of 300s", () => {
  const detector = new ArgumentRepetitionDetector();
  const trigger = fixture.deltas.find(([ms, delta]) => detector.observe(delta, "bash", ms));
  assert.ok(trigger);
  assert.ok(trigger[0] >= 50000 && trigger[0] <= 55000, String(trigger[0]));
});

function probe(text: string, chunkSize = 2, toolName = "bash") {
  const detector = new ArgumentRepetitionDetector();
  for (let i = 0; i < text.length; i += chunkSize) {
    if (detector.observe(text.slice(i, i + chunkSize), toolName, i * 20)) return true;
  }
  return false;
}

test("detects period3/4/6 cycles regardless of chunk coalescing or phase", () => {
  for (const pattern of ["t. ", " t. ", "t.    "]) {
    for (const size of [1, 2, 64, 128]) {
      assert.equal(probe('{"command":"echo ' + pattern.repeat(12000), size), true, `${pattern}/${size}`);
    }
  }
});

test("does not flag healthy repetition, other tools, completed commands or large single deltas", () => {
  const commands = [
    'echo ' + '-'.repeat(30000),
    'echo ' + '. '.repeat(15000),
    'echo ' + 'abc '.repeat(10000),
    'echo ' + 'this is a test. '.repeat(6000),
    'echo ' + 'ab.   '.repeat(6000),
    'cat <<EOF\n' + ' t. '.repeat(10000),
    'printf "' + ' t. '.repeat(10000) + '"',
    "printf '" + ' t. '.repeat(10000) + "'",
    'python -c ' + '[1,2,3],'.repeat(6000),
    Array.from({ length: 6000 }, (_, i) => `echo file_${i}; `).join(''),
  ];
  for (const command of commands) assert.equal(probe(JSON.stringify({ command })), false, command.slice(0, 50));
  const loop = '{"command":"' + ' t. '.repeat(10000);
  assert.equal(probe(loop, loop.length), false);
  assert.equal(probe(loop, 2, "write"), false);
  assert.equal(probe(loop, 2, ""), false);
  assert.equal(probe('{"other":"' + ' t. '.repeat(10000)), false);
  assert.equal(probe('{"command":"echo ok","other":"' + ' t. '.repeat(10000)), false);
});

test("requires sustained time and progress, and resets on a broken cycle", () => {
  const detector = new ArgumentRepetitionDetector();
  assert.equal(detector.observe('{"command":"' + ' t. '.repeat(1200), "bash", 0), false);
  for (let i = 1; i < 100; i++) assert.equal(detector.observe(' t. ', "bash", i), false);
  assert.equal(detector.observe('different!', "bash", 10000), false);
  assert.equal(detector.observe(' t. '.repeat(512), "bash", 10001), false);
  assert.equal(detector.observe(' t. ', "bash", 20000), false); // insufficient new events
});

function message(): AssistantMessage {
  return { role: "assistant", content: [{ type: "toolCall", id: "unfinished", name: "bash", arguments: {} }], api: "openai-completions", provider: "9router", model: "probe", stopReason: "stop", timestamp: Date.now(), usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const model = mapModel({ id: "probe" }, "http://localhost/v1");
const context = normalizeContext({ messages: [] });

test("both entry points abort only child, emit one retryable error and preserve usage/options", async () => {
  for (const entry of ["stream", "streamSimple"] as const) {
    let clock = 0;
    let childAborts = 0;
    const parent = new AbortController();
    const onResponse = () => {};
    const api: ProviderStreams = {
      stream(_model, _ctx, opts) {
        assert.equal(opts?.onResponse, onResponse);
        assert.equal(opts?.maxRetries, 0);
        assert.notEqual(opts?.signal, parent.signal);
        const inner = createAssistantMessageEventStream();
        opts?.signal?.addEventListener("abort", () => { childAborts++; });
        void (async () => {
          const partial = message();
          inner.push({ type: "start", partial });
          for (const [ms, delta] of fixture.deltas) {
            clock = ms;
            inner.push({ type: "toolcall_delta", contentIndex: 0, delta, partial });
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (opts?.signal?.aborted) break;
          }
          partial.stopReason = "aborted";
          inner.push({ type: "error", reason: "aborted", error: partial });
          inner.end();
        })();
        return inner;
      },
      streamSimple(...args) { return this.stream(...args); },
      cancelDeferred: async () => {},
    };
    const guarded = guardProviderStreams(api, () => clock);
    assert.equal(guarded.cancelDeferred, api.cancelDeferred);
    const stream = guarded[entry](model, context, { signal: parent.signal, onResponse, maxRetries: 0 });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    assert.equal(events.filter((e) => e.type === "error").length, 1);
    assert.equal(events.some((e) => e.type === "done" || e.type === "toolcall_end"), false);
    assert.equal(result.errorMessage, REPETITION_ERROR);
    assert.equal(isRetryableAssistantError(result), true);
    assert.equal(result.usage.totalTokens, 16);
    assert.equal(parent.signal.aborted, false);
    assert.equal(childAborts, 1);
  }
});

test("parent cancellation wins even when guard has just fired", async () => {
  const parent = new AbortController();
  let clock = 0;
  const stream = (_model: unknown, _context: unknown, opts?: StreamOptions) => {
    const inner = createAssistantMessageEventStream();
    void (async () => {
      const partial = message();
      inner.push({ type: "start", partial });
      for (const [ms, delta] of fixture.deltas) {
        clock = ms;
        inner.push({ type: "toolcall_delta", contentIndex: 0, delta, partial });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (opts?.signal?.aborted) { parent.abort(); break; }
      }
      inner.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
      inner.end();
    })();
    return inner;
  };
  const result = await guardProviderStreams({ stream, streamSimple: stream }, () => clock).stream(model, context, { signal: parent.signal }).result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(isRetryableAssistantError(result), false);
});

test("healthy native events pass through unchanged, including provider errors", async () => {
  const partial = message();
  const original: AssistantMessageEvent[] = [{ type: "start", partial }, { type: "thinking_delta", contentIndex: 0, delta: ' t. '.repeat(20000), partial }, { type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: "HTTP 401" } }];
  const stream = () => { const output = createAssistantMessageEventStream(); for (const e of original) output.push(e); output.end(); return output; };
  const wrapped = guardProviderStreams({ stream, streamSimple: stream }).stream(model, context);
  const events = [];
  for await (const event of wrapped) events.push(event);
  assert.deepEqual(events, original);
  events.forEach((event, i) => assert.equal(event, original[i]));
});

test("parallel tool indices do not combine partial repeats or inherit tool names", async () => {
  let clock = 0;
  const partial = message();
  partial.content.push({ type: "toolCall", id: "other", name: "write", arguments: {} });
  const source = () => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial });
      for (const [ms, delta] of fixture.deltas) {
        clock = ms;
        // A real loop in a write payload must not arm bash's per-index detector.
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "unique" + ms, partial });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      stream.push({ type: "done", reason: "stop", message: partial });
      stream.end();
    })();
    return stream;
  };
  const result = await guardProviderStreams({ stream: source, streamSimple: source }, () => clock).stream(model, context).result();
  assert.equal(result.stopReason, "stop");
});

test("fixed guard error cannot be poisoned by command fragments matching billing exclusions", () => {
  const detector = new ArgumentRepetitionDetector();
  detector.observe('{"command":"echo billing quota exceeded; ', "bash", 0);
  let tripped = false;
  for (let i = 0; i < 4000; i++) {
    if (detector.observe(' t. ', "bash", i * 20)) { tripped = true; break; }
  }
  assert.equal(tripped, true);
  assert.equal(isRetryableAssistantError({ ...message(), stopReason: "error", errorMessage: REPETITION_ERROR }), true);
  assert.equal(REPETITION_ERROR.includes("billing"), false);
});

test("throws synchronous native setup failures unchanged and settles empty/throwing streams", async () => {
  const error = new Error("missing auth");
  const throws = () => { throw error; };
  assert.throws(() => guardProviderStreams({ stream: throws, streamSimple: throws }).stream(model, context), (e) => e === error);
  const empty = () => { const s = createAssistantMessageEventStream(); s.end(); return s; };
  const result = await guardProviderStreams({ stream: empty, streamSimple: empty }).stream(model, context).result();
  assert.equal(result.stopReason, "error");
  assert.equal(isRetryableAssistantError(result), true);
});
