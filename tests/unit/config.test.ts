import { describe, expect, it } from "vitest";
import { loadConfig, parseApiKeyPool } from "../../src/config.js";

describe("parseApiKeyPool", () => {
  it("accepts one key", () => {
    expect(parseApiKeyPool("key-1")).toEqual(["key-1"]);
  });

  it("trims, removes empty entries, and deduplicates in first-seen order", () => {
    expect(parseApiKeyPool(" key-1, key-2,,key-1 ")).toEqual(["key-1", "key-2"]);
  });

  it.each(["", "  ", ",,,"])("returns an empty pool for %j", value => {
    expect(parseApiKeyPool(value)).toEqual([]);
  });

  it("rejects more than 32 keys", () => {
    expect(() => parseApiKeyPool(Array.from({ length: 33 }, (_, i) => `k${i}`).join(",")))
      .toThrow("at most 32");
  });

  it("rejects a raw secret larger than 5 KB", () => {
    expect(() => parseApiKeyPool("x".repeat(5121))).toThrow("5 KB");
  });
});

describe("loadConfig", () => {
  it("keeps implicit keyless mode for stdio", () => {
    expect(loadConfig({}, "stdio").credentialMode).toBe("keyless");
  });

  it("requires a pool for worker", () => {
    expect(() => loadConfig({}, "worker")).toThrow("TAVILY_API_KEY");
  });

  it("allows worker without MCP_PATH_TOKEN (public /mcp)", () => {
    const config = loadConfig({ TAVILY_API_KEY: "key-1" }, "worker");
    expect(config.mcpPathToken).toBeUndefined();
    expect(config.credentialMode).toBe("api-key");
  });

  it("rejects invalid capability tokens when provided", () => {
    expect(() => loadConfig({
      TAVILY_API_KEY: "key-1",
      MCP_PATH_TOKEN: "too-short",
    }, "worker")).toThrow("MCP_PATH_TOKEN");
  });
});
