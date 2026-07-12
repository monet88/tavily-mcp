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
    // 32 decoded bytes with enough unique base64url characters.
    const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
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

    // Long enough, but only one unique character (no entropy).
    expect(() => loadConfig({
      TAVILY_API_KEY: "key-1",
      MCP_PATH_TOKEN: "A".repeat(43),
    }, "worker")).toThrow("MCP_PATH_TOKEN");
  });

  it("does not echo raw DEFAULT_PARAMETERS values in warnings", () => {
    const warnings: string[] = [];
    loadConfig(
      {
        DEFAULT_PARAMETERS: '"secret-looking-string"',
      },
      "stdio",
      { warn: message => warnings.push(message) },
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("not a valid JSON object");
    expect(warnings[0]).not.toContain("secret-looking-string");
  });

  it("does not leak malformed DEFAULT_PARAMETERS through JSON.parse error messages", () => {
    const warnings: string[] = [];
    const secretish = 'Bearer abc-secret-token-xyz';
    loadConfig(
      {
        DEFAULT_PARAMETERS: secretish,
      },
      "stdio",
      { warn: message => warnings.push(message) },
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("invalid syntax");
    expect(warnings[0]).not.toContain(secretish);
    expect(warnings[0]).not.toContain("Bearer");
    expect(warnings[0]).not.toContain("abc-secret-token-xyz");
  });
});
