#!/usr/bin/env node

import { randomUUID } from "crypto";
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { LocalKeyPool } from "./key-pool.js";
import { createMcpServer } from "./server.js";
import { TavilyClient } from "./tavily-client.js";
import {
  LIST_TOOLS_DESCRIPTIONS,
  toolsForProfile,
} from "./tool-catalog.js";
import { MemoryResearchStore } from "./tool-handlers.js";

dotenv.config();

interface Arguments {
  "list-tools": boolean;
  _: (string | number)[];
  $0: string;
}

function listTools(): void {
  const tools = toolsForProfile("stdio");
  console.log("Available tools:");
  for (const tool of tools) {
    console.log(`\n- ${tool.name}`);
    console.log(
      `  Description: ${LIST_TOOLS_DESCRIPTIONS[tool.name] ?? tool.description}`,
    );
  }
  process.exit(0);
}

const argv = yargs(hideBin(process.argv))
  .option("list-tools", {
    type: "boolean",
    description: "List all available tools and exit",
    default: false,
  })
  .help()
  .parse() as Arguments;

if (argv["list-tools"]) {
  listTools();
}

async function main(): Promise<void> {
  const config = loadConfig(process.env as Record<string, string | undefined>, "stdio");
  const sessionId = randomUUID();
  const keyPool = await LocalKeyPool.create(config.apiKeys, {
    quarantineMs: config.keyQuarantineSeconds * 1000,
  });
  const client = new TavilyClient({
    keyPool,
    sessionId,
    humanId: config.humanId,
  });
  const researchStore = new MemoryResearchStore({
    ttlSeconds: config.researchJobTtlSeconds,
  });

  if (config.credentialMode === "keyless") {
    console.error(
      "[tavily-mcp] no TAVILY_API_KEY set; running in keyless mode. Search and extract are available; other tools will return a message explaining that an API key is required.",
    );
  }

  const server = createMcpServer("stdio", {
    client,
    researchStore,
    defaultParameters: config.defaultParameters,
    credentialMode: config.credentialMode,
    researchJobTtlSeconds: config.researchJobTtlSeconds,
    sessionId,
    humanId: config.humanId,
    keyPool,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Guard against concurrent SIGINT+SIGTERM (or repeated signals) racing
  // through server.close() while the first shutdown is still pending.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  console.error("Tavily MCP server running on stdio");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
