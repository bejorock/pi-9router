import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("actual pi default prompt is rewritten only for 9router/ag/* on the wire", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ag-isolation-"));
  const requests: { messages: { role: string; content: string }[]; tools: unknown[] }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!raw || request.aborted) { response.destroy(); return; }
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "ISOLATION_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const models = ["ag/probe", "erica-medium"].map(id => ({ id, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false, provider: { maxRetries: 0 } } }));
    await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { "9router": { baseUrl, models }, "other": { baseUrl, api: "openai-completions", apiKey: "dummy", models, compat: { supportsDeveloperRole: false } } } }));
    const run = async (selection: string, withExtension = true) => {
      const child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--offline", "--no-extensions", ...(withExtension ? ["-e", resolve("src/index.ts")] : []), "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--tools", "bash", "--api-key", "dummy", "--model", selection, "--thinking", "off", "--mode", "json", "-a", "-p", "Reply ISOLATION_OK."], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const exit = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
        assert.equal(exit, 0, stderr);
        assert.ok(stdout.includes("ISOLATION_OK"), stdout + stderr);
      } finally { clearTimeout(timer); }
      return requests.at(-1)!;
    };
    const ag = await run("9router/ag/probe");
    const nonAg = await run("9router/erica-medium");
    const other = await run("other/ag/probe");
    const baseline = await run("other/ag/probe", false);
    const nonAgBaseline = await run("9router/erica-medium", false);
    assert.equal(requests.length, 5);
    const system = (body: typeof ag) => body.messages.find(m => m.role === "system")!.content;
    assert.ok(system(ag).startsWith("You are a coding assistant running inside a coding agent harness."));
    assert.ok(!system(ag).includes("<docs>"));
    for (const tag of ["tools", "rules", "cwd"]) assert.ok(system(ag).includes(`<${tag}>`));
    for (const body of [nonAg, other, baseline]) {
      assert.ok(system(body).startsWith("You are a coding assistant running inside pi, a coding agent harness."));
      assert.ok(system(body).includes("<docs>\nPi documentation"));
    }
    assert.equal(system(nonAg), system(other));
    assert.deepEqual(other, baseline, "other provider payload is byte-for-byte equivalent without extension");
    assert.deepEqual(nonAg, nonAgBaseline, "non-AG 9router payload is byte-for-byte equivalent without extension");
    assert.deepEqual(ag.tools, nonAg.tools);
    assert.equal(ag.tools.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
