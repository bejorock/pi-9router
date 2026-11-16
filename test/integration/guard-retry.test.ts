import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

// Exercise the production thresholds, native HTTP adapter, actual pi CLI retry
// policy and enabled bash tool. No fake HTTP error or test-only detector tuning.
for (const scenario of [
  { channel: "bash", status: 200, enabled: true, always: false, expectedRequests: 2, success: true },
  { channel: "bash", status: 201, enabled: true, always: false, expectedRequests: 2, success: true },
  { channel: "bash", status: 200, enabled: false, always: false, expectedRequests: 1, success: false },
  { channel: "bash", status: 200, enabled: true, always: true, expectedRequests: 2, success: false },
  { channel: "find", status: 200, enabled: true, always: false, expectedRequests: 2, success: true },
  { channel: "text", status: 200, enabled: true, always: false, expectedRequests: 2, success: true },
  { channel: "thinking", status: 200, enabled: true, always: false, expectedRequests: 2, success: true },
]) {
  test(`actual pi ${scenario.channel} guard→retry HTTP${scenario.status} enabled=${scenario.enabled} always=${scenario.always}`, { timeout: 45000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-guard-integration-"));
    const marker = join(directory, "MUST_NOT_EXIST");
    const bodies: unknown[] = [];
    let disconnected = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.aborted || !raw) { response.destroy(); return; }
      bodies.push(JSON.parse(raw));
      response.writeHead(scenario.status, { "Content-Type": "text/event-stream", Connection: "close" });
      const send = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: "guard-test", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (bodies.length > 1 && !scenario.always) {
        send({ role: "assistant", content: "RETRY_RECOVERED" });
        send({}, "stop");
        response.end("data: [DONE]\n\n");
        return;
      }
      const invisible = scenario.channel === "find";
      const cycle = invisible ? '\u200c\u200b'.repeat(8) : ' t. '.repeat(4);
      const emit = (value: string, initial = false) => {
        if (scenario.channel === "text") send({ ...(initial ? { role: "assistant" } : {}), content: value });
        else if (scenario.channel === "thinking") send({ ...(initial ? { role: "assistant" } : {}), reasoning_content: value });
        else send({ ...(initial ? { role: "assistant" } : {}), tool_calls: [{ index: 0, ...(initial ? { id: "unfinished", type: "function" } : {}), function: { ...(initial ? { name: scenario.channel } : {}), arguments: value } }] });
      };
      emit(invisible ? '{"pattern":"*","path":"' + '\u200c\u200b'.repeat(600) :
        (scenario.channel === "bash" ? '{"command":"touch ' + marker + '; echo ' : '') + ' t. '.repeat(1100), true);
      // ~4 seconds of confirmed sustained degeneration after the initial tail.
      for (let i = 0; i < 110 && !response.destroyed; i++) {
        await sleep(50);
        if (response.destroyed) break;
        emit(cycle);
      }
      if (response.destroyed) disconnected++;
      else response.end("data: [DONE]\n\n");
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: scenario.enabled, maxRetries: 1, baseDelayMs: 10, provider: { maxRetries: 0 } } }));
      await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { "9router": { baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "probe", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
      // Restore a native catalog just as real discovery does. Pi intentionally
      // routes custom-only APIs through its global adapter when no base model
      // advertises that API, which would bypass this provider's stream wrapper.
      await writeFile(join(directory, "models-store.json"), JSON.stringify({ "9router": { checkedAt: Date.now(), models: [{ id: "probe", name: "Probe", provider: "9router", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }));
      const child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--offline", "--no-extensions", "-e", resolve("src/index.ts"), "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--tools", "bash,find", "--api-key", "dummy", "--model", "9router/probe", "--thinking", "off", "--mode", "json", "-a", "-p", "Reply RETRY_RECOVERED."], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      let exit;
      try {
        exit = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      } finally { clearTimeout(timer); }
      assert.equal(exit, 0, stderr); // JSON mode reports assistant errors as events.
      const events = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      assert.equal(bodies.length, scenario.expectedRequests);
      assert.equal(events.some((e) => e.type === "tool_execution_start"), false);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(JSON.stringify(bodies.slice(1)).includes(marker), false, "failed attempt omitted from retry context");
      const errors = events.filter((e) => e.type === "message_end" && e.message?.stopReason === "error");
      assert.equal(errors.length, scenario.always ? 2 : 1);
      assert.ok(errors.every((e) => e.message.errorMessage.startsWith("upstream_stream_read_error:")), JSON.stringify(errors));
      assert.equal(events.filter((e) => e.type === "auto_retry_start").length, scenario.enabled ? 1 : 0);
      if (scenario.enabled) assert.equal(events.find((e) => e.type === "auto_retry_end")?.success, scenario.success);
      if (scenario.success) assert.ok(events.some((e) => e.type === "message_end" && e.message?.role === "assistant" && Array.isArray(e.message.content) && e.message.content.some((c: { text?: string }) => c.text === "RETRY_RECOVERED")));
      await sleep(80); // allow the server loop to observe client cancellation
      assert.ok(disconnected >= 1, "guard cancels underlying HTTP stream");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
