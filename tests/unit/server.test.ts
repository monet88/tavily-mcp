import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/server.js";
import type { TavilyClient } from "../../src/tavily-client.js";
import { MemoryResearchStore } from "../../src/tool-handlers.js";

function mockClient(): TavilyClient {
  return {
    search: vi.fn(),
    extract: vi.fn(),
    crawl: vi.fn(),
    map: vi.fn(),
    researchStart: vi.fn(),
    researchGet: vi.fn(),
  } as unknown as TavilyClient;
}

async function listToolsForProfile(profile: "stdio" | "worker") {
  const server = createMcpServer(profile, {
    client: mockClient(),
    researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  await server.close();
  return listed.tools;
}

describe("createMcpServer tool descriptors", () => {
  it("lists seven stdio tools in catalog order", async () => {
    const stdioTools = await listToolsForProfile("stdio");
    expect(stdioTools.map(tool => tool.name)).toEqual([
      "tavily_search",
      "tavily_extract",
      "tavily_crawl",
      "tavily_map",
      "tavily_research_start",
      "tavily_research_get",
      "tavily_research",
    ]);
  });

  it("lists six worker tools without sync research", async () => {
    const workerTools = await listToolsForProfile("worker");
    expect(workerTools.map(tool => tool.name)).toEqual([
      "tavily_search",
      "tavily_extract",
      "tavily_crawl",
      "tavily_map",
      "tavily_research_start",
      "tavily_research_get",
    ]);
  });

  it("exposes schemas and annotations for every tool", async () => {
    const stdioTools = await listToolsForProfile("stdio");
    for (const tool of stdioTools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.annotations).toBeTruthy();
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    }

    const byName = Object.fromEntries(stdioTools.map(t => [t.name, t]));
    expect(byName.tavily_research_start?.annotations?.readOnlyHint).toBe(false);
    expect(byName.tavily_research?.annotations?.readOnlyHint).toBe(false);
    expect(byName.tavily_search?.annotations?.readOnlyHint).toBe(true);
    expect(byName.tavily_extract?.annotations?.readOnlyHint).toBe(true);
    expect(byName.tavily_crawl?.annotations?.readOnlyHint).toBe(true);
    expect(byName.tavily_map?.annotations?.readOnlyHint).toBe(true);
    expect(byName.tavily_research_get?.annotations?.readOnlyHint).toBe(true);
  });
});
