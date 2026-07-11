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

  it("requires MCP_PATH_TOKEN for worker unless MCP_ALLOW_PUBLIC=true", () => {
    expect(() => loadConfig({ TAVILY_API_KEY: "key-1" }, "worker")).toThrow(
      "MCP_PATH_TOKEN",
    );

    const publicConfig = loadConfig(
      { TAVILY_API_KEY: "key-1", MCP_ALLOW_PUBLIC: "true" },
      "worker",
    );
    expect(publicConfig.mcpPathToken).toBeUndefined();
    expect(publicConfig.mcpAllowPublic).toBe(true);
    expect(publicConfig.credentialMode).toBe("api-key");
  });

  it("accepts a valid capability token for worker", () => {
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const config = loadConfig(
      { TAVILY_API_KEY: "key-1", MCP_PATH_TOKEN: token },
      "worker",
    );
    expect(config.mcpPathToken).toBe(token);
    expect(config.mcpAllowPublic).toBe(false);
  });

  it("rejects invalid capability tokens when provided", () => {
    expect(() => loadConfig({
      TAVILY_API_KEY: "key-1",
      MCP_PATH_TOKEN: "too-short",
    }, "worker")).toThrow("MCP_PATH_TOKEN");
  });
});
