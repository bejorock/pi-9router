import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Actual pi + native HTTP adapter + production guard, with only its scheduler
// accelerated. No artificial provider errors; the first upstream request stalls.
for (const scenario of [
  { kind: "before-headers", enabled: true, always: false },
  { kind: "keepalives", enabled: true, always: false },
  { kind: "before-headers", enabled: false, always: false },
  { kind: "keepalives", enabled: true, always: true },
  { kind: "content", enabled: true, always: false },
]) {
  test(`first-content deadline: actual pi ${scenario.kind} enabled=${scenario.enabled} always=${scenario.always}`, { timeout: 20000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-first-content-"));
    let requests = 0, cancelled = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer);
      return timer;
    };
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.aborted || !raw) { response.destroy(); return; }
      requests++;
      const send = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: "deadline", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      response.once("close", () => { if (!response.writableEnded) cancelled++; });
      if (scenario.kind === "content" || (requests > 1 && !scenario.always)) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        // Content arrives before 500ms, but completion comes afterwards. A
        // total-duration or idle-after-first-content timeout would be wrong.
        send({ role: "assistant", content: "RECOVERED" });
        later(() => { if (!response.destroyed) { send({}, "stop"); response.end("data: [DONE]\n\n"); } }, 800);
        return;
      }
      if (scenario.kind === "keepalives") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        send({ role: "assistant", content: "" });
        const ping = () => { if (!response.destroyed) { response.write(": bili-keepalive\n\n"); later(ping, 30); } };
        ping();
      }
      // Deliberately never finish or produce content. Guard must cancel HTTP.
    });
    let child: ReturnType<typeof spawn> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let generationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const model = { id: "probe", name: "Probe", provider: "9router", baseUrl, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: scenario.enabled, maxRetries: 1, baseDelayMs: 10, provider: { maxRetries: 0 } } }));
      await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { "9router": { baseUrl } } }));
      await writeFile(join(directory, "models-store.json"), JSON.stringify({ "9router": { checkedAt: Date.now(), models: [model] } }));
      const extension = join(directory, "accelerated.ts");
      await writeFile(extension, `
import register from ${JSON.stringify(resolve("src/index.ts"))};
import { guardProviderStreams } from ${JSON.stringify(resolve("src/stream-guard.ts"))};
export default function(pi) {
  register(new Proxy(pi, { get(target, key) {
    if (key !== "registerProvider") return Reflect.get(target, key);
    return (provider) => {
      const guarded = guardProviderStreams({ stream: provider.stream.bind(provider), streamSimple: provider.streamSimple.bind(provider) }, () => performance.now(), (callback, ms) => {
        if (ms !== 240000) throw new Error("unexpected production deadline");
        const timer = setTimeout(callback, 500);
        return () => clearTimeout(timer);
      });
      target.registerProvider({ ...provider, ...guarded });
    };
  } }));
}
`);
      child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--offline", "--no-extensions", "-e", extension, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--tools", "bash", "--api-key", "dummy", "--model", "9router/probe", "--thinking", "off", "--mode", "json", "-a", "-p", "Reply RECOVERED."], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
      const events: any[] = [];
      let buffer = "", stderr = "", watchdogExpired = false;
      // Match pi-workflow's lifecycle: assistant start arms a generation
      // deadline, assistant end clears it. Scaled 1200ms vs guard 500ms.
      const arm = () => { clearTimeout(generationTimer); generationTimer = setTimeout(() => { watchdogExpired = true; child?.kill("SIGKILL"); }, 1200); };
      child.stdout!.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.startsWith("{")) continue;
          const event = JSON.parse(line); events.push(event);
          if (event.type === "agent_start") arm();
          if (event.type === "message_start" && event.message?.role === "assistant") arm();
          if (event.type === "message_end" && event.message?.role === "assistant") clearTimeout(generationTimer);
        }
      });
      child.stderr!.on("data", chunk => { stderr += chunk; });
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 15000);
      const exit = await new Promise<number | null>((done, reject) => { child!.once("error", reject); child!.once("close", done); });
      assert.equal(watchdogExpired, false, "failed completion must clear workflow-style watchdog before retry");
      assert.equal(exit, 0, stderr);
      const errors = events.filter(e => e.type === "message_end" && e.message?.stopReason === "error");
      const isContent = scenario.kind === "content";
      assert.equal(requests, isContent || !scenario.enabled ? 1 : 2);
      assert.equal(errors.length, isContent ? 0 : scenario.always ? 2 : 1);
      assert.ok(errors.every(e => e.message.errorMessage.includes("no model content received within 240 seconds")));
      assert.equal(events.filter(e => e.type === "auto_retry_start").length, !isContent && scenario.enabled ? 1 : 0);
      if (!isContent && scenario.enabled) assert.equal(events.find(e => e.type === "auto_retry_end")?.success, !scenario.always);
      assert.equal(events.some(e => e.type === "tool_execution_start"), false);
      if (isContent || (scenario.enabled && !scenario.always)) assert.ok(events.some(e => e.type === "message_end" && e.message?.stopReason === "stop"));
      if (!isContent) assert.ok(cancelled >= 1, "silent upstream connection cancelled");
    } finally {
      clearTimeout(killTimer); clearTimeout(generationTimer);
      if (child && child.exitCode === null) child.kill("SIGKILL");
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
