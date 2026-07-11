import { describe, expect, it, vi } from "vitest";
import {
  LocalKeyPool,
  type CredentialLease,
  type KeyPool,
} from "../../src/key-pool.js";
import {
  TavilyClient,
  TavilyToolError,
  type SearchInput,
} from "../../src/tavily-client.js";

const SESSION_ID = "session-test-1";
const TEST_KEY = "test-key-alpha";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function captureFetch(handler: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req);
    return handler(req);
  };
  return { fetchFn, requests };
}

async function clientWithKey(
  fetchFn: typeof fetch,
  keys: string[] = [TEST_KEY],
  extras: Partial<ConstructorParameters<typeof TavilyClient>[0]> = {},
): Promise<TavilyClient> {
  const keyPool = await LocalKeyPool.create(keys);
  return new TavilyClient({
    keyPool,
    fetchFn,
    sessionId: SESSION_ID,
    sleep: async () => undefined,
    ...extras,
  });
}

const searchOkBody = {
  query: "hello",
  answer: "world",
  images: [{ url: "https://img.example/a.png", description: "a" }],
  results: [
    {
      title: "T",
      url: "https://example.com",
      content: "c",
      score: 0.9,
      published_date: "2026-01-01",
      raw_content: "raw",
      favicon: "https://example.com/favicon.ico",
      extra_provider_field: "drop-me",
    },
  ],
  response_time: "1.25",
  request_id: "req-1",
  usage: { credits: 1, plan: "free" },
  undocumented: true,
};

const extractOkBody = {
  results: [
    {
      url: "https://example.com",
      raw_content: "body",
      images: ["https://img.example/x.png"],
      favicon: "https://example.com/f.ico",
      noise: 1,
    },
  ],
  failed_results: [{ url: "https://bad.example", error: "timeout", code: 99 }],
  response_time: 0.5,
  request_id: "req-e",
  usage: { credits: 2 },
  extra: "x",
};

const crawlOkBody = {
  base_url: "https://example.com",
  results: [{ url: "https://example.com/a", raw_content: "a", favicon: "f" }],
  response_time: "2",
  request_id: "req-c",
  usage: { credits: 3 },
  junk: true,
};

const mapOkBody = {
  base_url: "https://example.com",
  results: ["https://example.com/a", "https://example.com/b"],
  response_time: 1,
  request_id: "req-m",
  usage: { credits: 1 },
  junk: true,
};

describe("TavilyClient request headers and body", () => {
  it("API-key mode sends Authorization Bearer and never writes api_key into JSON", async () => {
    const { fetchFn, requests } = captureFetch(() => jsonResponse(searchOkBody));
    const client = await clientWithKey(fetchFn);

    await client.search({ query: "hello" });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.tavily.com/search");
    expect(req.headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(req.headers.get("X-Client-Source")).toBe("MCP");
    expect(req.headers.get("accept")).toBe("application/json");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("X-Session-Id")).toBe(SESSION_ID);
    expect(req.headers.get("X-Tavily-Access-Mode")).toBeNull();

    const body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
    expect(body).toEqual({ query: "hello" });
    expect(body).not.toHaveProperty("api_key");
  });

  it("includes X-Human-Id when provided", async () => {
    const { fetchFn, requests } = captureFetch(() => jsonResponse(searchOkBody));
    const client = await clientWithKey(fetchFn, [TEST_KEY], { humanId: "human-1" });
    await client.search({ query: "q" });
    expect(requests[0]!.headers.get("X-Human-Id")).toBe("human-1");
  });

  it("keyless search/extract send existing keyless headers", async () => {
    const { fetchFn, requests } = captureFetch(() => jsonResponse(searchOkBody));
    const client = await clientWithKey(fetchFn, []);

    await client.search({ query: "hello" });
    await client.extract({ urls: ["https://example.com"] });

    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.headers.get("Authorization")).toBeNull();
      expect(req.headers.get("X-Tavily-Access-Mode")).toBe("keyless");
      expect(req.headers.get("X-Client-Source")).toBe("tavily-mcp-keyless");
      expect(req.headers.get("X-Session-Id")).toBe(SESSION_ID);
      const body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("api_key");
    }
  });
});

describe("TavilyClient response normalization", () => {
  it("search projects approved fields and normalizes timing", async () => {
    const { fetchFn } = captureFetch(() => jsonResponse(searchOkBody));
    const client = await clientWithKey(fetchFn);
    const out = await client.search({ query: "hello" });

    expect(out).toEqual({
      query: "hello",
      answer: "world",
      images: [{ url: "https://img.example/a.png", description: "a" }],
      results: [
        {
          title: "T",
          url: "https://example.com",
          content: "c",
          score: 0.9,
          published_date: "2026-01-01",
          raw_content: "raw",
          favicon: "https://example.com/favicon.ico",
        },
      ],
      response_time: 1.25,
      request_id: "req-1",
      usage: { credits: 1 },
    });
    expect(out).not.toHaveProperty("undocumented");
    expect(out.results[0]).not.toHaveProperty("extra_provider_field");
  });

  it("extract/crawl/map strip unknown fields and coerce response_time", async () => {
    const bodies = [extractOkBody, crawlOkBody, mapOkBody];
    let i = 0;
    const { fetchFn } = captureFetch(() => jsonResponse(bodies[i++]!));
    const client = await clientWithKey(fetchFn);

    const extract = await client.extract({ urls: ["https://example.com"] });
    expect(extract).toEqual({
      results: [
        {
          url: "https://example.com",
          raw_content: "body",
          images: ["https://img.example/x.png"],
          favicon: "https://example.com/f.ico",
        },
      ],
      failed_results: [{ url: "https://bad.example", error: "timeout" }],
      response_time: 0.5,
      request_id: "req-e",
      usage: { credits: 2 },
    });

    const crawl = await client.crawl({ url: "https://example.com" });
    expect(crawl).toEqual({
      base_url: "https://example.com",
      results: [{ url: "https://example.com/a", raw_content: "a", favicon: "f" }],
      response_time: 2,
      request_id: "req-c",
      usage: { credits: 3 },
    });

    const map = await client.map({ url: "https://example.com" });
    expect(map).toEqual({
      base_url: "https://example.com",
      results: ["https://example.com/a", "https://example.com/b"],
      response_time: 1,
      request_id: "req-m",
      usage: { credits: 1 },
    });
  });

  it("research start accepts only the normalized pending shape", async () => {
    const body = {
      request_id: "r1",
      created_at: "2026-07-11T00:00:00Z",
      status: "pending",
      input: "topic",
      model: "auto",
      response_time: "0.1",
      extra: "drop",
    };
    const { fetchFn, requests } = captureFetch(() => jsonResponse(body, 201));
    const client = await clientWithKey(fetchFn);
    const { result, credentialFingerprint } = await client.researchStart({
      input: "topic",
      model: "auto",
    });

    expect(requests[0]!.url).toBe("https://api.tavily.com/research");
    expect(requests[0]!.method).toBe("POST");
    expect(credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({
      request_id: "r1",
      created_at: "2026-07-11T00:00:00Z",
      status: "pending",
      input: "topic",
      model: "auto",
      response_time: 0.1,
    });
  });

  it("research get accepts pending/in_progress/completed/failed with finite response_time", async () => {
    const fingerprint = await (await LocalKeyPool.create([TEST_KEY])).acquire().then(l => l.fingerprint);
    const variants = [
      { request_id: "r1", status: "pending", response_time: "1" },
      { request_id: "r1", status: "in_progress", response_time: 2 },
      {
        request_id: "r1",
        created_at: "2026-07-11T00:00:00Z",
        status: "completed",
        content: "report",
        sources: [{ title: "S", url: "https://s.example", favicon: "f", noise: 1 }],
        response_time: "3.5",
        extra: true,
      },
      { request_id: "r1", status: "failed", response_time: 4 },
    ];
    let i = 0;
    const { fetchFn, requests } = captureFetch(() => jsonResponse(variants[i++]!));
    const client = await clientWithKey(fetchFn);

    expect(await client.researchGet("r1", fingerprint)).toEqual({
      request_id: "r1",
      status: "pending",
      response_time: 1,
    });
    expect(await client.researchGet("r1", fingerprint)).toEqual({
      request_id: "r1",
      status: "in_progress",
      response_time: 2,
    });
    expect(await client.researchGet("r1", fingerprint)).toEqual({
      request_id: "r1",
      created_at: "2026-07-11T00:00:00Z",
      status: "completed",
      content: "report",
      sources: [{ title: "S", url: "https://s.example", favicon: "f" }],
      response_time: 3.5,
    });
    expect(await client.researchGet("r1", fingerprint)).toEqual({
      request_id: "r1",
      status: "failed",
      response_time: 4,
    });

    for (const req of requests) {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("https://api.tavily.com/research/r1");
    }
  });

  it("search normalizes string images to SourceImage objects", async () => {
    const body = {
      ...searchOkBody,
      images: ["https://img.example/b.png", { url: "https://img.example/c.png", description: "c" }],
    };
    const { fetchFn } = captureFetch(() => jsonResponse(body));
    const client = await clientWithKey(fetchFn);
    const out = await client.search({ query: "hello" });

    expect(out.images).toEqual([
      { url: "https://img.example/b.png" },
      { url: "https://img.example/c.png", description: "c" },
    ]);
  });

  it("maps malformed 200 responses to TAVILY_UPSTREAM_ERROR", async () => {
    const { fetchFn } = captureFetch(() => jsonResponse({ not: "a search response" }));
    const client = await clientWithKey(fetchFn);
    await expect(client.search({ query: "q" })).rejects.toMatchObject({
      code: "TAVILY_UPSTREAM_ERROR",
    });
  });
});

describe("TavilyClient key pool errors", () => {
  it("returns KEY_POOL_NOT_CONFIGURED for empty pool on key-required ops", async () => {
    const { fetchFn, requests } = captureFetch(() => jsonResponse(crawlOkBody));
    const client = await clientWithKey(fetchFn, []);

    await expect(client.crawl({ url: "https://example.com" })).rejects.toMatchObject({
      code: "KEY_POOL_NOT_CONFIGURED",
    });
    await expect(client.map({ url: "https://example.com" })).rejects.toMatchObject({
      code: "KEY_POOL_NOT_CONFIGURED",
    });
    await expect(client.researchStart({ input: "x" })).rejects.toMatchObject({
      code: "KEY_POOL_NOT_CONFIGURED",
    });
    expect(requests).toHaveLength(0);
  });

  it("returns KEY_POOL_UNAVAILABLE when every key is quarantined", async () => {
    const pool = await LocalKeyPool.create([TEST_KEY], {
      quarantineMs: 60_000,
      now: () => 0,
    });
    const lease = await pool.acquire();
    await pool.reportAuthFailure(lease.fingerprint);

    const { fetchFn, requests } = captureFetch(() => jsonResponse(searchOkBody));
    const client = new TavilyClient({
      keyPool: pool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep: async () => undefined,
    });

    await expect(client.search({ query: "q" })).rejects.toMatchObject({
      code: "KEY_POOL_UNAVAILABLE",
    });
    expect(requests).toHaveLength(0);
  });

  it("researchGet returns RESEARCH_KEY_UNAVAILABLE when fingerprint cannot be resolved", async () => {
    const { fetchFn, requests } = captureFetch(() => jsonResponse({}));
    const client = await clientWithKey(fetchFn, [TEST_KEY]);
    await expect(client.researchGet("r1", "missing-fingerprint")).rejects.toMatchObject({
      code: "RESEARCH_KEY_UNAVAILABLE",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("TavilyClient provider error mapping", () => {
  it("confirmed 401 calls reportAuthFailure and maps to TAVILY_AUTH_FAILED", async () => {
    const reportAuthFailure = vi.fn(async () => undefined);
    const acquire = vi.fn(async (): Promise<CredentialLease> => ({
      mode: "api-key",
      key: TEST_KEY,
      fingerprint: "fp-1",
    }));
    const keyPool: KeyPool = {
      acquire,
      resolve: async () => null,
      reportAuthFailure,
    };
    const { fetchFn } = captureFetch(() =>
      jsonResponse({ detail: "invalid key" }, 401),
    );
    const client = new TavilyClient({
      keyPool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep: async () => undefined,
    });

    await expect(client.search({ query: "q" })).rejects.toMatchObject({
      code: "TAVILY_AUTH_FAILED",
    });
    expect(reportAuthFailure).toHaveBeenCalledTimes(1);
    expect(reportAuthFailure).toHaveBeenCalledWith("fp-1");
  });

  it.each([
    [403, "TAVILY_UPSTREAM_ERROR"],
    [429, "TAVILY_RATE_LIMITED"],
    [432, "TAVILY_PLAN_LIMIT_REACHED"],
    [433, "TAVILY_PLAN_LIMIT_REACHED"],
  ] as const)(
    "status %i maps to %s without reportAuthFailure",
    async (status, code) => {
      const reportAuthFailure = vi.fn(async () => undefined);
      const keyPool: KeyPool = {
        acquire: async () => ({
          mode: "api-key",
          key: TEST_KEY,
          fingerprint: "fp-1",
        }),
        resolve: async () => null,
        reportAuthFailure,
      };
      const { fetchFn } = captureFetch(() =>
        jsonResponse({ detail: "nope" }, status, { "Retry-After": "60" }),
      );
      const client = new TavilyClient({
        keyPool,
        fetchFn,
        sessionId: SESSION_ID,
        sleep: async () => undefined,
      });

      try {
        await client.search({ query: "q" });
        throw new Error("expected failure");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TavilyToolError);
        const toolError = error as TavilyToolError;
        expect(toolError.code).toBe(code);
        if (status === 429) {
          expect(toolError.retryable).toBe(true);
          expect(toolError.retryAfterSeconds).toBe(60);
        }
      }
      expect(reportAuthFailure).not.toHaveBeenCalled();
    },
  );
});

describe("TavilyClient retries", () => {
  it("read ops retry once on network/5xx with the same lease", async () => {
    const acquire = vi.fn(async (): Promise<CredentialLease> => ({
      mode: "api-key",
      key: TEST_KEY,
      fingerprint: "fp-same",
    }));
    const keyPool: KeyPool = {
      acquire,
      resolve: async () => null,
      reportAuthFailure: async () => undefined,
    };

    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const { fetchFn, requests } = captureFetch(() => {
      calls += 1;
      if (calls === 1) return jsonResponse({ detail: "boom" }, 503);
      return jsonResponse(searchOkBody);
    });

    const client = new TavilyClient({
      keyPool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep,
    });

    const out = await client.search({ query: "hello" } satisfies SearchInput);
    expect(out.query).toBe("hello");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    for (const req of requests) {
      expect(req.headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
    }
  });

  it("read ops retry once on network failure with the same lease", async () => {
    const acquire = vi.fn(async (): Promise<CredentialLease> => ({
      mode: "api-key",
      key: TEST_KEY,
      fingerprint: "fp-same",
    }));
    const keyPool: KeyPool = {
      acquire,
      resolve: async () => null,
      reportAuthFailure: async () => undefined,
    };

    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const { fetchFn } = captureFetch(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return jsonResponse(searchOkBody);
    });

    const client = new TavilyClient({
      keyPool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep,
    });

    await expect(client.search({ query: "hello" })).resolves.toMatchObject({
      query: "hello",
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("research start never retries", async () => {
    const acquire = vi.fn(async (): Promise<CredentialLease> => ({
      mode: "api-key",
      key: TEST_KEY,
      fingerprint: "fp-1",
    }));
    const keyPool: KeyPool = {
      acquire,
      resolve: async () => null,
      reportAuthFailure: async () => undefined,
    };
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const { fetchFn, requests } = captureFetch(() => {
      calls += 1;
      return jsonResponse({ detail: "temp" }, 503);
    });
    const client = new TavilyClient({
      keyPool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep,
    });

    await expect(client.researchStart({ input: "x" })).rejects.toMatchObject({
      code: "TAVILY_UPSTREAM_ERROR",
    });
    expect(calls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("does not retry when reportAuthFailure throws on 401; still maps TAVILY_AUTH_FAILED", async () => {
    const reportAuthFailure = vi.fn(async () => {
      throw new Error("quarantine store failed");
    });
    const acquire = vi.fn(async (): Promise<CredentialLease> => ({
      mode: "api-key",
      key: TEST_KEY,
      fingerprint: "fp-1",
    }));
    const keyPool: KeyPool = {
      acquire,
      resolve: async () => null,
      reportAuthFailure,
    };
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const { fetchFn, requests } = captureFetch(() => {
      calls += 1;
      return jsonResponse({ detail: "invalid key" }, 401);
    });
    const client = new TavilyClient({
      keyPool,
      fetchFn,
      sessionId: SESSION_ID,
      sleep,
    });

    await expect(client.search({ query: "q" })).rejects.toMatchObject({
      code: "TAVILY_AUTH_FAILED",
    });
    expect(calls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(reportAuthFailure).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
