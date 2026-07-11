import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Fixed 32-byte base64url token for Worker route tests (not a real secret).
const TEST_PATH_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TAVILY_API_KEY: "tvly-test-key-1,tvly-test-key-2",
          MCP_PATH_TOKEN: TEST_PATH_TOKEN,
          MCP_ENABLED: "true",
          MCP_MAX_REQUEST_BODY_BYTES: "1048576",
          MCP_REQUESTS_PER_MINUTE: "120",
          MCP_DAILY_REQUEST_LIMIT: "10000",
          MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://chat.openai.com",
        },
      },
    }),
  ],
  test: { include: ["tests/worker/**/*.test.ts"] },
});
