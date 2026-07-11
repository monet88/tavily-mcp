import type { CredentialLease, KeyPool } from "./key-pool.js";
import {
  CrawlOutputSchema,
  ExtractOutputSchema,
  MapOutputSchema,
  normalizeWithSchemas,
  ProviderCrawlResponseSchema,
  ProviderExtractResponseSchema,
  ProviderMapResponseSchema,
  ProviderResearchGetResponseSchema,
  ProviderResearchStartResponseSchema,
  ProviderSearchResponseSchema,
  ResearchGetOutputSchema,
  ResearchStartOutputSchema,
  SearchOutputSchema,
  type CrawlOutput,
  type ExtractOutput,
  type MapOutput,
  type ResearchGetOutput,
  type ResearchStartOutput,
  type SearchOutput,
} from "./tavily-schemas.js";

const DEFAULT_BASE_URL = "https://api.tavily.com";
const DEFAULT_RETRY_BACKOFF_MS = 250;

export type TavilyErrorCode =
  | "INVALID_INPUT"
  | "SERVICE_DISABLED"
  | "DAILY_LIMIT_REACHED"
  | "KEY_POOL_NOT_CONFIGURED"
  | "KEY_POOL_UNAVAILABLE"
  | "TAVILY_AUTH_FAILED"
  | "TAVILY_RATE_LIMITED"
  | "TAVILY_PLAN_LIMIT_REACHED"
  | "TAVILY_UPSTREAM_ERROR"
  | "RESEARCH_NOT_FOUND"
  | "RESEARCH_KEY_UNAVAILABLE"
  | "RESEARCH_STORAGE_FULL";

export class TavilyToolError extends Error {
  readonly code: TavilyErrorCode;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: TavilyErrorCode,
    message: string,
    options?: { retryable?: boolean; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "TavilyToolError";
    this.code = code;
    this.retryable = options?.retryable;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export interface SearchInput {
  query: string;
  search_depth?: "basic" | "advanced" | "fast" | "ultra-fast";
  topic?: "general";
  time_range?: "day" | "week" | "month" | "year";
  start_date?: string;
  end_date?: string;
  max_results?: number;
  include_images?: boolean;
  include_image_descriptions?: boolean;
  include_raw_content?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  country?: string;
  include_favicon?: boolean;
  exact_match?: boolean;
}

export interface ExtractInput {
  urls: string[];
  extract_depth?: "basic" | "advanced";
  include_images?: boolean;
  format?: "markdown" | "text";
  include_favicon?: boolean;
  query?: string;
}

export interface CrawlInput {
  url: string;
  max_depth?: number;
  max_breadth?: number;
  limit?: number;
  instructions?: string;
  select_paths?: string[];
  select_domains?: string[];
  allow_external?: boolean;
  extract_depth?: "basic" | "advanced";
  format?: "markdown" | "text";
  include_favicon?: boolean;
  chunks_per_source?: number;
}

export interface MapInput {
  url: string;
  max_depth?: number;
  max_breadth?: number;
  limit?: number;
  instructions?: string;
  select_paths?: string[];
  select_domains?: string[];
  allow_external?: boolean;
}

export interface ResearchStartInput {
  input: string;
  model?: "mini" | "pro" | "auto";
}

export interface TavilyClientOptions {
  keyPool: KeyPool;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  humanId?: string;
  sessionId: string;
  sleep?: (ms: number) => Promise<void>;
}

type HttpMethod = "GET" | "POST";

interface RequestSpec {
  method: HttpMethod;
  path: string;
  body?: Record<string, unknown>;
  /** When true, empty keyless pool is allowed (search/extract only). */
  allowKeyless: boolean;
  /** Retry once on network/5xx with the same lease. */
  retryable: boolean;
  /** Accept any 2xx; research start returns 201. */
  okStatus?: (status: number) => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanBody(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "api_key") continue;
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return undefined;
  const seconds = Math.ceil((dateMs - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function mapHttpError(
  status: number,
  retryAfterSeconds?: number,
): TavilyToolError {
  if (status === 401) {
    return new TavilyToolError(
      "TAVILY_AUTH_FAILED",
      "Tavily rejected the request because authentication failed.",
    );
  }
  if (status === 429) {
    return new TavilyToolError(
      "TAVILY_RATE_LIMITED",
      "Tavily rejected the request because its rate limit was reached.",
      { retryable: true, retryAfterSeconds },
    );
  }
  if (status === 432 || status === 433) {
    return new TavilyToolError(
      "TAVILY_PLAN_LIMIT_REACHED",
      "Tavily rejected the request because the plan limit was reached.",
    );
  }
  if (status === 404) {
    return new TavilyToolError(
      "RESEARCH_NOT_FOUND",
      "The research request was not found.",
    );
  }
  return new TavilyToolError(
    "TAVILY_UPSTREAM_ERROR",
    "Tavily returned an upstream error.",
    { retryable: status >= 500 },
  );
}

function buildHeaders(
  lease: CredentialLease,
  sessionId: string,
  humanId?: string,
): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "X-Session-Id": sessionId,
  });
  if (lease.mode === "api-key") {
    headers.set("Authorization", `Bearer ${lease.key}`);
    headers.set("X-Client-Source", "MCP");
  } else {
    headers.set("X-Tavily-Access-Mode", "keyless");
    headers.set("X-Client-Source", "tavily-mcp-keyless");
  }
  if (humanId) headers.set("X-Human-Id", humanId);
  return headers;
}

export class TavilyClient {
  private readonly keyPool: KeyPool;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly humanId?: string;
  private readonly sessionId: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TavilyClientOptions) {
    this.keyPool = options.keyPool;
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.humanId = options.humanId;
    this.sessionId = options.sessionId;
    this.sleep = options.sleep ?? defaultSleep;
  }

  search(input: SearchInput): Promise<SearchOutput> {
    return this.execute(
      {
        method: "POST",
        path: "/search",
        body: cleanBody({ ...input }),
        allowKeyless: true,
        retryable: true,
      },
      raw =>
        normalizeWithSchemas(
          ProviderSearchResponseSchema,
          SearchOutputSchema,
          raw,
        ),
    );
  }

  extract(input: ExtractInput): Promise<ExtractOutput> {
    return this.execute(
      {
        method: "POST",
        path: "/extract",
        body: cleanBody({ ...input }),
        allowKeyless: true,
        retryable: true,
      },
      raw =>
        normalizeWithSchemas(
          ProviderExtractResponseSchema,
          ExtractOutputSchema,
          raw,
        ),
    );
  }

  crawl(input: CrawlInput): Promise<CrawlOutput> {
    return this.execute(
      {
        method: "POST",
        path: "/crawl",
        body: cleanBody({ ...input }),
        allowKeyless: false,
        retryable: true,
      },
      raw =>
        normalizeWithSchemas(
          ProviderCrawlResponseSchema,
          CrawlOutputSchema,
          raw,
        ),
    );
  }

  map(input: MapInput): Promise<MapOutput> {
    return this.execute(
      {
        method: "POST",
        path: "/map",
        body: cleanBody({ ...input }),
        allowKeyless: false,
        retryable: true,
      },
      raw =>
        normalizeWithSchemas(ProviderMapResponseSchema, MapOutputSchema, raw),
    );
  }

  async researchStart(
    input: ResearchStartInput,
  ): Promise<{ result: ResearchStartOutput; credentialFingerprint: string }> {
    const lease = await this.acquireLease(false);
    const result = await this.executeWithLease(
      lease,
      {
        method: "POST",
        path: "/research",
        body: cleanBody({
          input: input.input,
          model: input.model ?? "auto",
        }),
        allowKeyless: false,
        retryable: false,
        okStatus: status => status >= 200 && status < 300,
      },
      raw =>
        normalizeWithSchemas(
          ProviderResearchStartResponseSchema,
          ResearchStartOutputSchema,
          raw,
        ),
    );
    return { result, credentialFingerprint: lease.fingerprint };
  }

  async researchGet(
    requestId: string,
    fingerprint: string,
  ): Promise<ResearchGetOutput> {
    const lease = await this.keyPool.resolve(fingerprint);
    if (!lease) {
      throw new TavilyToolError(
        "RESEARCH_KEY_UNAVAILABLE",
        "The credential used to create this research job is no longer available.",
      );
    }
    return this.executeWithLease(
      lease,
      {
        method: "GET",
        path: `/research/${encodeURIComponent(requestId)}`,
        allowKeyless: lease.mode === "keyless",
        retryable: true,
      },
      raw =>
        normalizeWithSchemas(
          ProviderResearchGetResponseSchema,
          ResearchGetOutputSchema,
          raw,
        ),
    );
  }

  private async acquireLease(allowKeyless: boolean): Promise<CredentialLease> {
    let lease: CredentialLease;
    try {
      lease = await this.keyPool.acquire();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("KEY_POOL_UNAVAILABLE")) {
        throw new TavilyToolError(
          "KEY_POOL_UNAVAILABLE",
          "No healthy Tavily API key is currently available.",
        );
      }
      throw error;
    }

    if (lease.mode === "keyless" && !allowKeyless) {
      throw new TavilyToolError(
        "KEY_POOL_NOT_CONFIGURED",
        "A Tavily API key is required for this operation.",
      );
    }
    return lease;
  }

  private async execute<T>(
    spec: RequestSpec,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const lease = await this.acquireLease(spec.allowKeyless);
    return this.executeWithLease(lease, spec, parse);
  }

  private async executeWithLease<T>(
    lease: CredentialLease,
    spec: RequestSpec,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    let attempt = 0;
    // attempt 0 = first try; attempt 1 = single retry for read ops
    while (true) {
      try {
        return await this.singleRequest(lease, spec, parse);
      } catch (error: unknown) {
        const canRetry =
          spec.retryable &&
          attempt === 0 &&
          this.isRetryableFailure(error);
        if (!canRetry) throw error;
        attempt += 1;
        await this.sleep(DEFAULT_RETRY_BACKOFF_MS);
      }
    }
  }

  private isRetryableFailure(error: unknown): boolean {
    if (error instanceof TavilyToolError) {
      return error.code === "TAVILY_UPSTREAM_ERROR" && error.retryable === true;
    }
    // Network / fetch failures (TypeError in browsers/Workers/Node undici).
    return error instanceof TypeError || error instanceof Error;
  }

  private async singleRequest<T>(
    lease: CredentialLease,
    spec: RequestSpec,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const url = `${this.baseUrl}${spec.path}`;
    const headers = buildHeaders(lease, this.sessionId, this.humanId);
    const init: RequestInit = {
      method: spec.method,
      headers,
    };
    if (spec.method !== "GET" && spec.body !== undefined) {
      // Never put api_key in the JSON body — auth is header-only.
      init.body = JSON.stringify(cleanBody(spec.body));
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error: unknown) {
      // Preserve TypeError so the retry path can detect network failures.
      throw error;
    }

    const isOk = spec.okStatus
      ? spec.okStatus(response.status)
      : response.status >= 200 && response.status < 300;

    if (!isOk) {
      if (response.status === 401 && lease.mode === "api-key") {
        await this.keyPool.reportAuthFailure(lease.fingerprint);
      }
      const retryAfterSeconds = parseRetryAfterSeconds(
        response.headers.get("Retry-After"),
      );
      // Consume body defensively; never surface provider payload.
      try {
        await response.text();
      } catch {
        // ignore body read failures
      }
      throw mapHttpError(response.status, retryAfterSeconds);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new TavilyToolError(
        "TAVILY_UPSTREAM_ERROR",
        "Tavily returned a malformed response body.",
      );
    }

    try {
      return parse(raw);
    } catch {
      throw new TavilyToolError(
        "TAVILY_UPSTREAM_ERROR",
        "Tavily returned a response that failed validation.",
      );
    }
  }
}

// re-export result types for convenience
export type {
  CrawlOutput,
  ExtractOutput,
  MapOutput,
  ResearchGetOutput,
  ResearchStartOutput,
  SearchOutput,
};
