import type { KeyPool } from "./key-pool.js";
import type {
  ResearchStartInput,
  TavilyClient,
} from "./tavily-client.js";
import { TavilyToolError } from "./tavily-client.js";

const INITIAL_POLL_INTERVAL = 2000;
const MAX_POLL_INTERVAL = 10_000;
const POLL_BACKOFF_FACTOR = 1.5;
const MAX_PRO_MODEL_POLL_DURATION = 900_000;
const MAX_MINI_MODEL_POLL_DURATION = 300_000;

const HEADERS_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const RESEARCH_DOCS_URL =
  "https://docs.tavily.com/documentation/api-reference/endpoint/research";
const DEFAULT_BASE_URL = "https://api.tavily.com";

export interface LegacyResearchResult {
  content?: string;
  error?: string;
}

export interface LegacyResearchOptions {
  client: TavilyClient;
  input: ResearchStartInput;
  /** Used to authorize the stream fallback with the same header rules as the client. */
  keyPool?: KeyPool;
  streamFetch?: typeof fetch;
  baseUrl?: string;
  sessionId?: string;
  humanId?: string;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function contentToString(
  content: string | Record<string, unknown> | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/**
 * Preserve the historical stdio sync research tool: poll with backoff, then
 * fall back to a bounded SSE stream when non-streaming create fails.
 */
export async function runLegacyResearch(
  options: LegacyResearchOptions,
): Promise<LegacyResearchResult> {
  const sleep = options.sleep ?? defaultSleep;
  const model = options.input.model ?? "auto";

  let start;
  try {
    start = await options.client.researchStart({
      input: options.input.input,
      model,
    });
  } catch (error: unknown) {
    if (error instanceof TavilyToolError) {
      if (error.code === "TAVILY_AUTH_FAILED") {
        throw new Error(`Invalid API key. Documentation: ${RESEARCH_DOCS_URL}`);
      }
      if (error.code === "TAVILY_RATE_LIMITED") {
        throw new Error(
          `Usage limit exceeded. Documentation: ${RESEARCH_DOCS_URL}`,
        );
      }
      if (error.code === "KEY_POOL_NOT_CONFIGURED") {
        throw error;
      }
      // Client maps research_stream_required (and other 4xx) to stable codes
      // after consuming the body. Attempt the historical stream fallback for
      // non-auth upstream failures so stdio keeps working when streaming is required.
      if (
        error.code === "TAVILY_UPSTREAM_ERROR" ||
        error.code === "TAVILY_PLAN_LIMIT_REACHED"
      ) {
        return researchViaStream(options, model);
      }
      return {
        error: `${error.message}. Documentation: ${RESEARCH_DOCS_URL}`,
      };
    }
    throw error;
  }

  const requestId = start.result.request_id;
  if (!requestId) {
    return {
      error: `No request_id returned from research endpoint. Documentation: ${RESEARCH_DOCS_URL}`,
    };
  }

  const maxPollDuration =
    model === "mini"
      ? MAX_MINI_MODEL_POLL_DURATION
      : MAX_PRO_MODEL_POLL_DURATION;

  let pollInterval = INITIAL_POLL_INTERVAL;
  let totalElapsed = 0;

  while (totalElapsed < maxPollDuration) {
    await sleep(pollInterval);
    totalElapsed += pollInterval;

    try {
      const status = await options.client.researchGet(
        requestId,
        start.credentialFingerprint,
      );

      if (status.status === "completed") {
        return { content: contentToString(status.content) };
      }
      if (status.status === "failed") {
        return {
          error: `Research task failed. Documentation: ${RESEARCH_DOCS_URL}`,
        };
      }
    } catch (pollError: unknown) {
      if (
        pollError instanceof TavilyToolError &&
        pollError.code === "RESEARCH_NOT_FOUND"
      ) {
        return { error: "Research task not found" };
      }
      throw pollError;
    }

    pollInterval = Math.min(
      pollInterval * POLL_BACKOFF_FACTOR,
      MAX_POLL_INTERVAL,
    );
  }

  return {
    error: `Research task timed out. Documentation: ${RESEARCH_DOCS_URL}`,
  };
}

async function researchViaStream(
  options: LegacyResearchOptions,
  model: string,
): Promise<LegacyResearchResult> {
  const fetchFn = options.streamFetch ?? fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const maxStreamDuration = model === "mini" ? 300_000 : 900_000;

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "X-Client-Source": "MCP",
  };
  if (options.sessionId) headers["X-Session-Id"] = options.sessionId;
  if (options.humanId) headers["X-Human-Id"] = options.humanId;

  if (options.keyPool) {
    try {
      const lease = await options.keyPool.acquire();
      if (lease.mode === "api-key") {
        headers.Authorization = `Bearer ${lease.key}`;
      } else {
        headers["X-Tavily-Access-Mode"] = "keyless";
        headers["X-Client-Source"] = "tavily-mcp-keyless";
      }
    } catch {
      return {
        error: `Research stream request failed: no healthy API key. Documentation: ${RESEARCH_DOCS_URL}`,
      };
    }
  }

  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/research`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: options.input.input,
        model,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const reason = controller.signal.aborted
      ? `no response after ${HEADERS_TIMEOUT_MS / 1000}s`
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      error: `Research stream request failed: ${reason}. Documentation: ${RESEARCH_DOCS_URL}`,
    };
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
      try {
        const parsed = JSON.parse(detail) as { detail?: unknown };
        detail = JSON.stringify(parsed.detail ?? parsed);
      } catch {
        // keep raw body
      }
    } catch {
      detail = "";
    }
    return {
      error: `Research stream request failed (HTTP ${response.status}): ${detail}. Documentation: ${RESEARCH_DOCS_URL}`,
    };
  }

  if (!response.body) {
    return {
      error: `Research stream request failed: empty body. Documentation: ${RESEARCH_DOCS_URL}`,
    };
  }

  return readResearchSse(response.body, maxStreamDuration);
}

async function readResearchSse(
  body: ReadableStream<Uint8Array>,
  maxStreamDuration: number,
): Promise<LegacyResearchResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (overallTimer) clearTimeout(overallTimer);
    try {
      void reader.cancel();
    } catch {
      // ignore
    }
  };

  return new Promise<LegacyResearchResult>(resolve => {
    const settle = (result: LegacyResearchResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    overallTimer = setTimeout(() => {
      settle({
        error: `Research stream timed out after ${maxStreamDuration / 1000}s. Documentation: ${RESEARCH_DOCS_URL}`,
      });
    }, maxStreamDuration);

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle({
          error: `Research stream received no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s; connection closed. Documentation: ${RESEARCH_DOCS_URL}`,
        });
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    const handleFrame = (frame: string): boolean => {
      let eventType = "message";
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");

      if (eventType === "error") {
        let message: unknown = data;
        try {
          const parsed = JSON.parse(data) as { error?: unknown };
          message = parsed.error ?? data;
        } catch {
          // keep raw
        }
        if (typeof message === "object") message = JSON.stringify(message);
        settle({
          error: `Research stream error: ${String(message)}. Documentation: ${RESEARCH_DOCS_URL}`,
        });
        return true;
      }
      if (eventType === "done") {
        settle(
          content
            ? { content }
            : {
                error: `Research stream completed without content. Documentation: ${RESEARCH_DOCS_URL}`,
              },
        );
        return true;
      }
      if (!data) return false;
      try {
        const delta = (
          JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          }
        ).choices?.[0]?.delta;
        if (typeof delta?.content === "string") content += delta.content;
      } catch {
        // tolerate malformed frames
      }
      return false;
    };

    void (async () => {
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) {
            if (!settled && buffer.trim()) {
              if (handleFrame(buffer.trim())) return;
            }
            settle({
              error: `Research stream ended before completion. Documentation: ${RESEARCH_DOCS_URL}`,
            });
            return;
          }
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (settled) break;
            if (!frame.trim()) continue;
            if (handleFrame(frame)) return;
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        settle({
          error: `Research stream connection error: ${message}. Documentation: ${RESEARCH_DOCS_URL}`,
        });
      }
    })();
  });
}
