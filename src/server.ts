import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeProfile } from "./config.js";
import type { KeyPool } from "./key-pool.js";
import type { TavilyClient } from "./tavily-client.js";
import { toolsForProfile } from "./tool-catalog.js";
import {
  createToolHandlers,
  type ResearchStore,
  type ToolHandlers,
} from "./tool-handlers.js";

export interface CreateMcpServerDeps {
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
  /** Optional prebuilt handlers (tests). */
  handlers?: ToolHandlers;
}

export function successResult(
  profile: RuntimeProfile,
  data: Record<string, unknown>,
  legacyText?: string,
): CallToolResult {
  return {
    structuredContent: data,
    content: [
      {
        type: "text" as const,
        text:
          profile === "stdio" && legacyText !== undefined
            ? legacyText
            : JSON.stringify(data),
      },
    ],
  };
}

export function errorResult(
  profile: RuntimeProfile,
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    legacyText?: string;
  },
): CallToolResult {
  const payload = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    },
  };

  const text =
    profile === "stdio" && error.legacyText !== undefined
      ? error.legacyText
      : JSON.stringify(payload);

  // MCP tools with outputSchema require isError when structuredContent is absent.
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

type AnyHandlerResult =
  | {
      ok: true;
      data: Record<string, unknown>;
      legacyText?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable?: boolean;
      retryAfterSeconds?: number;
      legacyText?: string;
    };

export function createMcpServer(
  profile: RuntimeProfile,
  deps: CreateMcpServerDeps,
): McpServer {
  const server = new McpServer({
    name: "tavily-mcp",
    version: "0.2.21",
  });

  const handlers =
    deps.handlers ??
    createToolHandlers({
      client: deps.client,
      researchStore: deps.researchStore,
      defaultParameters: deps.defaultParameters,
      credentialMode: deps.credentialMode,
      researchJobTtlSeconds: deps.researchJobTtlSeconds,
      now: deps.now,
      streamFetch: deps.streamFetch,
      sessionId: deps.sessionId,
      humanId: deps.humanId,
      keyPool: deps.keyPool,
    });

  for (const tool of toolsForProfile(profile)) {
    const name = tool.name;
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const handler = (
          handlers as Record<
            string,
            (input: never) => Promise<AnyHandlerResult>
          >
        )[name];

        if (!handler) {
          return errorResult(profile, {
            code: "INVALID_INPUT",
            message: `Unknown tool: ${name}`,
          });
        }

        const result = await handler(args as never);
        if (!result.ok) {
          return errorResult(profile, result);
        }
        return successResult(profile, result.data, result.legacyText);
      },
    );
  }

  return server;
}
