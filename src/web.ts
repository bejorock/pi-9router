export interface WebSearchArgs {
  /** Provider to use (e.g. "exa", "tavily"). If omitted, auto-selects with fallback. */
  model?: string;
  query: string;
  search_type: "web" | "news";
  /** Maximum number of results to return. Max: 50 */
  max_results?: number;
  country?: string | null;
  language?: string | null;
}

export interface SearchResultCitation {
  provider: string | null;
  rank: number | null;
  retrieved_at: string | null;
}

export interface SearchResultMetadata {
  author: string | null;
  image_url: string | null;
  language: string | null;
  source_type: string | null;
}

export interface SearchResult {
  url: string;
  title: string | null;
  snippet: string | null;
  display_url: string | null;
  favicon_url: string | null;
  position: number | null;
  score: number | null;
  published_at: string | null;
  content: string | null;
  provider_raw: unknown | null;
  citation: SearchResultCitation | null;
  metadata: SearchResultMetadata | null;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  answer: string | null;
  results: SearchResult[];
  error?: { message: string };
}

export interface WebModel {
  id: string;
  kind: "webSearch" | "webFetch";
  object: string;
  owned_by: string;
}

export interface WebModelsResponse {
  object: string;
  data: WebModel[];
}

export interface FetchUsage {
  fetch_cost_usd: number | null;
}

export interface FetchMetrics {
  response_time_ms: number | null;
  upstream_latency_ms: number | null;
}

export interface FetchContent {
  format: string | null;
  length: number | null;
  text: string | null;
}

export interface FetchMetadata {
  author: string | null;
  language: string | null;
  published_at: string | null;
}

export interface FetchResult {
  url: string;
  title: string | null;
  provider: string;
  content: FetchContent;
  metadata: FetchMetadata;
  usage: FetchUsage;
  metrics: FetchMetrics;
}

interface WebFetchResponse extends FetchResult {
  error?: { message: string };
}

/**
 * Format a WebSearchResponse into a compact string for the agent.
 */
export function formatSearchResponse(response: WebSearchResponse): string {
  const lines: string[] = [`Query: ${response.query}`, `Provider: ${response.provider}`, ""];

  for (const r of response.results) {
    lines.push(`[${r.position}] ${r.title ?? "(no title)"}`);
    lines.push(`URL: ${r.url}`);
    if (r.metadata?.author) lines.push(`Author: ${r.metadata.author}`);
    if (r.published_at) lines.push(`Published: ${r.published_at}`);
    if (r.snippet) lines.push(`Snippet: ${r.snippet}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Format a FetchResult into a compact string for the agent.
 */
export function formatFetchResponse(result: FetchResult): string {
  const lines: string[] = [];

  if (result.title) lines.push(`Title: ${result.title}`);
  lines.push(`URL: ${result.url}`);
  lines.push(`Provider: ${result.provider}`);
  if (result.metadata.author) lines.push(`Author: ${result.metadata.author}`);
  if (result.metadata.published_at) lines.push(`Published: ${result.metadata.published_at}`);
  lines.push("");
  if (result.content.text) lines.push(result.content.text);

  return lines.join("\n").trim();
}

/**
 * Convert a web model id (e.g. "exa/search", "tavily/fetch") to the
 * provider name expected by /v1/search and /v1/fetch (e.g. "exa", "tavily").
 */
export function toProvider(modelId: string): string {
  return modelId.split("/")[0];
}

/**
 * Get available web models from 9router's /v1/models/web endpoint.
 * @param baseUrl - 9router base URL (e.g. http://localhost:20128/v1)
 * @param apiKey - 9router API key
 * @param kind - Optional filter by kind ("webSearch" or "webFetch")
 */
export async function get_web_models(
  baseUrl: string,
  apiKey: string,
  kind?: "webSearch" | "webFetch",
): Promise<WebModelsResponse> {
  const response = await fetch(`${baseUrl}/models/web`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`get_web_models failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }

  const data = (await response.json()) as WebModelsResponse;

  if (kind) {
    return { ...data, data: data.data.filter((m) => m.kind === kind) };
  }

  return data;
}

async function _do_search(
  baseUrl: string,
  apiKey: string,
  provider: string,
  args: WebSearchArgs,
): Promise<WebSearchResponse> {
  const body: Record<string, unknown> = {
    model: provider,
    query: args.query,
    search_type: args.search_type,
  };

  if (args.max_results !== undefined) body.max_results = args.max_results;
  if (args.country != null) body.country = args.country;
  if (args.language != null) body.language = args.language;

  const response = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${text}`);
  }

  const data = JSON.parse(text) as WebSearchResponse;

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data;
}

/**
 * Search the web via 9router's /v1/search endpoint.
 * If `args.model` is omitted, auto-discovers available webSearch providers
 * and retries each in order until one succeeds.
 */
export async function web_search(
  baseUrl: string,
  apiKey: string,
  args: WebSearchArgs,
): Promise<WebSearchResponse> {
  if (args.max_results !== undefined && args.max_results > 50) {
    throw new Error("max_results cannot exceed 50");
  }

  if (args.model) {
    return _do_search(baseUrl, apiKey, args.model, args);
  }

  const { data: models } = await get_web_models(baseUrl, apiKey, "webSearch");
  if (models.length === 0) {
    throw new Error("No webSearch providers available");
  }

  const errors: string[] = [];
  for (const model of models) {
    const provider = toProvider(model.id);
    try {
      return await _do_search(baseUrl, apiKey, provider, args);
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All webSearch providers failed:\n${errors.join("\n")}`);
}

async function _do_fetch(
  baseUrl: string,
  apiKey: string,
  provider: string,
  url: string,
): Promise<FetchResult> {
  const response = await fetch(`${baseUrl}/web/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: provider, url }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${text}`);
  }

  const data = JSON.parse(text) as WebFetchResponse;

  if (data.error) {
    throw new Error(data.error.message);
  }

  const { error: _, ...result } = data;
  return result;
}

/**
 * Fetch and return the content of a single URL via 9router's /v1/web/fetch endpoint.
 * If `model` is omitted, auto-discovers available webFetch providers
 * and retries each in order until one succeeds.
 */
export async function web_fetch(
  baseUrl: string,
  apiKey: string,
  url: string,
  model?: string,
): Promise<FetchResult> {
  if (model) {
    return _do_fetch(baseUrl, apiKey, model, url);
  }

  const { data: models } = await get_web_models(baseUrl, apiKey, "webFetch");
  if (models.length === 0) {
    throw new Error("No webFetch providers available");
  }

  const errors: string[] = [];
  for (const m of models) {
    const provider = toProvider(m.id);
    try {
      return await _do_fetch(baseUrl, apiKey, provider, url);
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All webFetch providers failed:\n${errors.join("\n")}`);
}
