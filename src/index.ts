/**
 * pi-9router — native 9router provider for pi
 *
 * Registers 9router (an OpenAI-compatible routing proxy) as a native provider
 * using pi's built-in provider primitives only:
 *
 *   - auth.apiKey  -> /login 9router (interactive secret prompt, stored in auth.json)
 *   - fetchModels   -> dynamic discovery via GET {baseUrl}/models, persisted in
 *                      pi's models-store.json and restored when offline
 *   - openAICompletionsApi -> standard OpenAI Chat Completions streaming
 *
 * Endpoint configuration lives in pi's own models.json:
 *
 *   ~/.pi/agent/models.json
 *   {
 *     "providers": {
 *       "9router": {
 *         "baseUrl": "http://host:20128/v1",
 *         "modelOverrides": { ... }
 *       }
 *     }
 *   }
 *
 * API key: /login 9router, or the NINE_ROUTER_API_KEY environment variable.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { guardProviderStreams } from "./stream-guard.ts";
import { web_search, web_fetch, formatSearchResponse, formatFetchResponse } from "./web.ts";

const PROVIDER_ID = "9router";
const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const API_KEY_ENV = "NINE_ROUTER_API_KEY";
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 4096;

/** Path to pi's global models.json (honors a relocated agent dir). */
function modelsJsonPath(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "models.json",
  );
}

/** Ensure the OpenAI-compatible base URL ends with /v1. */
function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Resolve the 9router endpoint from models.json, falling back to localhost. */
function resolveBaseUrl(): string {
  try {
    const parsed = JSON.parse(readFileSync(modelsJsonPath(), "utf8")) as {
      providers?: Record<string, { baseUrl?: unknown }>;
    };
    const raw = parsed.providers?.[PROVIDER_ID]?.baseUrl;
    if (typeof raw === "string" && raw.trim()) {
      return normalizeBaseUrl(raw);
    }
  } catch {
    // models.json missing or unreadable — use the default.
  }
  return DEFAULT_BASE_URL;
}

interface RouterCapabilities {
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  thinkingFormat?: string;
  thinkingCanDisable?: boolean;
}

interface RouterModel {
  id?: string;
  name?: string;
  capabilities?: RouterCapabilities;
  [key: string]: unknown;
}

function toTokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const count = Math.floor(value);
    return count > 0 ? count : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/g, "").trim();
  const n = Math.floor(Number(normalized));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const CONTEXT_KEYS = [
  "contextWindow",
  "context_window",
  "context_length",
  "contextLength",
  "max_context_length",
  "max_context_window",
  "maxModelLen",
  "max_model_len",
];

const MAX_TOKENS_KEYS = [
  "maxTokens",
  "max_tokens",
  "max_output_tokens",
  "maxOutputTokens",
  "max_completion_tokens",
  "maxCompletionTokens",
];

function firstTokenCount(entry: RouterModel, keys: string[]): number | undefined {
  for (const key of keys) {
    const count = toTokenCount(entry[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

/** Router levels describe accepted reasoning_effort values, not backend wire formats. */
function thinkingLevelMap(entry: RouterModel): ThinkingLevelMap | undefined {
  const advertised = Array.isArray(entry.thinking_levels)
    ? entry.thinking_levels.filter((level): level is string => typeof level === "string")
    : [];
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!advertised.length) {
    return entry.capabilities?.thinkingCanDisable === false ? { off: null } : undefined;
  }
  const mapping: ThinkingLevelMap = {};
  for (const level of levels) {
    const wireValue = level === "off" ? "none" : level;
    mapping[level] = advertised.includes(wireValue) ? wireValue : null;
  }
  // Binary backends advertise "thinking" rather than a numeric effort tier.
  if (advertised.includes("thinking") && !levels.some((level) => level !== "off" && mapping[level])) {
    mapping.high = "high"; // 9router normalizes any enabled effort to binary thinking.
  }
  if (entry.capabilities?.thinkingCanDisable === false) mapping.off = null;
  // Unknown future-only levels must not leave pi with zero selectable levels.
  return Object.values(mapping).some((value) => value !== null) ? mapping : undefined;
}

export function mapModel(entry: RouterModel, baseUrl: string): Model<"openai-completions"> {
  const id = typeof entry.id === "string" ? entry.id : "";
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name : id;
  const caps = entry.capabilities;

  const contextWindow =
    toTokenCount(caps?.contextWindow) ??
    firstTokenCount(entry, CONTEXT_KEYS) ??
    FALLBACK_CONTEXT_WINDOW;

  const maxTokens = Math.min(
    toTokenCount(caps?.maxOutput) ??
    firstTokenCount(entry, MAX_TOKENS_KEYS) ??
    FALLBACK_MAX_TOKENS,
    contextWindow,
  );

  const isReasoning =
    typeof caps?.reasoning === "boolean"
      ? caps.reasoning
      : /r1|reasoner|o1|o3|o4|gemini|thinking|flash/i.test(id);

  const input: ("text" | "image")[] = caps?.vision ? ["text", "image"] : ["text"];

  return {
    id,
    name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: isReasoning,
    thinkingLevelMap: isReasoning ? thinkingLevelMap(entry) : undefined,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      // 9router translates this OpenAI envelope into the backend's thinkingFormat.
      thinkingFormat: "openai",
    },
  };
}

export async function fetchModels(context: RefreshModelsContext): Promise<readonly Model<"openai-completions">[]> {
  const baseUrl = normalizeBaseUrl(context.baseUrl ?? resolveBaseUrl());
  const headers: Record<string, string> = { Accept: "application/json" };

  const credential = context.credential;
  const key = credential && credential.type === "api_key" ? credential.key : undefined;
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const response = await fetch(`${baseUrl}/models`, {
    headers,
    signal: context.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`9router discovery failed: HTTP ${response.status}${body ? ` — ${body}` : ""}`);
  }

  const payload = (await response.json()) as { data?: RouterModel[] };
  const entries = Array.isArray(payload.data) ? payload.data : [];

  return entries
    .filter((entry) => typeof entry.id === "string" && entry.id.trim())
    .map((entry) => mapModel(entry, baseUrl));
}

/** Keep large pages out of the model context while preserving the complete text. */
async function toolText(text: string): Promise<string> {
  const truncated = truncateHead(text);
  if (!truncated.truncated) return text;
  const directory = await mkdtemp(join(tmpdir(), "pi-9router-"));
  const path = join(directory, "output.txt");
  await writeFile(path, text, { mode: 0o600 });
  return `${truncated.content}\n\n[Output truncated. Full content saved to ${path}]`;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider<"openai-completions">({
      id: PROVIDER_ID,
      name: "9router",
      baseUrl: DEFAULT_BASE_URL,

      auth: {
        apiKey: {
          name: "9router API key",
          async login(interaction) {
            const key = await interaction.prompt({
              type: "secret",
              message: "Enter your 9router API key (from the 9router dashboard)",
            });
            return { type: "api_key", key };
          },
          async resolve({ ctx, credential }) {
            if (credential?.key) {
              return { auth: { apiKey: credential.key }, source: "stored API key" };
            }
            const envKey = await ctx.env(API_KEY_ENV);
            if (envKey) {
              return { auth: { apiKey: envKey }, source: API_KEY_ENV };
            }
            return undefined;
          },
        },
      },

      models: [],
      fetchModels,
      api: guardProviderStreams(openAICompletionsApi()),
    }),
  );

  // Helper to resolve baseUrl + apiKey at tool call time.
  async function resolveAuth(ctx: ExtensionContext) {
    const providerAuth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    const baseUrl = normalizeBaseUrl(
      providerAuth?.auth.baseUrl ?? ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ?? resolveBaseUrl(),
    );
    const apiKey = providerAuth?.auth.apiKey ?? process.env[API_KEY_ENV] ?? "";
    const headers = Object.fromEntries(
      Object.entries(providerAuth?.auth.headers ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return { baseUrl, apiKey, headers };
  }

  pi.registerTool({
    name: "ninerouter_web_search",
    label: "Web Search",
    description: "Search the web for real-time information. Use this to research current events, recent news, documentation, or any topic that may be outdated or absent in training data. Returns a ranked list of results with URLs, titles, authors, and snippets.",
    promptSnippet: "Search the web for real-time, up-to-date information and online research",
    promptGuidelines: [
      "Use ninerouter_web_search when the user asks about current events, recent news, live data, or anything that may not be in your training data.",
      "Use ninerouter_web_search to research a topic online before answering — especially for technical docs, pricing, changelogs, or fast-moving domains like AI.",
      "Prefer search_type=\"news\" for recent events and search_type=\"web\" for general research.",
      "After getting search results, use ninerouter_web_fetch on the most relevant URL to get full article content.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      search_type: Type.Union(
        [Type.Literal("web"), Type.Literal("news")],
        { description: "Type of search: \"web\" for general, \"news\" for recent news" },
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Number of results to return (max 50)", minimum: 1, maximum: 50 }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const { baseUrl, apiKey, headers } = await resolveAuth(ctx);
        const result = await web_search(baseUrl, apiKey, {
          query: params.query,
          search_type: params.search_type,
          max_results: params.max_results,
        }, { signal, headers });
        return {
          content: [{ type: "text" as const, text: await toolText(formatSearchResponse(result)) }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `web_search failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "ninerouter_web_fetch",
    label: "Web Fetch",
    description: "Fetch and return the full readable content of a single URL as markdown. Use this after ninerouter_web_search to read the full article, documentation page, or any webpage in detail.",
    promptSnippet: "Fetch the full content of a URL as readable markdown for in-depth research",
    promptGuidelines: [
      "Use ninerouter_web_fetch to read the full content of a URL found via ninerouter_web_search or provided by the user.",
      "Use ninerouter_web_fetch when a snippet from search results is not enough and you need the complete article or page content.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const { baseUrl, apiKey, headers } = await resolveAuth(ctx);
        const result = await web_fetch(baseUrl, apiKey, params.url, undefined, { signal, headers });
        return {
          content: [{ type: "text" as const, text: await toolText(formatFetchResponse(result)) }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `web_fetch failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
