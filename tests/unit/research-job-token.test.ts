import { describe, expect, it, vi } from "vitest";
import {
  createToolHandlers,
  hashJobToken,
  MemoryResearchStore,
} from "../../src/tool-handlers.js";

describe("research job_token", () => {
  it("returns job_token on start and rejects get without matching token", async () => {
    const store = new MemoryResearchStore({ ttlSeconds: 60 });
    const client = {
      researchStart: vi.fn(async () => ({
        result: {
          request_id: "req-1",
          created_at: "2026-07-11T00:00:00Z",
          status: "pending" as const,
          input: "topic",
          model: "auto" as const,
          response_time: 0.1,
        },
        credentialFingerprint: "fp-1",
      })),
      researchGet: vi.fn(async () => ({
        request_id: "req-1",
        status: "completed" as const,
        created_at: "2026-07-11T00:00:00Z",
        content: "secret report",
        sources: [{ title: "t", url: "https://example.com" }],
        response_time: 1,
      })),
    };

    const handlers = createToolHandlers({
      client: client as never,
      researchStore: store,
    });

    const start = await handlers.tavily_research_start({ input: "topic" });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(typeof start.data.job_token).toBe("string");
    expect(String(start.data.job_token).length).toBeGreaterThan(20);

    const bad = await handlers.tavily_research_get({
      request_id: "req-1",
      job_token: "wrong-token",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("RESEARCH_NOT_FOUND");
    expect(client.researchGet).not.toHaveBeenCalled();

    const good = await handlers.tavily_research_get({
      request_id: "req-1",
      job_token: String(start.data.job_token),
    });
    expect(good.ok).toBe(true);
    expect(client.researchGet).toHaveBeenCalledTimes(1);
    if (!good.ok) return;
    expect(good.data).toMatchObject({ status: "completed", content: "secret report" });

    const stored = await store.get("req-1");
    expect(stored?.tokenHash).toBe(await hashJobToken(String(start.data.job_token)));
    expect(JSON.stringify(stored)).not.toContain(String(start.data.job_token));
  });
});
