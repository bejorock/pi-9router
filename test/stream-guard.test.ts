import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, AssistantMessageEvent, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { StreamDegenerationDetector, guardProviderStreams, REPETITION_ERROR } from "../src/stream-guard.ts";
import { mapModel } from "../src/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/argument-loop.json", import.meta.url), "utf8")) as { deltas: [number, string][] };

test("replays the actual incident chunking and timing, stopping near 52s instead of 300s", () => {
  const detector = new StreamDegenerationDetector();
  const trigger = fixture.deltas.find(([ms, delta]) => detector.observe(delta, ms));
  assert.ok(trigger);
  assert.ok(trigger[0] >= 50000 && trigger[0] <= 55000, String(trigger[0]));
});

function probe(text: string, chunkSize = 2) {
  const detector = new StreamDegenerationDetector();
  for (let i = 0; i < text.length; i += chunkSize) {
    if (detector.observe(text.slice(i, i + chunkSize), i * 20)) return true;
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

test("preserves structured repetition, evolving prose, Unicode and large single deltas", () => {
  const healthy = [
    '-'.repeat(30000), '. '.repeat(15000),
    'id,name,value\n' + '1,alpha,42\n'.repeat(6000),
    '{"items":[' + '{"id":1,"value":"same"},'.repeat(4000),
    'const value = 1;\n'.repeat(5000),
    '[1,2,3],'.repeat(6000),
    '👩‍💻 नमस्ते\u200c دنیا 中文\u200b。\n'.repeat(4000),
    Array.from({ length: 6000 }, (_, i) => `This is observation number ${i}. `).join(''),
    Array.from({ length: 6000 }, (_, i) => `echo file_${i}; `).join(''),
  ];
  for (const text of healthy) assert.equal(probe(text), false, text.slice(0, 50));
  const loop = '{"command":"' + ' t. '.repeat(10000);
  assert.equal(probe(loop, loop.length), false);
  assert.equal(probe(' t. '.repeat(400)), false, "short repeated sample");
});

test("intentionally detects long exact prose cycles even inside quotes, multiline payloads or arbitrary fields", () => {
  // These were exclusions in the bash-only guard. They are intentionally no
  // longer exemptions: sufficiently sustained identical prose is ambiguous.
  for (const pattern of ['abc ', 'this is a test. ', 'ab.   ', 'Это повтор. ']) {
    for (const prefix of ['{"other":"', '{"command":"ok","content":"', 'paragraph\n', 'printf "']) {
      assert.equal(probe(prefix + pattern.repeat(10000)), true, prefix + pattern);
    }
  }
});

test("replays real invisible-path incident well before watchdog, including escaped JSON and chunk rotation", () => {
  const invisible = JSON.parse(readFileSync(new URL('./fixtures/invisible-loop.json', import.meta.url), 'utf8')) as typeof fixture;
  const detector = new StreamDegenerationDetector();
  const trigger = invisible.deltas.find(([ms, delta]) => detector.observe(delta, ms));
  assert.ok(trigger);
  assert.ok(trigger[0] > 15000 && trigger[0] < 30000, String(trigger[0]));
  for (const pattern of ['\u200b', '\u200c\u200b', '\\u200b\\u200c']) {
    for (const size of [1, 2, 7, 64]) assert.equal(probe(pattern.repeat(15000), size), true, `${JSON.stringify(pattern)}/${size}`);
  }
});

test("requires sustained time and progress, and resets on a broken cycle", () => {
  const detector = new StreamDegenerationDetector();
  assert.equal(detector.observe('{"command":"' + ' t. '.repeat(1200), 0), false);
  for (let i = 1; i < 100; i++) assert.equal(detector.observe(' t. ', i), false);
  assert.equal(detector.observe('different!', 10000), false);
  assert.equal(detector.observe(' t. '.repeat(512), 10001), false);
  assert.equal(detector.observe(' t. ', 20000), false); // insufficient new events
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

test("a loop in an arbitrary write tool trips independently of healthy parallel tool", async () => {
  let clock = 0;
  const partial = message();
  partial.content.push({ type: "toolCall", id: "other", name: "write", arguments: {} });
  const source = (_model: unknown, _context: unknown, { signal }: StreamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial });
      for (const [ms, delta] of fixture.deltas) {
        clock = ms;
        // Tool names no longer grant exemptions; content indices stay isolated.
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "unique" + ms, partial });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) break;
      }
      stream.push({ type: "done", reason: "stop", message: partial });
      stream.end();
    })();
    return stream;
  };
  const result = await guardProviderStreams({ stream: source, streamSimple: source }, () => clock).stream(model, context).result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, REPETITION_ERROR);
});

test("answer and reasoning loops both cancel child and become native retryable errors", async () => {
  for (const channel of ["text_delta", "thinking_delta"] as const) {
    let clock = 0;
    let aborted = false;
    const source = (_model: unknown, _context: unknown, opts?: StreamOptions) => {
      const output = createAssistantMessageEventStream();
      const partial = message();
      partial.content = channel === "text_delta" ? [{ type: "text", text: "" }] : [{ type: "thinking", thinking: "" }];
      void (async () => {
        output.push({ type: "start", partial });
        for (let i = 0; i < 6000; i++) {
          clock = i * 20;
          output.push({ type: channel, contentIndex: 0, delta: "I keep repeating. ", partial });
          await new Promise<void>(resolve => setImmediate(resolve));
          if (opts?.signal?.aborted) { aborted = true; break; }
        }
        output.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
        output.end();
      })();
      return output;
    };
    const result = await guardProviderStreams({ stream: source, streamSimple: source }, () => clock).stream(model, context).result();
    assert.equal(aborted, true, channel);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, REPETITION_ERROR);
    assert.equal(isRetryableAssistantError(result), true);
  }
});

test("same-index channels and separate blocks do not pool progress; block boundaries clear state", async () => {
  let clock = 0;
  const partial = message();
  const source = () => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      output.push({ type: "start", partial });
      // Enough content for a candidate but fewer than 64 subsequent deltas per
      // channel/index. A shared detector would incorrectly pool these events.
      for (const contentIndex of [0, 1]) {
        for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
          output.push({ type, contentIndex, delta: ' t. '.repeat(1100), partial });
          for (let i = 0; i < 40; i++) {
            clock += 100;
            output.push({ type, contentIndex, delta: ' t. '.repeat(4), partial });
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
      }
      // Reuse the same index after each end. Each new block must start fresh.
      output.push({ type: "text_end", contentIndex: 0, content: "", partial });
      output.push({ type: "thinking_end", contentIndex: 0, content: "", partial });
      output.push({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "done", name: "find", arguments: {} }, partial });
      for (let i = 0; i < 40; i++) {
        clock += 100;
        for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
          output.push({ type, contentIndex: 0, delta: ' t. '.repeat(4), partial });
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Defensive start reset: index 1 still has its old candidates. A fresh
      // block start must reset them even if an adapter omitted the prior end.
      output.push({ type: "text_start", contentIndex: 1, partial });
      output.push({ type: "thinking_start", contentIndex: 1, partial });
      output.push({ type: "toolcall_start", contentIndex: 1, partial });
      for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
        output.push({ type, contentIndex: 1, delta: ' t. '.repeat(1100), partial });
        for (let i = 0; i < 40; i++) {
          clock += 100;
          output.push({ type, contentIndex: 1, delta: ' t. '.repeat(4), partial });
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      output.push({ type: "done", reason: "stop", message: partial });
      output.end();
    })();
    return output;
  };
  const result = await guardProviderStreams({ stream: source, streamSimple: source }, () => clock).stream(model, context).result();
  assert.equal(result.stopReason, "stop");
});

test("fixed guard error cannot be poisoned by command fragments matching billing exclusions", () => {
  const detector = new StreamDegenerationDetector();
  detector.observe('{"command":"echo billing quota exceeded; ', 0);
  let tripped = false;
  for (let i = 0; i < 4000; i++) {
    if (detector.observe(' t. ', i * 20)) { tripped = true; break; }
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
