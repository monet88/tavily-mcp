import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWorkerRequest } from "../../src/worker.js";
import { TavilyCoordinator } from "../../src/coordinator.js";
import { fingerprintKey } from "../../src/key-pool.js";

// Prefer the non-deprecated worker export surface.
const workerFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  exports.default.fetch(input, init);

// Public MCP path (no capability token by default).
const MCP_URL = "https://example.com/mcp";

const WORKER_TOOL_NAMES = [
  "tavily_search",
  "tavily_extract",
  "tavily_crawl",
  "tavily_map",
  "tavily_research_start",
  "tavily_research_get",
] as const;

function mcpPost(
  body: unknown,
  init: {
    origin?: string | null;
    headers?: Record<string, string>;
    url?: string;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(init.headers ?? {}),
  });
  if (init.origin === undefined) {
    // default: no Origin
  } else if (init.origin !== null) {
    headers.set("Origin", init.origin);
  }
  return new Request(init.url ?? MCP_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

const toolsListBody = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

describe("Worker routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GET /health returns status/version without secrets", async () => {
    const response = await workerFetch("https://example.com/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", version: "0.2.21" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("tvly-");
    expect(text).not.toContain("TAVILY");
  });

  it("returns 404 for non-mcp paths and query strings", async () => {
    const wrongPath = await workerFetch("https://example.com/mcp/wrong-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    expect(wrongPath.status).toBe(404);

    const queryToken = await workerFetch(
      "https://example.com/mcp?token=leak",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(initializeBody),
      },
    );
    expect(queryToken.status).toBe(404);

    const root = await workerFetch("https://example.com/", { method: "POST" });
    expect(root.status).toBe(404);
  });

  it("returns 503 without configuration details when keys are missing", async () => {
    const bareEnv = {
      TAVILY_COORDINATOR: env.TAVILY_COORDINATOR,
    } as unknown as Env;
    const response = await handleWorkerRequest(
      mcpPost(initializeBody),
      bareEnv,
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe("Service unavailable");
    expect(text).not.toContain("TAVILY_API_KEY");
    expect(text).not.toContain("MCP_PATH_TOKEN");
  });

  it("returns 405 for unsupported methods on the exact MCP path", async () => {
    const get = await workerFetch(MCP_URL, { method: "GET" });
    expect(get.status).toBe(405);

    const del = await workerFetch(MCP_URL, { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("handles CORS preflight and echoes Access-Control-Allow-Origin on POST", async () => {
    const preflight = await workerFetch(
      new Request(MCP_URL, {
        method: "OPTIONS",
        headers: {
          Origin: "https://chatgpt.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://chatgpt.com",
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
    const allowHeaders =
      preflight.headers.get("Access-Control-Allow-Headers") ?? "";
    // Browser MCP clients (ChatGPT) send MCP-Protocol-Version on every POST;
    // preflight must allow it or the real tools/list|call is blocked.
    expect(allowHeaders.toLowerCase()).toContain("mcp-protocol-version");
    expect(allowHeaders.toLowerCase()).toContain("mcp-session-id");
    expect(allowHeaders.toLowerCase()).toContain("mcp-method");
    expect(allowHeaders.toLowerCase()).toContain("mcp-name");

    const post = await workerFetch(
      mcpPost(initializeBody, { origin: "https://chatgpt.com" }),
    );
    expect(post.status).toBe(200);
    expect(post.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://chatgpt.com",
    );
  });

  it("enforces Origin allowlist; missing Origin and exact match pass", async () => {
    const blocked = await workerFetch(
      mcpPost(initializeBody, { origin: "https://evil.example" }),
    );
    expect(blocked.status).toBe(403);

    const missing = await workerFetch(mcpPost(initializeBody));
    expect(missing.status).toBe(200);

    const allowed = await workerFetch(
      mcpPost(initializeBody, { origin: "https://chatgpt.com" }),
    );
    expect(allowed.status).toBe(200);
  });

  it("rejects oversized declared-length and streamed bodies with 413; malformed with 400", async () => {
    const oversized = await workerFetch(
      mcpPost("{}", {
        headers: { "content-length": String(2_000_000) },
      }),
    );
    expect(oversized.status).toBe(413);

    // Stream more bytes than the limit without relying on Content-Length.
    const max = 1_048_576;
    const big = "x".repeat(max + 10);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await workerFetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: stream,
        // @ts-expect-error duplex required for streaming request body in some runtimes
        duplex: "half",
      }),
    );
    expect(chunked.status).toBe(413);

    const badJson = await workerFetch(mcpPost("{not-json"));
    expect(badJson.status).toBe(400);
  });

  it("returns 503 when MCP_ENABLED=false", async () => {
    const disabledEnv = {
      ...env,
      MCP_ENABLED: "false",
      TAVILY_API_KEY: "tvly-test-key-1,tvly-test-key-2",
    } as unknown as Env;
    const response = await handleWorkerRequest(
      mcpPost(initializeBody),
      disabledEnv,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service unavailable");
  });

  it("returns 429 with Retry-After when request/minute or request/day limits hit", async () => {
    const stub = env.TAVILY_COORDINATOR.get(
      env.TAVILY_COORDINATOR.idFromName("global"),
    ) as DurableObjectStub<TavilyCoordinator>;

    // Exhaust the minute budget for the shared global coordinator.
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("DELETE FROM counters");
      const nowMs = Date.now();
      for (let i = 0; i < 120; i += 1) {
        const decision = instance.allowMcpRequestSync({
          nowMs,
          mcpDailyRequestLimit: 10_000,
          mcpRequestsPerMinute: 120,
        });
        expect(decision.allowed).toBe(true);
      }
    });

    const limited = await workerFetch(mcpPost(initializeBody));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();

    // Daily limit path via isolated env override + fresh prefill on same DO
    // (still global DO; set daily limit to 1 after clearing is hard — use handleWorkerRequest
    // with mcpDailyRequestLimit=1 after pre-consuming one slot with that limit).
    await runInDurableObject(stub, async (instance, state) => {
      // Reset counters so daily test is deterministic.
      state.storage.sql.exec("DELETE FROM counters");
      const decision = instance.allowMcpRequestSync({
        nowMs: Date.now(),
        mcpDailyRequestLimit: 1,
        mcpRequestsPerMinute: 10_000,
      });
      expect(decision.allowed).toBe(true);
    });

    const dayLimited = await handleWorkerRequest(mcpPost(initializeBody), {
      ...env,
      TAVILY_API_KEY: "tvly-test-key-1",
      MCP_ENABLED: "true",
      MCP_DAILY_REQUEST_LIMIT: "1",
      MCP_REQUESTS_PER_MINUTE: "10000",
    } as unknown as Env);
    expect(dayLimited.status).toBe(429);
    expect(dayLimited.headers.get("Retry-After")).toBeTruthy();
  });

  it("initialize POST returns a valid MCP response", async () => {
    // Use a fresh DO minute budget by waiting is flaky; counters may be full from prior test.
    // Clear counters on global DO first.
    const stub = env.TAVILY_COORDINATOR.get(
      env.TAVILY_COORDINATOR.idFromName("global"),
    ) as DurableObjectStub<TavilyCoordinator>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM counters");
    });

    const response = await workerFetch(mcpPost(initializeBody));
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      jsonrpc?: string;
      id?: number;
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
      error?: unknown;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.protocolVersion).toBeTruthy();
    expect(body.result?.serverInfo?.name).toBe("tavily-mcp");
  });

  it("tools/list returns the six Worker tools and schemas", async () => {
    const stub = env.TAVILY_COORDINATOR.get(
      env.TAVILY_COORDINATOR.idFromName("global"),
    ) as DurableObjectStub<TavilyCoordinator>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM counters");
    });

    const response = await workerFetch(mcpPost(toolsListBody));
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      result?: {
        tools?: Array<{
          name: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
          annotations?: unknown;
        }>;
      };
    };
    const tools = body.result?.tools ?? [];
    expect(tools.map(tool => tool.name)).toEqual([...WORKER_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.annotations).toBeTruthy();
    }
    expect(tools.some(tool => tool.name === "tavily_research")).toBe(false);
  });

  it("tool call uses coordinator-selected key without exposing it", async () => {
    const stub = env.TAVILY_COORDINATOR.get(
      env.TAVILY_COORDINATOR.idFromName("global"),
    ) as DurableObjectStub<TavilyCoordinator>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM counters");
    });

    const seenAuth: string[] = [];
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("api.tavily.com")) {
          const headers = new Headers(init?.headers);
          seenAuth.push(headers.get("Authorization") ?? "");
          return new Response(
            JSON.stringify({
              query: "hello",
              results: [
                {
                  title: "t",
                  url: "https://example.com",
                  content: "c",
                  score: 0.9,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return originalFetch(input as RequestInfo, init);
      },
    );

    const callBody = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tavily_search",
        arguments: { query: "hello" },
      },
    };

    const response = await workerFetch(mcpPost(callBody));
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("tvly-test-key-1");
    expect(bodyText).not.toContain("tvly-test-key-2");
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth[0]).toMatch(/^Bearer tvly-test-key-/);
    // Coordinator selected a pool key; fingerprint must not leak in body.
    const fp1 = await fingerprintKey("tvly-test-key-1");
    const fp2 = await fingerprintKey("tvly-test-key-2");
    expect(bodyText).not.toContain(fp1);
    expect(bodyText).not.toContain(fp2);

    const body = JSON.parse(bodyText) as {
      result?: { isError?: boolean; structuredContent?: { query?: string } };
    };
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.query).toBe("hello");
  });

  it("MCP_PATH_TOKEN gates the path when set (overrides public mode)", async () => {
    const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const response = await handleWorkerRequest(mcpPost(initializeBody), {
      ...env,
      TAVILY_API_KEY: "tvly-test-key-1",
      MCP_PATH_TOKEN: token,
      MCP_ALLOW_PUBLIC: "false",
      MCP_ENABLED: "true",
    } as unknown as Env);
    expect(response.status).toBe(404);

    const gated = await handleWorkerRequest(
      mcpPost(initializeBody, { url: `https://example.com/mcp/${token}` }),
      {
        ...env,
        TAVILY_API_KEY: "tvly-test-key-1",
        MCP_PATH_TOKEN: token,
        MCP_ALLOW_PUBLIC: "false",
        MCP_ENABLED: "true",
      } as unknown as Env,
    );
    expect(gated.status).toBe(200);
  });

  it("returns 503 when neither MCP_PATH_TOKEN nor MCP_ALLOW_PUBLIC is set", async () => {
    const response = await handleWorkerRequest(mcpPost(initializeBody), {
      ...env,
      TAVILY_API_KEY: "tvly-test-key-1",
      MCP_ENABLED: "true",
      MCP_ALLOW_PUBLIC: "false",
      MCP_PATH_TOKEN: undefined,
    } as unknown as Env);
    // loadConfig fails closed → generic 503
    expect(response.status).toBe(503);
  });
});
