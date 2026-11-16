import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ProviderStreams, StreamFunction } from "@earendil-works/pi-ai";

/** Fixed text: model-supplied snippets could interfere with pi's retry classifier. */
export const REPETITION_ERROR = "upstream_stream_read_error: repetitive tool arguments detected locally; incomplete call not executed";
const WINDOW = 2048;

/**
 * Deliberately narrow signature of the observed bash degeneration, not a general
 * entropy detector: an unfinished, single-line command string ends in a very
 * long exact cycle of short prose fragments (letters, spaces and periods).
 * Healthy repeated data, JSON arrays, heredocs, padding and other tools are not
 * classified. Even this signature cannot prove intent; bounded native retries
 * contain false positives. Memory is bounded independently of generation length.
 */
export class ArgumentRepetitionDetector {
  private tail = "";
  private prefix = "";
  private total = 0;
  private deltas = 0;
  private inString = false;
  private escaped = false;
  private excluded = false;
  private quotes = 0;
  private quotedLiteral = false;
  private singleQuotedLiteral = false;
  private candidate?: { since: number; chars: number; deltas: number; pattern: string };

  observe(delta: string, toolName: string, now: number): boolean {
    if (!delta) return false;
    this.total += delta.length;
    this.deltas++;
    this.prefix = (this.prefix + delta).slice(0, 128);
    // Scan raw JSON, not parsed partial arguments (pi only finalizes those at end).
    for (const char of delta) {
      if (char === "\n" || char === "\r" || (this.escaped && char === "n")) this.excluded = true;
      if (this.escaped) {
        // Encoded double quotes usually delimit quoted shell/data literals. Do
        // not interrupt while such a literal is open (conservative opt-out).
        if (char === '"') this.quotedLiteral = !this.quotedLiteral;
        this.escaped = false;
        continue;
      }
      if (this.inString && char === "\\") { this.escaped = true; continue; }
      if (this.inString && char === "'") this.singleQuotedLiteral = !this.singleQuotedLiteral;
      if (char === '"') {
        this.inString = !this.inString;
        if (++this.quotes >= 4) this.excluded = true; // command value already closed
      }
    }
    this.tail = (this.tail + delta).slice(-WINDOW);
    if (toolName !== "bash" || this.excluded || this.quotedLiteral || this.singleQuotedLiteral || !this.inString || this.escaped ||
        !/^\s*\{\s*"command"\s*:\s*"/.test(this.prefix) || this.total < 4096 || this.tail.length < WINDOW) {
      this.candidate = undefined;
      return false;
    }
    const pattern = periodicFragment(this.tail);
    if (!pattern) { this.candidate = undefined; return false; }
    // Phase can rotate between deltas. Compare cycles up to rotation.
    if (!this.candidate || !(this.candidate.pattern + this.candidate.pattern).includes(pattern) ||
        this.candidate.pattern.length !== pattern.length) {
      this.candidate = { since: now, chars: this.total, deltas: this.deltas, pattern };
      return false;
    }
    return now - this.candidate.since >= 3000 && this.total - this.candidate.chars >= 256 &&
      this.deltas - this.candidate.deltas >= 64;
  }
}

function periodicFragment(tail: string): string | undefined {
  // Compare offsets, not whole repeated copies: the window need not divide the period.
  for (let period = 1; period <= 8; period++) {
    let matches = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i - period]) { matches = false; break; }
    }
    if (!matches) continue;
    const unit = tail.slice(0, period);
    // Minimal periods 1/2 and punctuation-only padding are not this incident.
    if (period < 3 || !/^[A-Za-z .]+$/.test(unit) || (unit.match(/[A-Za-z]/g)?.length ?? 0) !== 1 ||
        (unit.match(/\./g)?.length ?? 0) !== 1 || !/ /.test(unit)) return;
    return unit;
  }
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
        const detectors = new Map<number, ArgumentRepetitionDetector>();
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
            if (event.type === "toolcall_delta") {
              let detector = detectors.get(event.contentIndex);
              if (!detector) { detector = new ArgumentRepetitionDetector(); detectors.set(event.contentIndex, detector); }
              const block = event.partial.content[event.contentIndex];
              if (detector.observe(event.delta, block?.type === "toolCall" ? block.name : "", now()) && !parent?.aborted) {
                tripped = true;
                controller.abort(new Error(REPETITION_ERROR));
                continue;
              }
            } else if (event.type === "toolcall_end") detectors.delete(event.contentIndex);
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
