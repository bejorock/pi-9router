import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { rewriteAgPayload } from "../src/ag-prompt.ts";

const original = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const working = "You are a coding assistant running inside a coding agent harness. Help users inspect files, run commands, and modify code.";
const docs = `<docs>
Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /fixture/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /fixture/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /fixture/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.
</docs>`;
const tools = "<tools>\n- bash: Execute bash commands (ls, grep, find, etc.)\n\nAdditional tools may be available.\n</tools>";
const rules = "<rules>\n- Use bash for file operations like ls, rg, find\n- You can inspect PI_* environment variables for current model and session details.\n</rules>";
const cwd = "<cwd>\n/fixture/project\n</cwd>";
const prompt = [original, tools, rules, docs, cwd].join("\n\n");
const model = { provider: "9router", id: "ag/gemini-3.8-flash-high", api: "openai-completions" };
function payload(system = prompt) {
  return {
    model: model.id,
    messages: [{ role: "system", content: system }, { role: "user", content: original + "\n" + docs }, { role: "assistant", content: original }],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    stream: true, max_tokens: 65536, reasoning_effort: "high",
  };
}
type Payload = ReturnType<typeof payload>;
function rewrite(input: Payload, selected = model): Payload {
  return rewriteAgPayload(input, selected) as Payload;
}

test("AG full combination changes only default identity and builtin docs, without mutation", () => {
  const input = payload();
  const snapshot = structuredClone(input);
  const result = rewrite(input);
  assert.equal(result.messages[0].content, prompt.replace(original, working).replace(docs, ""));
  assert.deepEqual(input, snapshot);
  assert.notEqual(result, input);
  assert.notEqual(result.messages, input.messages);
  assert.equal(result.messages[1], input.messages[1]);
  assert.equal(result.messages[2], input.messages[2]);
  assert.equal(result.tools, input.tools);
  assert.deepEqual({ ...result, messages: [] }, { ...input, messages: [] });
  assert.equal(rewriteAgPayload(result, model), undefined, "idempotent");
});

test("strict provider/model/API gate leaves every other selection untouched", () => {
  const input = payload();
  for (const selected of [
    undefined,
    { ...model, provider: "google" },
    { ...model, provider: "openai" },
    { ...model, provider: "9router-other" },
    ...["erica-medium", "erica-high", "cx/gpt-6", "antigravity/gemini", "my-ag/test", "AG/gemini", "ag", "gemini"].map(id => ({ ...model, id })),
    { ...model, api: "anthropic-messages" },
  ]) assert.equal(rewriteAgPayload(input, selected), undefined, JSON.stringify(selected));
  assert.equal(input.messages[0].content, prompt);
});

test("switch AG → another model → AG does not change shared original prompt", () => {
  const input = payload();
  assert.ok(rewriteAgPayload(input, model));
  assert.equal(rewriteAgPayload(input, { ...model, id: "erica-medium" }), undefined);
  assert.equal(rewriteAgPayload(input, { ...model, provider: "another" }), undefined);
  assert.deepEqual(rewriteAgPayload(input, model), rewriteAgPayload(input, model));
  assert.equal(input.messages[0].content, prompt);
});

test("custom prompts, quoted identities, unknown payloads and non-string messages fail closed", () => {
  for (const input of [null, [], {}, { messages: {} }, { messages: [null, 1, { role: "system", content: [original] }] }]) {
    assert.equal(rewriteAgPayload(input, model), undefined);
  }
  for (const system of ["Custom prompt\n" + prompt, docs, "Example: " + original, original + " and custom text"]) {
    assert.equal(rewriteAgPayload(payload(system), model), undefined);
  }
});

test("preserves unrelated/custom/modified docs and copies inside project instructions", () => {
  for (const custom of ["<docs>\nMy project docs\n</docs>", docs.replace("read only when", "read whenever"), docs.replace("/README.md", "/CUSTOM.md"), docs.replace("/docs\n", "/docs\nextra instruction\n")]) {
    const result = rewrite(payload(original + "\n\n" + custom));
    assert.equal(result.messages[0].content, working + "\n\n" + custom);
  }
  for (const boundary of ["addendum", "project_context", "skills"]) {
    const suffix = `\n\n<${boundary}>\n${docs}\n${original}\n</${boundary}>`;
    const result = rewrite(payload(prompt + suffix));
    assert.equal(result.messages[0].content, prompt.replace(original, working).replace(docs, "") + suffix);
  }
});

test("only leading system prompt is eligible; later history and custom sections are untouched", () => {
  const input = payload();
  input.messages.push({ role: "system", content: prompt });
  const result = rewrite(input);
  assert.equal(result.messages[3], input.messages[3]);
  const userFirst = { ...input, messages: [input.messages[1], input.messages[0]] };
  assert.equal(rewriteAgPayload(userFirst, model), undefined);
  const suffix = `\n\n<custom_notes>\n${docs}\n</custom_notes>`;
  assert.equal(rewrite(payload(prompt + suffix)).messages[0].content, prompt.replace(original, working).replace(docs, "") + suffix);
});

test("supports Windows installation paths without changing any remaining paths", () => {
  const windowsDocs = docs.replaceAll("/fixture/node_modules/@earendil-works/pi-coding-agent/", "C:\\fixture\\node_modules\\@earendil-works\\pi-coding-agent\\");
  const system = original + "\n\n" + windowsDocs + "\n\n" + cwd;
  assert.equal(rewrite(payload(system)).messages[0].content, working + "\n\n\n\n" + cwd);
});

test("actual registered hook uses current model on each request and returns no-op for others", async () => {
  let handler: ((event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown) | undefined;
  register({
    on(name: string, callback: typeof handler) { if (name === "before_provider_request") handler = callback; },
    registerProvider() {}, registerTool() {},
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  const input = payload();
  const event = { type: "before_provider_request", payload: input } as const;
  const context = { model } as unknown as ExtensionContext;
  assert.deepEqual(await handler(event, context), rewriteAgPayload(input, model));
  context.model = { ...context.model!, provider: "other" };
  assert.equal(await handler(event, context), undefined);
  context.model = { ...context.model!, provider: "9router", id: "erica-medium" };
  assert.equal(await handler(event, context), undefined);
  assert.equal(input.messages[0].content, prompt);
});
