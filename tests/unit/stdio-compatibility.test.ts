import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/server.js";
import { TavilyToolError, type TavilyClient } from "../../src/tavily-client.js";
import {
  formatCrawlResults,
  formatKeylessEnvelope,
  formatMapResults,
  formatResearchResults,
  formatSearchResults,
  KEYLESS_API_KEY_REQUIRED_MESSAGE,
  MemoryResearchStore,
} from "../../src/tool-handlers.js";

const searchFixture = {
  query: "hello",
  answer: "world",
  results: [
    {
      title: "Example",
      url: "https://example.com",
      content: "snippet",
      score: 0.9,
      raw_content: "raw body",
      favicon: "https://example.com/favicon.ico",
    },
  ],
  images: [
    { url: "https://img.example/a.png", description: "alpha" },
    { url: "https://img.example/b.png" },
  ],
  response_time: 1.2,
  request_id: "req-search",
  usage: { credits: 1 },
};

const crawlFixture = {
  base_url: "https://example.com",
  results: [
    {
      url: "https://example.com/a",
      raw_content: "x".repeat(250),
      favicon: "https://example.com/f.ico",
    },
  ],
  response_time: 2,
  request_id: "req-crawl",
};

const mapFixture = {
  base_url: "https://example.com",
  results: ["https://example.com/a", "https://example.com/b"],
  response_time: 1,
  request_id: "req-map",
};

describe("legacy golden formatters", () => {
  it("formats search results with answer, details, and images", () => {
    expect(formatSearchResults(searchFixture)).toBe(
      [
        "Answer: world",
        "Detailed Results:",
        "",
        "Title: Example",
        "URL: https://example.com",
        "Content: snippet",
        "Raw Content: raw body",
        "Favicon: https://example.com/favicon.ico",
        "",
        "Images:",
        "",
        "[1] URL: https://img.example/a.png",
        "   Description: alpha",
        "",
        "[2] URL: https://img.example/b.png",
      ].join("\n"),
    );
  });

  it("formats crawl results with 200-char truncation", () => {
    expect(formatCrawlResults(crawlFixture)).toBe(
      [
        "Crawl Results:",
        "Base URL: https://example.com",
        "",
        "Crawled Pages:",
        "",
        "[1] URL: https://example.com/a",
        `Content: ${"x".repeat(200)}...`,
        "Favicon: https://example.com/f.ico",
      ].join("\n"),
    );
  });

  it("formats map results", () => {
    expect(formatMapResults(mapFixture)).toBe(
      [
        "Site Map Results:",
        "Base URL: https://example.com",
        "",
        "Mapped Pages:",
        "",
        "[1] URL: https://example.com/a",
        "",
        "[2] URL: https://example.com/b",
      ].join("\n"),
    );
  });

  it("formats research success and error text", () => {
    expect(formatResearchResults({ content: "report body" })).toBe(
      "report body",
    );
    expect(formatResearchResults({})).toBe("No research results available");
    expect(formatResearchResults({ error: "boom" })).toBe(
      "Research Error: boom",
    );
  });

  it("formats keyless recoverable envelopes", () => {
    expect(
      formatKeylessEnvelope({
        error: {
          message: "Rate limited in keyless mode",
          retry_after_seconds: 30,
          next_actions: [
            { type: "signup", url: "https://tavily.com" },
            {
              type: "bonus_credits",
              eligible: true,
              credits_on_completion: 10,
              endpoint: "https://api.tavily.com/bonus",
              questions: ["Q1", "Q2"],
            },
            {
              type: "agentic_payment",
              scheme: "x402",
              details: "pay here",
            },
          ],
        },
      }),
    ).toBe(
      [
        "Rate limited in keyless mode",
        "Retry after: 30s",
        "",
        "Continuation options:",
        "- Sign up for a Tavily API key: https://tavily.com",
        "- Earn 10 bonus credits by POSTing answers to https://api.tavily.com/bonus",
        "    1. Q1",
        "    2. Q2",
        "- Agentic payment (x402): pay here",
      ].join("\n"),
    );
  });
});

describe("stdio structuredContent + legacy text", () => {
  it("returns structuredContent and golden search text on success", async () => {
    const client = {
      search: vi.fn(async () => searchFixture),
      extract: vi.fn(),
      crawl: vi.fn(),
      map: vi.fn(),
      researchStart: vi.fn(),
      researchGet: vi.fn(),
    } as unknown as TavilyClient;

    const server = createMcpServer("stdio", {
      client,
      researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "tavily_search",
      arguments: { query: "hello" },
    });

    expect(result.structuredContent).toEqual(searchFixture);
    expect(result.content).toEqual([
      {
        type: "text",
        text: formatSearchResults(searchFixture),
      },
    ]);
    expect(result.isError).toBeFalsy();

    await mcpClient.close();
    await server.close();
  });

  it("returns keyless legacy text when crawl requires an API key", async () => {
    const client = {
      search: vi.fn(),
      extract: vi.fn(),
      crawl: vi.fn(async () => {
        throw new TavilyToolError(
          "KEY_POOL_NOT_CONFIGURED",
          "A Tavily API key is required for this operation.",
        );
      }),
      map: vi.fn(),
      researchStart: vi.fn(),
      researchGet: vi.fn(),
    } as unknown as TavilyClient;

    const server = createMcpServer("stdio", {
      client,
      researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
      credentialMode: "keyless",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "tavily_crawl",
      arguments: { url: "https://example.com" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: KEYLESS_API_KEY_REQUIRED_MESSAGE,
      },
    ]);

    await mcpClient.close();
    await server.close();
  });

  it("returns stable JSON errors for the worker profile", async () => {
    const client = {
      search: vi.fn(),
      extract: vi.fn(),
      crawl: vi.fn(async () => {
        throw new TavilyToolError(
          "KEY_POOL_NOT_CONFIGURED",
          "A Tavily API key is required for this operation.",
        );
      }),
      map: vi.fn(),
      researchStart: vi.fn(),
      researchGet: vi.fn(),
    } as unknown as TavilyClient;

    const server = createMcpServer("worker", {
      client,
      researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "tavily_crawl",
      arguments: { url: "https://example.com" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "KEY_POOL_NOT_CONFIGURED",
            message: "A Tavily API key is required for this operation.",
          },
        }),
      },
    ]);

    await mcpClient.close();
    await server.close();
  });
});
