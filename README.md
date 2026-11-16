# pi-9router

A [pi](https://pi.dev) coding-agent extension that registers [9router](https://github.com/decolua/9router) — an OpenAI-compatible AI routing proxy — as a native provider with dynamic model discovery.

Built on pi's native provider primitives, with web search/fetch tools and no custom commands or extension-specific configuration files.

## Compatibility

Verified against **pi 1.5.2** (`@earendil-works/pi-coding-agent` / `pi-ai`) and **9router 0.5.119**. Pi dependencies are host-provided peers; no separate runtime dependency installation is needed for managed git installs.

## Features

- **Native provider** via `createProvider` — uses pi's own OpenAI Chat Completions streaming
- **Dynamic model discovery** via `GET /v1/models`, persisted in pi's `models-store.json` and restored when offline
- **Built-in `/login 9router`** for the API key (stored in `~/.pi/agent/auth.json`)
- **Router capability discovery** for reasoning, images, context/output limits, and supported thinking levels (including `xhigh` / `max` when advertised)
- **`models.json` `modelOverrides`** are honored (reasoning, input types, context window, etc.)
- **`ninerouter_web_search` / `ninerouter_web_fetch`** discover available web providers and fall back on provider errors; cancellation stops requests and retries
- **Bounded tool output**: large pages/search results are truncated, with the full formatted output saved to a temporary file

## Install

```bash
# From git
pi install git:github.com/bejorock/pi-9router

# Local / development
git clone https://github.com/bejorock/pi-9router
pi install /path/to/pi-9router
```

## Configure

### Endpoint

Add your 9router base URL to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "9router": {
      "baseUrl": "http://your-router:20128/v1"
    }
  }
}
```

Defaults to `http://localhost:20128/v1` when unset. Include the `/v1` suffix (a bare `host:port` is auto-normalized).

### API key

Pick one:

1. `/login 9router` — interactive secret prompt (recommended)
2. `export NINE_ROUTER_API_KEY=...` — for scripts/CI
3. `"apiKey": "$NINE_ROUTER_API_KEY"` in `models.json` (pi-native interpolation)

Current 9router requires a valid API key for remote `/v1/*` access, including model discovery. Configure authentication before connecting to a remote router. Web tools use pi's resolved provider API key, headers, and endpoint.

### Optional: model overrides

Current 9router advertises per-model capabilities and `thinking_levels`; these are discovered automatically. Older routers and combos may omit metadata. Use `modelOverrides` to customize or correct the discovered values:

```json
{
  "providers": {
    "9router": {
      "baseUrl": "http://your-router:20128/v1",
      "modelOverrides": {
        "erica-medium": {
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 65536
        }
      }
    }
  }
}
```

## Usage

- Models are discovered automatically at interactive startup, after `/login 9router`, and in RPC mode
- Select a model: `/model 9router/<model-id>`
- Requests go through 9router's OpenAI-compatible `/v1/chat/completions`
- Use `/thinking` to choose from the model's advertised thinking levels. Backend thinking formats are translated by 9router, not by this extension.
- Web tools require a configured search/fetch provider in 9router. Current 9router blocks fetches to private/internal targets as an SSRF safeguard.
- Print mode and offline model listing use pi's cached catalog; refresh through an interactive session or `/model` after updating 9router.

## Antigravity prompt compatibility

Only when the selected model has provider **`9router`**, an ID starting with
**`ag/`**, and the OpenAI Chat Completions API, a `before_provider_request` hook:

- Replaces pi's exact default opening identity with: `You are a coding assistant running inside a coding agent harness. Help users inspect files, run commands, and modify code.`
- Removes the recognized built-in pi documentation section from that default system prompt.

This works around observed prompt-sensitive `503` / upstream `429
RESOURCE_EXHAUSTED` responses on `ag/gemini-3.8-flash-high`. It does not establish
the upstream cause or guarantee that every AG model accepts every prompt.

Tools and their schemas, rules, cwd, project instructions, skills, user messages,
and conversation history are preserved. Other providers and non-`ag/` 9router
models return the original payload unchanged. The rewrite copies only the
outgoing payload, so switching models requires no restoration and does not alter
stored prompts or `ctx.getSystemPrompt()`.

Matching is intentionally conservative: only the leading string system message
with pi's exact default preamble is eligible. Custom prompts are untouched;
unknown/future documentation templates and unrelated `<docs>` blocks are kept.
The trade-off for AG requests is losing pi's automatic documentation-location
guidance. This is not a blanket removal of the word `pi` from project content.

## Repetitive-stream guard

The provider's native stream is wrapped with a conservative guard for the observed
unfinished `bash` argument loop (` t.  t.  t. …`). It does **not** ask the model to
explain the failure or pretend an HTTP 503 occurred. The guard cancels only that
request, emits a locally detected `upstream_stream_read_error`, and lets pi's
native retry settings control backoff and the maximum number of retries. User
cancellation remains cancellation, never a forced retry. No system-prompt
instructions are added.

Detection requires all of the following:

- A known `bash` call, with `command` as the first JSON key and its string still unfinished.
- At least 4,096 argument characters, ending in an exact 2,048-character periodic suffix.
- A minimal cycle of 3–8 ASCII characters: exactly one letter, one period, and spaces (not general repeated prose, code, arrays, or padding).
- The signature remains continuous for at least 3 seconds, 256 additional characters, and 64 additional nonempty argument deltas.

The captured incident replays at **52.574 seconds** versus its original **299.963
seconds**. This is evidence for that recording, not a guaranteed detection time.
The detector holds only a bounded prefix/tail, and each tool call is checked
independently. Incomplete calls are never repaired or executed.

**Scope and limitations:** this deliberately favors avoiding false positives over
catching every loop. It does not detect silent streams, thinking/text loops,
other tools, other JSON key orderings, multiline/heredoc commands, or repeated
content inside an open quoted shell literal. A few very large buffered
deltas may not satisfy the progress threshold. Legitimate unquoted repetition
identical to the signature is indistinguishable and can cause a bounded retry.
The guard depends on the built-in adapter honoring request cancellation.

Pi 1.5.2 uses this native provider stream after its model catalog has been
restored or discovered. A manually defined-only model on a fresh/offline install
can instead use pi's global API adapter and bypass this guard; open `/model`
online to discover/cache the 9router catalog first. The guard is scoped to this
provider and does not override the global OpenAI adapter.

## Development

Use Node.js 24 (matching the tested pi runtime):

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

Unit tests cover current/legacy model metadata, endpoint/auth composition, web-provider fallback, cancellation, output truncation, AG-only prompt rewriting/model-switch isolation, and a sanitized replay retaining the actual incident's chunk boundaries/timing. Integration tests start a local HTTP SSE server and actual pi process to prove AG prompt rewriting and other-provider payload equivalence, guard-triggered native retry over HTTP 200/201, disabled/exhausted retry budgets, request cancellation, and no tool execution. No real API keys are needed.

## License

MIT
