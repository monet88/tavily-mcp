export type RuntimeProfile = "stdio" | "worker";

export interface AppConfig {
  profile: RuntimeProfile;
  credentialMode: "api-key" | "keyless";
  apiKeys: string[];
  humanId?: string;
  defaultParameters: Record<string, unknown>;
  mcpEnabled: boolean;
  mcpPathToken?: string;
  allowedOrigins: string[];
  mcpDailyRequestLimit: number;
  mcpRequestsPerMinute: number;
  mcpMaxRequestBodyBytes: number;
  tavilyDailyCallLimit: number;
  researchJobTtlSeconds: number;
  keyQuarantineSeconds: number;
  maxResearchJobs: number;
}

export type EnvMap = Record<string, string | undefined>;

export interface ConfigLogger {
  warn(message: string): void;
}

const DEFAULTS = {
  mcpDailyRequestLimit: 10_000,
  mcpRequestsPerMinute: 120,
  mcpMaxRequestBodyBytes: 1_048_576,
  tavilyDailyCallLimit: 1_000,
  researchJobTtlSeconds: 86_400,
  keyQuarantineSeconds: 600,
  maxResearchJobs: 2_000,
} as const;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
];

// base64url of 32 random bytes is 43 chars; also accept longer tokens.
const MIN_PATH_TOKEN_DECODED_BYTES = 32;

const defaultLogger: ConfigLogger = {
  warn(message: string): void {
    console.warn(message);
  },
};

export function parseApiKeyPool(raw = ""): string[] {
  if (new TextEncoder().encode(raw).byteLength > 5 * 1024) {
    throw new Error("TAVILY_API_KEY must be no larger than 5 KB");
  }
  const keys = [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
  if (keys.length > 32) throw new Error("TAVILY_API_KEY supports at most 32 keys");
  if (keys.some(key => new TextEncoder().encode(key).byteLength > 512)) {
    throw new Error("Each Tavily API key must be no larger than 512 bytes");
  }
  return keys;
}

function parsePositiveInteger(
  env: EnvMap,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`MCP_ENABLED must be a boolean (got ${JSON.stringify(raw)})`);
}

function parseDefaultParameters(
  raw: string | undefined,
  logger: ConfigLogger,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(`DEFAULT_PARAMETERS is not a valid JSON object: ${raw}`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to parse DEFAULT_PARAMETERS as JSON: ${message}`);
    return {};
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_ALLOWED_ORIGINS];
  return [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
}

function isValidPathToken(token: string): boolean {
  // Require base64url alphabet and enough decoded entropy (≥ 32 bytes / 128 bits).
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;
  const padded = token + "=".repeat((4 - (token.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    // atob is available in both Node 20+ and Workers.
    const binary = atob(b64);
    return binary.length >= MIN_PATH_TOKEN_DECODED_BYTES;
  } catch {
    return false;
  }
}

export function loadConfig(
  env: EnvMap,
  profile: RuntimeProfile,
  logger: ConfigLogger = defaultLogger,
): AppConfig {
  const apiKeys = parseApiKeyPool(env.TAVILY_API_KEY ?? "");
  const credentialMode = apiKeys.length > 0 ? "api-key" : "keyless";

  if (profile === "worker" && apiKeys.length === 0) {
    throw new Error("TAVILY_API_KEY is required for the worker profile");
  }

  let mcpPathToken: string | undefined;
  const rawPathToken = env.MCP_PATH_TOKEN?.trim();
  if (rawPathToken) {
    if (!isValidPathToken(rawPathToken)) {
      throw new Error(
        "MCP_PATH_TOKEN must be a base64url token representing at least 32 random bytes",
      );
    }
    mcpPathToken = rawPathToken;
  } else if (profile === "worker") {
    throw new Error("MCP_PATH_TOKEN is required for the worker profile");
  }

  const humanId = env.TAVILY_HUMAN_ID?.trim() || undefined;

  return {
    profile,
    credentialMode,
    apiKeys,
    humanId,
    defaultParameters: parseDefaultParameters(env.DEFAULT_PARAMETERS, logger),
    mcpEnabled: parseBoolean(env.MCP_ENABLED, true),
    mcpPathToken,
    allowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS),
    mcpDailyRequestLimit: parsePositiveInteger(
      env,
      "MCP_DAILY_REQUEST_LIMIT",
      DEFAULTS.mcpDailyRequestLimit,
    ),
    mcpRequestsPerMinute: parsePositiveInteger(
      env,
      "MCP_REQUESTS_PER_MINUTE",
      DEFAULTS.mcpRequestsPerMinute,
    ),
    mcpMaxRequestBodyBytes: parsePositiveInteger(
      env,
      "MCP_MAX_REQUEST_BODY_BYTES",
      DEFAULTS.mcpMaxRequestBodyBytes,
    ),
    tavilyDailyCallLimit: parsePositiveInteger(
      env,
      "TAVILY_DAILY_CALL_LIMIT",
      DEFAULTS.tavilyDailyCallLimit,
    ),
    researchJobTtlSeconds: parsePositiveInteger(
      env,
      "RESEARCH_JOB_TTL_SECONDS",
      DEFAULTS.researchJobTtlSeconds,
    ),
    keyQuarantineSeconds: parsePositiveInteger(
      env,
      "KEY_QUARANTINE_SECONDS",
      DEFAULTS.keyQuarantineSeconds,
    ),
    maxResearchJobs: parsePositiveInteger(
      env,
      "MAX_RESEARCH_JOBS",
      DEFAULTS.maxResearchJobs,
    ),
  };
}
