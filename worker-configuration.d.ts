// Minimal Env shape for Task 5 worker tests. Full wrangler types arrive in Task 7.
declare namespace Cloudflare {
  interface Env {
    TAVILY_COORDINATOR: DurableObjectNamespace;
    MCP_ENABLED?: string;
    MCP_DAILY_REQUEST_LIMIT?: string;
    MCP_REQUESTS_PER_MINUTE?: string;
    MCP_MAX_REQUEST_BODY_BYTES?: string;
    TAVILY_DAILY_CALL_LIMIT?: string;
    RESEARCH_JOB_TTL_SECONDS?: string;
    KEY_QUARANTINE_SECONDS?: string;
    MAX_RESEARCH_JOBS?: string;
    MCP_ALLOWED_ORIGINS?: string;
  }
}

interface Env extends Cloudflare.Env {}
