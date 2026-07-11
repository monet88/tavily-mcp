import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type EnvMap } from "./config.js";
import {
  CoordinatedKeyPool,
  type CoordinatorPort,
} from "./key-pool.js";
import { createMcpServer } from "./server.js";
import { TavilyClient } from "./tavily-client.js";
import type {
  ResearchJobRecord,
  ResearchStore,
} from "./tool-handlers.js";
import type {
  ResearchJobInput,
  ResearchJobRecord as CoordinatorJobRecord,
} from "./coordinator.js";

export { TavilyCoordinator } from "./coordinator.js";

const WORKER_VERSION = "0.2.21";
const GLOBAL_COORDINATOR_NAME = "global";

type CoordinatorStub = {
  allowMcpRequest(input: {
    nowMs: number;
    mcpDailyRequestLimit: number;
    mcpRequestsPerMinute: number;
    mcpEnabled?: boolean;
  }): Promise<
    | { allowed: true }
    | {
        allowed: false;
        code: "SERVICE_DISABLED" | "DAILY_LIMIT_REACHED" | "RATE_LIMITED";
        retryAfterSeconds?: number;
      }
  >;
  acquireForTavily: CoordinatorPort["acquireForTavily"];
  quarantine: CoordinatorPort["quarantine"];
  putResearchJob(input: ResearchJobInput): Promise<void>;
  getResearchJob(requestId: string): Promise<CoordinatorJobRecord | null>;
  markResearchTerminal(
    requestId: string,
    status: "completed" | "failed",
  ): Promise<void>;
};

class CoordinatorResearchStore implements ResearchStore {
  constructor(private readonly stub: CoordinatorStub) {}

  put(job: {
    requestId: string;
    fingerprint: string;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<void> {
    return this.stub.putResearchJob(job);
  }

  async get(requestId: string): Promise<ResearchJobRecord | null> {
    const row = await this.stub.getResearchJob(requestId);
    if (!row) return null;
    return {
      requestId: row.requestId,
      fingerprint: row.fingerprint,
      createdAtMs: row.createdAtMs,
      expiresAtMs: row.expiresAtMs,
      terminalStatus: row.terminalStatus ?? null,
    };
  }

  markTerminal(
    requestId: string,
    status: "completed" | "failed",
  ): Promise<void> {
    return this.stub.markResearchTerminal(requestId, status);
  }
}

function healthResponse(): Response {
  return Response.json({ status: "ok", version: WORKER_VERSION });
}

function textResponse(status: number, body: string, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function envMap(env: Env): EnvMap {
  // Worker bindings are string | objects; loadConfig only reads string vars.
  const out: EnvMap = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function getCoordinatorStub(env: Env): CoordinatorStub {
  const id = env.TAVILY_COORDINATOR.idFromName(GLOBAL_COORDINATOR_NAME);
  return env.TAVILY_COORDINATOR.get(id) as unknown as CoordinatorStub;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      throw new SyntaxError("Invalid Content-Length");
    }
    if (Number(contentLength) > maxBytes) {
      throw new BodyTooLargeError();
    }
  }

  if (!request.body) {
    // Empty body is invalid JSON for MCP POSTs.
    throw new SyntaxError("Empty body");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as unknown;
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return healthResponse();
  }

  let config;
  try {
    config = loadConfig(envMap(env), "worker");
  } catch {
    return textResponse(503, "Service unavailable");
  }

  if (!config.mcpEnabled) {
    return textResponse(503, "Service unavailable");
  }

  // Public MCP at /mcp. Optional capability token when MCP_PATH_TOKEN is set.
  // Never accept credentials via query string.
  const mcpPath =
    config.mcpPathToken !== undefined
      ? `/mcp/${config.mcpPathToken}`
      : "/mcp";
  const pathOk =
    url.pathname === mcpPath ||
    (mcpPath === "/mcp" && (url.pathname === "/mcp" || url.pathname === "/mcp/"));
  if (url.search || !pathOk) {
    return textResponse(404, "Not found");
  }

  if (request.method !== "POST") {
    return textResponse(405, "Method not allowed");
  }

  const origin = request.headers.get("Origin");
  if (origin && !config.allowedOrigins.includes(origin)) {
    return textResponse(403, "Forbidden");
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readBoundedJson(request, config.mcpMaxRequestBodyBytes);
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      return textResponse(413, "Payload too large");
    }
    return textResponse(400, "Bad request");
  }

  const stub = getCoordinatorStub(env);
  const decision = await stub.allowMcpRequest({
    nowMs: Date.now(),
    mcpDailyRequestLimit: config.mcpDailyRequestLimit,
    mcpRequestsPerMinute: config.mcpRequestsPerMinute,
    mcpEnabled: config.mcpEnabled,
  });

  if (!decision.allowed) {
    if (decision.code === "SERVICE_DISABLED") {
      return textResponse(503, "Service unavailable");
    }
    const headers: Record<string, string> = {};
    if (decision.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(decision.retryAfterSeconds);
    } else if (decision.code === "DAILY_LIMIT_REACHED") {
      // ponytail: day-bucket retry; client can wait until next UTC day.
      headers["Retry-After"] = "86400";
    }
    return textResponse(429, "Too many requests", headers);
  }

  const coordinatorPort: CoordinatorPort = {
    acquireForTavily: input => stub.acquireForTavily(input),
    quarantine: input => stub.quarantine(input),
  };

  const keyPool = await CoordinatedKeyPool.create(
    config.apiKeys,
    coordinatorPort,
    {
      quarantineMs: config.keyQuarantineSeconds * 1000,
      tavilyDailyCallLimit: config.tavilyDailyCallLimit,
    },
  );

  const sessionId = crypto.randomUUID();
  const client = new TavilyClient({
    keyPool,
    sessionId,
    humanId: config.humanId,
  });

  const researchStore = new CoordinatorResearchStore(stub);
  const server = createMcpServer("worker", {
    client,
    researchStore,
    defaultParameters: config.defaultParameters,
    credentialMode: "api-key",
    researchJobTtlSeconds: config.researchJobTtlSeconds,
    sessionId,
    humanId: config.humanId,
    keyPool,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // JSON keeps stateless tool calls simple for ChatGPT + tests.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request, { parsedBody });
}

export default {
  fetch: handleWorkerRequest,
};
