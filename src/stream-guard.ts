import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ProviderStreams, StreamFunction } from "@earendil-works/pi-ai";

/** Fixed text: generated snippets must not influence pi's retry classifier. */
export const REPETITION_ERROR = "upstream_stream_read_error: sustained repetitive generation detected locally; response discarded";
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
export function guardProviderStreams(api: ProviderStreams, now: () => number = () => performance.now()): ProviderStreams {
  function wrap<T extends StreamFunction>(stream: T): T {
    return ((model, context, options) => {
      // Preserve synchronous setup failures (e.g. missing authentication).
      const controller = new AbortController();
      const parent = options?.signal;
      const abort = () => controller.abort(parent?.reason);
      if (parent?.aborted) abort();
      else parent?.addEventListener("abort", abort, { once: true });
      let inner;
      try { inner = stream(model, context, { ...options, signal: controller.signal }); }
      catch (error) { parent?.removeEventListener("abort", abort); throw error; }
      const output = createAssistantMessageEventStream();
      void (async () => {
        const detectors = new Map<string, StreamDegenerationDetector>();
        let partial: AssistantMessage | undefined;
        let tripped = false;
        let terminal = false;
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
          parent?.removeEventListener("abort", abort);
          output.end();
        }
      })();
      return output;
    }) as T;
  }
  return { ...api, stream: wrap(api.stream.bind(api)), streamSimple: wrap(api.streamSimple.bind(api)) };
}
