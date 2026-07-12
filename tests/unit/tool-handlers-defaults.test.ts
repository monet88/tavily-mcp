import { describe, expect, it, vi } from "vitest";
import {
  createToolHandlers,
  MemoryResearchStore,
} from "../../src/tool-handlers.js";

describe("DEFAULT_PARAMETERS scoping", () => {
  it("force-overrides only keys supported by the current tool", async () => {
    const search = vi.fn(async (params: Record<string, unknown>) => ({
      query: String(params.query ?? ""),
      results: [],
      response_time: 0.1,
      request_id: "req-search",
    }));
    const extract = vi.fn(async () => ({
      results: [],
      failed_results: [],
      response_time: 0.1,
      request_id: "req-extract",
      usage: { credits: 1 },
    }));

    const handlers = createToolHandlers({
      client: {
        search,
        extract,
      } as never,
      researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
      // Shared blob across tools — search-only keys must not leak into extract.
      defaultParameters: {
        search_depth: "advanced",
        max_results: 15,
        include_images: true,
        extract_depth: "advanced",
      },
    });

    const searchResult = await handlers.tavily_search({
      query: "hello",
      search_depth: "basic",
      max_results: 5,
      include_images: false,
    });
    expect(searchResult.ok).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    const searchParams = search.mock.calls[0]?.[0] as Record<string, unknown>;
    // Force override: DEFAULT_PARAMETERS wins over caller values for allowed keys.
    expect(searchParams.search_depth).toBe("advanced");
    expect(searchParams.max_results).toBe(15);
    expect(searchParams.include_images).toBe(true);
    // extract_depth is not a search key — must not be injected.
    expect(searchParams).not.toHaveProperty("extract_depth");

    const extractResult = await handlers.tavily_extract({
      urls: ["https://example.com"],
      extract_depth: "basic",
      include_images: false,
    });
    expect(extractResult.ok).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
    const extractParams = extract.mock.calls[0]?.[0] as Record<string, unknown>;
    // Shared include_images is allowed on extract → overridden.
    expect(extractParams.include_images).toBe(true);
    // extract_depth allowed on extract → overridden.
    expect(extractParams.extract_depth).toBe("advanced");
    // Search-only keys must not leak into extract payloads.
    expect(extractParams).not.toHaveProperty("search_depth");
    expect(extractParams).not.toHaveProperty("max_results");
  });

  it("injects allowed defaults even when the caller omitted those keys", async () => {
    const search = vi.fn(async (params: Record<string, unknown>) => ({
      query: String(params.query ?? ""),
      results: [],
      response_time: 0.1,
      request_id: "req-search",
    }));

    const handlers = createToolHandlers({
      client: { search } as never,
      researchStore: new MemoryResearchStore({ ttlSeconds: 60 }),
      defaultParameters: {
        search_depth: "advanced",
        include_images: true,
        // Foreign key for another endpoint — must stay out of search.
        extract_depth: "advanced",
      },
    });

    // Minimal call — only query present. Allowed defaults still apply
    // (legacy search built a full payload then overwrote matching keys).
    await handlers.tavily_search({ query: "hello" });
    const params = search.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.query).toBe("hello");
    expect(params.search_depth).toBe("advanced");
    expect(params.include_images).toBe(true);
    expect(params).not.toHaveProperty("extract_depth");
  });
});
