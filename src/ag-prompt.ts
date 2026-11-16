/** Request-only compatibility workaround for explicitly selected 9router AG models. */
const PI_IDENTITY = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const AG_IDENTITY = "You are a coding assistant running inside a coding agent harness. Help users inspect files, run commands, and modify code.";

// Match the complete built-in pi 1.5.2 section, not arbitrary project <docs>.
// Installation paths vary; all other text must match. Fail closed on future changes.
const DOCS_LINES = [
  "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: ",
  "- Additional docs: ",
  "- Examples: ",
  "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)",
  "- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.",
];

function isBuiltinDocs(block: string): boolean {
  const lines = block.split("\n");
  if (lines.length !== DOCS_LINES.length) return false;
  return lines.every((line, index) => {
    if (index >= 1 && index <= 3) {
      const suffix = index === 1 ? "/README.md" : index === 2 ? "/docs" : "/examples (extensions, custom tools, SDK)";
      const normalized = line.replace(/\\/g, "/");
      return normalized.startsWith(DOCS_LINES[index]) &&
        normalized.includes("/@earendil-works/pi-coding-agent/") && normalized.endsWith(suffix);
    }
    return line === DOCS_LINES[index];
  });
}

function rewriteSystem(text: string): string {
  // Only a default pi preamble, never quoted identities or custom system prompts.
  if (text !== PI_IDENTITY && !text.startsWith(`${PI_IDENTITY}\n\n`)) return text;
  // Only inspect pi's own leading sections; cwd also precedes custom sections.
  const boundary = text.search(/^<(?:addendum|project_context|skills|cwd)>$/m);
  const prelude = boundary < 0 ? text : text.slice(0, boundary);
  const remainder = boundary < 0 ? "" : text.slice(boundary);
  let removed = false;
  const rewritten = prelude.replace(/^<docs>\n([^]*?)\n<\/docs>$/gm, (block, content: string) => {
    if (removed || !isBuiltinDocs(content)) return block;
    removed = true;
    return "";
  });
  return AG_IDENTITY + rewritten.slice(PI_IDENTITY.length) + remainder;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Undefined means no replacement; never mutate the input or shared prompt state. */
export function rewriteAgPayload(
  payload: unknown,
  model?: { provider: string; id: string; api: string },
): unknown | undefined {
  if (model?.provider !== "9router" || !model.id.startsWith("ag/") ||
      model.api !== "openai-completions" || !record(payload) || !Array.isArray(payload.messages)) return undefined;
  // The adapter emits the current system prompt first. Never rewrite history.
  const first: unknown = payload.messages[0];
  if (!record(first) || first.role !== "system" || typeof first.content !== "string") return undefined;
  const content = rewriteSystem(first.content);
  if (content === first.content) return undefined;
  return { ...payload, messages: [{ ...first, content }, ...payload.messages.slice(1)] };
}
