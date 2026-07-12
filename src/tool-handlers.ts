import type { KeyPool } from "./key-pool.js";
import {
  isKeylessEnvelope,
  type CrawlInput,
  type ExtractInput,
  type MapInput,
  type ResearchStartInput,
  type SearchInput,
  type TavilyClient,
} from "./tavily-client.js";
import type {
  CrawlOutput,
  ExtractOutput,
  MapOutput,
  ResearchGetOutput,
  ResearchStartOutput,
  SearchOutput,
} from "./tavily-schemas.js";
import { runLegacyResearch } from "./legacy-research.js";
import type { ResearchGetInput, ResearchSyncOutput } from "./tool-catalog.js";

export interface ResearchJobRecord {
  requestId: string;
  fingerprint: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  terminalStatus?: string | null;
}

export interface ResearchStore {
  put(job: {
    requestId: string;
    fingerprint: string;
    tokenHash: string;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<void>;
  get(requestId: string): Promise<ResearchJobRecord | null>;
  markTerminal?(
    requestId: string,
    status: "completed" | "failed",
  ): Promise<void>;
}

export interface MemoryResearchStoreOptions {
  ttlSeconds: number;
  now?: () => number;
}

/** In-process research metadata store for the stdio CLI. */
export class MemoryResearchStore implements ResearchStore {
  private readonly jobs = new Map<string, ResearchJobRecord>();
  private readonly now: () => number;

  constructor(options: MemoryResearchStoreOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async put(job: {
    requestId: string;
    fingerprint: string;
    tokenHash: string;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<void> {
    this.sweep();
    this.jobs.set(job.requestId, {
      requestId: job.requestId,
      fingerprint: job.fingerprint,
      tokenHash: job.tokenHash,
      createdAtMs: job.createdAtMs,
      expiresAtMs: job.expiresAtMs,
      terminalStatus: null,
    });
  }

  async get(requestId: string): Promise<ResearchJobRecord | null> {
    this.sweep();
    return this.jobs.get(requestId) ?? null;
  }

  async markTerminal(
    requestId: string,
    status: "completed" | "failed",
  ): Promise<void> {
    const existing = this.jobs.get(requestId);
    if (!existing) return;
    this.jobs.set(requestId, { ...existing, terminalStatus: status });
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAtMs <= nowMs) this.jobs.delete(id);
    }
  }
}

export interface ToolHandlerDeps {
  client: TavilyClient;
  researchStore: ResearchStore;
  defaultParameters?: Record<string, unknown>;
  credentialMode?: "api-key" | "keyless";
  researchJobTtlSeconds?: number;
  now?: () => number;
  streamFetch?: typeof fetch;
  sessionId?: string;
  humanId?: string;
  keyPool?: KeyPool;
}

export interface HandlerSuccess<T extends Record<string, unknown>> {
  ok: true;
  data: T;
  legacyText?: string;
}

export interface HandlerFailure {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  legacyText?: string;
}

export type HandlerResult<T extends Record<string, unknown>> =
  | HandlerSuccess<T>
  | HandlerFailure;

/**
 * Per-tool allowlists for DEFAULT_PARAMETERS force-overrides.
 *
 * DEFAULT_PARAMETERS is one shared JSON blob. Without scoping, Search-only
 * keys (e.g. search_depth) would leak into Extract/Crawl/Map and can trip
 * upstream validation. Legacy CLI only overwrote keys on the endpoint
 * payload object; these sets mirror each tool's supported input fields.
 */
const SEARCH_DEFAULT_KEYS = [
  "query",
  "search_depth",
  "topic",
  "time_range",
  "start_date",
  "end_date",
  "max_results",
  "include_images",
  "include_image_descriptions",
  "include_raw_content",
  "include_domains",
  "exclude_domains",
  "country",
  "include_favicon",
  "exact_match",
] as const;

const EXTRACT_DEFAULT_KEYS = [
  "urls",
  "extract_depth",
  "include_images",
  "format",
  "include_favicon",
  "query",
] as const;

const CRAWL_DEFAULT_KEYS = [
  "url",
  "max_depth",
  "max_breadth",
  "limit",
  "instructions",
  "select_paths",
  "select_domains",
  "allow_external",
  "extract_depth",
  "format",
  "include_favicon",
  "chunks_per_source",
] as const;

const MAP_DEFAULT_KEYS = [
  "url",
  "max_depth",
  "max_breadth",
  "limit",
  "instructions",
  "select_paths",
  "select_domains",
  "allow_external",
] as const;

const RESEARCH_DEFAULT_KEYS = ["input", "model"] as const;

/**
 * Apply DEFAULT_PARAMETERS as a force override for keys supported by the
 * current tool. Defaults win over caller args (legacy + README).
 */
function applyDefaults(
  params: Record<string, unknown>,
  defaults: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      overrides[key] = defaults[key];
    }
  }
  const merged: Record<string, unknown> = { ...params, ...overrides };
  if ((merged.start_date || merged.end_date) && merged.time_range) {
    merged.time_range = undefined;
  }
  return merged;
}

function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function formatSearchResults(response: SearchOutput): string {
  const output: string[] = [];

  if (response.answer) {
    output.push(`Answer: ${response.answer}`);
  }

  output.push("Detailed Results:");
  response.results.forEach(result => {
    output.push(`\nTitle: ${result.title}`);
    output.push(`URL: ${result.url}`);
    output.push(`Content: ${result.content}`);
    if (result.raw_content) {
      output.push(`Raw Content: ${result.raw_content}`);
    }
    if (result.favicon) {
      output.push(`Favicon: ${result.favicon}`);
    }
  });

  if (response.images && response.images.length > 0) {
    output.push("\nImages:");
    response.images.forEach((image, index) => {
      output.push(`\n[${index + 1}] URL: ${image.url}`);
      if (image.description) {
        output.push(`   Description: ${image.description}`);
      }
    });
  }

  return output.join("\n");
}

/**
 * Legacy extract path reused the search formatter against a looser response.
 * Keep the same headings so existing clients still see Title/URL/Content lines.
 */
export function formatExtractResults(response: ExtractOutput): string {
  const output: string[] = [];
  output.push("Detailed Results:");
  response.results.forEach(result => {
    output.push(`\nTitle: ${result.url}`);
    output.push(`URL: ${result.url}`);
    output.push(`Content: ${result.raw_content}`);
    if (result.raw_content) {
      output.push(`Raw Content: ${result.raw_content}`);
    }
    if (result.favicon) {
      output.push(`Favicon: ${result.favicon}`);
    }
  });
  return output.join("\n");
}

export function formatCrawlResults(response: CrawlOutput): string {
  const output: string[] = [];

  output.push("Crawl Results:");
  output.push(`Base URL: ${response.base_url}`);

  output.push("\nCrawled Pages:");
  response.results.forEach((page, index) => {
    output.push(`\n[${index + 1}] URL: ${page.url}`);
    if (page.raw_content) {
      const contentPreview =
        page.raw_content.length > 200
          ? page.raw_content.substring(0, 200) + "..."
          : page.raw_content;
      output.push(`Content: ${contentPreview}`);
    }
    if (page.favicon) {
      output.push(`Favicon: ${page.favicon}`);
    }
  });

  return output.join("\n");
}

export function formatMapResults(response: MapOutput): string {
  const output: string[] = [];

  output.push("Site Map Results:");
  output.push(`Base URL: ${response.base_url}`);

  output.push("\nMapped Pages:");
  response.results.forEach((page, index) => {
    output.push(`\n[${index + 1}] URL: ${page}`);
  });

  return output.join("\n");
}

export function formatResearchResults(response: {
  content?: string;
  error?: string;
}): string {
  if (response.error) {
    return `Research Error: ${response.error}`;
  }
  return response.content || "No research results available";
}

export function formatKeylessEnvelope(data: {
  error: {
    message?: string;
    retry_after_seconds?: number;
    next_actions?: Array<Record<string, unknown>>;
  };
}): string {
  const err = data.error;
  const lines: string[] = [String(err.message ?? "")];
  if (err.retry_after_seconds != null) {
    lines.push(`Retry after: ${err.retry_after_seconds}s`);
  }
  if (Array.isArray(err.next_actions) && err.next_actions.length > 0) {
    lines.push("", "Continuation options:");
    for (const a of err.next_actions) {
      if (a?.type === "agentic_payment") {
        lines.push(
          `- Agentic payment (${String(a.scheme ?? "x402")}): ${String(a.details ?? "")}`,
        );
      } else if (a?.type === "signup") {
        lines.push(`- Sign up for a Tavily API key: ${String(a.url ?? "")}`);
      } else if (a?.type === "bonus_credits" && a.eligible) {
        lines.push(
          `- Earn ${String(a.credits_on_completion ?? "")} bonus credits by POSTing answers to ${String(a.endpoint ?? "")}`,
        );
        if (Array.isArray(a.questions)) {
          a.questions.forEach((q: unknown, i: number) =>
            lines.push(`    ${i + 1}. ${String(q)}`),
          );
        }
      }
    }
  }
  return lines.join("\n");
}

/** Exact keyless message when crawl/map/research need a key. */
export const KEYLESS_API_KEY_REQUIRED_MESSAGE =
  "A Tavily API key is required for this operation.";

export async function hashJobToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

export function mintJobToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // base64url without padding
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) {
    diff |= aa[i]! ^ bb[i]!;
  }
  return diff === 0;
}

function mapToolError(error: unknown): HandlerFailure {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    const toolError = error as {
      code: string;
      message: string;
      retryable?: boolean;
      retryAfterSeconds?: number;
      details?: unknown;
    };

    // Stdio preserves keyless recoverable envelope text.
    // Worker ignores legacyText and uses stable codes only.
    // Note: MCP outputSchema requires isError when structuredContent is absent.
    if (isKeylessEnvelope(toolError.details)) {
      const envelopeRetry =
        typeof toolError.details.error.retry_after_seconds === "number"
          ? toolError.details.error.retry_after_seconds
          : undefined;
      return {
        ok: false,
        code: toolError.code,
        message: toolError.message,
        retryable: toolError.retryable,
        retryAfterSeconds: toolError.retryAfterSeconds ?? envelopeRetry,
        legacyText: formatKeylessEnvelope(toolError.details),
      };
    }

    const legacyText =
      toolError.code === "KEY_POOL_NOT_CONFIGURED"
        ? KEYLESS_API_KEY_REQUIRED_MESSAGE
        : undefined;
    return {
      ok: false,
      code: toolError.code,
      message: toolError.message,
      retryable: toolError.retryable,
      retryAfterSeconds: toolError.retryAfterSeconds,
      legacyText,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: "TAVILY_UPSTREAM_ERROR",
    message,
  };
}

export function createToolHandlers(deps: ToolHandlerDeps) {
  const defaults = deps.defaultParameters ?? {};
  const now = deps.now ?? (() => Date.now());
  const ttlSeconds = deps.researchJobTtlSeconds ?? 86_400;

  async function search(
    raw: SearchInput,
  ): Promise<HandlerResult<SearchOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults({ ...raw }, defaults, SEARCH_DEFAULT_KEYS),
      ) as unknown as SearchInput;
      if (params.country) {
        params.topic = "general";
      }
      const data = await deps.client.search(params);
      return {
        ok: true,
        data: data as SearchOutput & Record<string, unknown>,
        legacyText: formatSearchResults(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function extract(
    raw: ExtractInput,
  ): Promise<HandlerResult<ExtractOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults({ ...raw }, defaults, EXTRACT_DEFAULT_KEYS),
      ) as unknown as ExtractInput;
      const data = await deps.client.extract(params);
      return {
        ok: true,
        data: data as ExtractOutput & Record<string, unknown>,
        legacyText: formatExtractResults(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function crawl(
    raw: CrawlInput,
  ): Promise<HandlerResult<CrawlOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults(
          {
            ...raw,
            chunks_per_source: 3,
          },
          defaults,
          CRAWL_DEFAULT_KEYS,
        ),
      ) as unknown as CrawlInput;
      const data = await deps.client.crawl(params);
      return {
        ok: true,
        data: data as CrawlOutput & Record<string, unknown>,
        legacyText: formatCrawlResults(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function map(
    raw: MapInput,
  ): Promise<HandlerResult<MapOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults({ ...raw }, defaults, MAP_DEFAULT_KEYS),
      ) as unknown as MapInput;
      const data = await deps.client.map(params);
      return {
        ok: true,
        data: data as MapOutput & Record<string, unknown>,
        legacyText: formatMapResults(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function researchStart(
    raw: ResearchStartInput,
  ): Promise<HandlerResult<ResearchStartOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults({ ...raw }, defaults, RESEARCH_DEFAULT_KEYS),
      ) as unknown as ResearchStartInput;
      const { result, credentialFingerprint } =
        await deps.client.researchStart(params);
      const createdAtMs = now();
      const jobToken = mintJobToken();
      const tokenHash = await hashJobToken(jobToken);
      await deps.researchStore.put({
        requestId: result.request_id,
        fingerprint: credentialFingerprint,
        tokenHash,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlSeconds * 1000,
      });
      const data = {
        ...result,
        job_token: jobToken,
      } as ResearchStartOutput & Record<string, unknown>;
      return {
        ok: true,
        data,
        legacyText: JSON.stringify(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function researchGet(
    raw: ResearchGetInput,
  ): Promise<HandlerResult<ResearchGetOutput & Record<string, unknown>>> {
    try {
      const job = await deps.researchStore.get(raw.request_id);
      if (!job) {
        return {
          ok: false,
          code: "RESEARCH_NOT_FOUND",
          message: "The research request was not found.",
        };
      }
      const providedHash = await hashJobToken(raw.job_token);
      if (!timingSafeEqualHex(providedHash, job.tokenHash)) {
        return {
          ok: false,
          code: "RESEARCH_NOT_FOUND",
          message: "The research request was not found.",
        };
      }
      const data = await deps.client.researchGet(
        raw.request_id,
        job.fingerprint,
      );
      if (
        (data.status === "completed" || data.status === "failed") &&
        deps.researchStore.markTerminal
      ) {
        await deps.researchStore.markTerminal(raw.request_id, data.status);
      }
      return {
        ok: true,
        data: data as ResearchGetOutput & Record<string, unknown>,
        legacyText: JSON.stringify(data),
      };
    } catch (error: unknown) {
      return mapToolError(error);
    }
  }

  async function research(
    raw: ResearchStartInput,
  ): Promise<HandlerResult<ResearchSyncOutput & Record<string, unknown>>> {
    try {
      const params = cleanParams(
        applyDefaults({ ...raw }, defaults, RESEARCH_DEFAULT_KEYS),
      ) as unknown as ResearchStartInput;
      const result = await runLegacyResearch({
        client: deps.client,
        input: params,
        keyPool: deps.keyPool,
        streamFetch: deps.streamFetch,
        sessionId: deps.sessionId,
        humanId: deps.humanId,
        sleep: async ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      const legacyText = formatResearchResults(result);
      if (result.error) {
        return {
          ok: false,
          code: "TAVILY_UPSTREAM_ERROR",
          message: result.error,
          legacyText,
        };
      }
      return {
        ok: true,
        data: { content: result.content ?? "" },
        legacyText,
      };
    } catch (error: unknown) {
      const mapped = mapToolError(error);
      if (mapped.code === "KEY_POOL_NOT_CONFIGURED") {
        return {
          ...mapped,
          legacyText: formatResearchResults({
            error: KEYLESS_API_KEY_REQUIRED_MESSAGE,
          }),
        };
      }
      // Preserve keyless envelope legacyText when present.
      if (mapped.legacyText !== undefined && mapped.code === "TAVILY_RATE_LIMITED") {
        return mapped;
      }
      // Also preserve any already-formatted keyless envelope text.
      if (
        mapped.legacyText !== undefined &&
        mapped.legacyText.includes("Continuation options:")
      ) {
        return mapped;
      }
      return {
        ...mapped,
        legacyText: formatResearchResults({ error: mapped.message }),
      };
    }
  }

  return {
    tavily_search: search,
    tavily_extract: extract,
    tavily_crawl: crawl,
    tavily_map: map,
    tavily_research_start: researchStart,
    tavily_research_get: researchGet,
    tavily_research: research,
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
