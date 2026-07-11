import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TAVILY_API_KEY: "tvly-test-key-1,tvly-test-key-2",
          MCP_ENABLED: "true",
          MCP_MAX_REQUEST_BODY_BYTES: "1048576",
          MCP_REQUESTS_PER_MINUTE: "120",
          MCP_DAILY_REQUEST_LIMIT: "10000",
          MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://chat.openai.com",
          MCP_ALLOW_PUBLIC: "true",
        },
      },
    }),
  ],
  test: { include: ["tests/worker/**/*.test.ts"] },
});
