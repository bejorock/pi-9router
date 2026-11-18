import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ProviderStreams, StreamFunction } from "@earendil-works/pi-ai";

/** Fixed text: generated snippets must not influence pi's retry classifier. */
export const REPETITION_ERROR = "upstream_stream_read_error: sustained repetitive generation detected locally; response discarded";
export const FIRST_CONTENT_TIMEOUT_MS = 240_000;
export const FIRST_CONTENT_TIMEOUT_ERROR = "upstream_stream_read_error: no model content received within 240 seconds; request cancelled locally";

/** Injectable scheduler for deterministic tests; production always uses 240s. */
type ScheduleDeadline = (callback: () => void, ms: number) => () => void;
const scheduleDeadline: ScheduleDeadline = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
const WINDOW = 2048;
const INVISIBLE_WINDOW = 512;

/**
 * A stream-behavior detector, not a semantic judge. Classifies only exact short
 * cycles: unstructured prose, or U+200B/U+200C runs (literal or JSON escaped).
 * State is bounded and independent for each content block and event channel.
 */
export class StreamDegenerationDetector {
  private tail = "";
  private total = 0;
  private deltas = 0;
  private candidate?: { since: number; chars: number; deltas: number; pattern: string; kind: string };

  observe(delta: string, now: number): boolean {
    if (!delta) return false;
    this.total += delta.length;
    this.deltas++;
    this.tail = (this.tail + delta).slice(-WINDOW);
    let pattern: string | undefined;
    let kind = "invisible";
    if (this.total >= 1024 && this.tail.length >= INVISIBLE_WINDOW) {
      const unit = minimalCycle(this.tail.slice(-INVISIBLE_WINDOW));
      if (unit && isInvisibleCycle(unit)) pattern = unit;
    }
    if (!pattern && this.total >= 4096 && this.tail.length === WINDOW) {
      const unit = minimalCycle(this.tail);
      // Deliberately exclude structural syntax, digits, newlines and punctuation
      // used in CSV/code/JSON. Genuine long repeated prose remains ambiguous.
      if (unit && /\p{L}/u.test(unit) && unit.includes(" ") && /^[\p{L}\p{M} .!?]+$/u.test(unit)) {
        pattern = unit;
        kind = "prose";
      }
    }
    if (!pattern) { this.candidate = undefined; return false; }
    // Chunk boundaries rotate the minimal cycle. Do not mix signatures.
    if (!this.candidate || this.candidate.kind !== kind || this.candidate.pattern.length !== pattern.length ||
        !(this.candidate.pattern + this.candidate.pattern).includes(pattern)) {
      this.candidate = { since: now, chars: this.total, deltas: this.deltas, pattern, kind };
      return false;
    }
    return now - this.candidate.since >= 3000 && this.total - this.candidate.chars >= 256 &&
      this.deltas - this.candidate.deltas >= 64;
  }
}

/** Prefix function: finds minimal period even when window size is not divisible by it. */
function minimalCycle(text: string): string | undefined {
  const prefix = new Uint16Array(text.length);
  for (let i = 1; i < text.length; i++) {
    let j = prefix[i - 1];
    while (j > 0 && text[i] !== text[j]) j = prefix[j - 1];
    if (text[i] === text[j]) j++;
    prefix[i] = j;
  }
  const period = text.length - prefix[text.length - 1];
  return period <= 64 && text.length >= period * 8 ? text.slice(0, period) : undefined;
}

function isInvisibleCycle(unit: string): boolean {
  if (/^[\u200b\u200c]+$/.test(unit)) return true;
  // A rotated raw-JSON cycle may begin/end midway through \u200b. Align a
  // repeated sample at an escape boundary before validating every character.
  const sample = unit.repeat(4);
  const first = sample.indexOf("\\");
  const last = sample.lastIndexOf("\\");
  return first >= 0 && last > first && /^(?:\\u200[bc]|[\u200b\u200c])+$/i.test(sample.slice(first, last));
}

/** Wrap both native entry points once; retain the adapter's parsing and hooks. */
export function guardProviderStreams(
  api: ProviderStreams,
  now: () => number = () => performance.now(),
  schedule: ScheduleDeadline = scheduleDeadline,
): ProviderStreams {
  function wrap<T extends StreamFunction>(stream: T): T {
    return ((model, context, options) => {
      // Preserve synchronous setup failures (e.g. missing authentication).
      const controller = new AbortController();
      const parent = options?.signal;
      const output = createAssistantMessageEventStream();
      const startedAt = Date.now();
      let partial: AssistantMessage | undefined;
      let terminal = false;
      let cancelDeadline: (() => void) | undefined;
      const cleanup = () => {
        cancelDeadline?.();
        cancelDeadline = undefined;
        parent?.removeEventListener("abort", abort);
      };
      const failImmediately = (errorMessage: string) => {
        if (terminal) return;
        terminal = true;
        cleanup();
        // Snapshot before abort: an uncooperative adapter may keep mutating its
        // message after the public result has settled. Never expose that alias.
        const failed: AssistantMessage = partial ? structuredClone(partial) : {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: startedAt, stopReason: "pending",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        failed.stopReason = parent?.aborted ? "aborted" : "error";
        failed.errorMessage = parent?.aborted ? "Request cancelled" : errorMessage;
        controller.abort(parent?.aborted ? parent.reason : new Error(failed.errorMessage));
        output.push({ type: "error", reason: failed.stopReason, error: failed });
        output.end();
      };
      const abort = () => failImmediately("Request cancelled");
      if (parent?.aborted) abort();
      else parent?.addEventListener("abort", abort, { once: true });
      // Arm before native setup, not after HTTP headers or an SSE start event.
      if (!terminal) cancelDeadline = schedule(() => failImmediately(FIRST_CONTENT_TIMEOUT_ERROR), FIRST_CONTENT_TIMEOUT_MS);
      let inner;
      try { inner = stream(model, context, { ...options, signal: controller.signal }); }
      catch (error) { cleanup(); throw error; }
      void (async () => {
        const detectors = new Map<string, StreamDegenerationDetector>();
        let tripped = false;
        const finish = (message: AssistantMessage) => {
          const failed: AssistantMessage = {
            ...message,
            content: structuredClone(message.content),
            stopReason: parent?.aborted ? "aborted" : "error",
            errorMessage: parent?.aborted ? "Request cancelled" : REPETITION_ERROR,
          };
          output.push({ type: "error", reason: failed.stopReason as "error" | "aborted", error: failed });
          terminal = true;
        };
        try {
          for await (const event of inner) {
            if (terminal) break; // late events after deadline/cancellation are discarded
            if (event.type === "done" || event.type === "error") {
              if (tripped) finish(event.type === "done" ? event.message : event.error);
              else { output.push(event); terminal = true; }
              break;
            }
            partial = event.partial;
            if (tripped) continue;
            if (event.type === "start") detectors.clear();
            if (event.type === "toolcall_start" || event.type === "text_start" || event.type === "thinking_start") {
              detectors.delete(`${event.type.replace("_start", "_delta")}:${event.contentIndex}`);
            }
            if (event.type === "toolcall_delta" || event.type === "text_delta" || event.type === "thinking_delta") {
              // Only actual content disarms the first-content deadline. Start,
              // empty deltas, response headers and SSE comments do not qualify.
              if (event.delta.length > 0) { cancelDeadline?.(); cancelDeadline = undefined; }
              const key = `${event.type}:${event.contentIndex}`;
              let detector = detectors.get(key);
              if (!detector) { detector = new StreamDegenerationDetector(); detectors.set(key, detector); }
              if (detector.observe(event.delta, now()) && !parent?.aborted) {
                tripped = true;
                controller.abort(new Error(REPETITION_ERROR));
                continue;
              }
            } else if (event.type === "toolcall_end" || event.type === "text_end" || event.type === "thinking_end") {
              detectors.delete(`${event.type.replace("_end", "_delta")}:${event.contentIndex}`);
            }
            output.push(event);
          }
          if (!terminal && !partial) throw new Error("upstream_stream_read_error: stream ended without terminal event");
          if (!terminal && partial) {
            if (tripped) finish(partial);
            else output.push({ type: "error", reason: parent?.aborted ? "aborted" : "error", error: {
              ...partial, stopReason: parent?.aborted ? "aborted" : "error", errorMessage: "upstream_stream_read_error: stream ended without terminal event",
            } });
          }
        } catch (error) {
          if (terminal) return;
          if (partial) {
            if (tripped) finish(partial);
            else output.push({ type: "error", reason: parent?.aborted ? "aborted" : "error", error: {
              ...partial, stopReason: parent?.aborted ? "aborted" : "error", errorMessage: String(error),
            } });
          } else {
            // Native adapter normally emits its own setup error, but ensure result()
            // still settles if a custom stream unexpectedly throws before start.
            output.push({ type: "error", reason: parent?.aborted ? "aborted" : "error", error: {
              role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: parent?.aborted ? "aborted" : "error", errorMessage: String(error), timestamp: Date.now(),
            } });
          }
        } finally {
          cleanup();
          output.end();
        }
      })();
      return output;
    }) as T;
  }
  return { ...api, stream: wrap(api.stream.bind(api)), streamSimple: wrap(api.streamSimple.bind(api)) };
}
