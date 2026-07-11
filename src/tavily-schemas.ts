import { z } from "zod";

// Coerce provider timing (string|number) into a finite number.
const FiniteNumber = z.preprocess((value: unknown) => {
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}, z.number().finite());

const SourceImageSchema = z
  .object({
    url: z.string(),
    description: z.string().optional(),
  })
  .strict();

const UsageSchema = z
  .object({
    credits: z.number(),
  })
  .strict();

const SearchResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number(),
    published_date: z.string().optional(),
    raw_content: z.string().optional(),
    favicon: z.string().optional(),
  })
  .strict();

const ExtractResultSchema = z
  .object({
    url: z.string(),
    raw_content: z.string(),
    images: z.array(z.string()).optional(),
    favicon: z.string().optional(),
  })
  .strict();

const ExtractFailedSchema = z
  .object({
    url: z.string(),
    error: z.string(),
  })
  .strict();

const CrawlResultSchema = z
  .object({
    url: z.string(),
    raw_content: z.string(),
    favicon: z.string().optional(),
  })
  .strict();

const ResearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    favicon: z.string().optional(),
  })
  .strict();

// --- Strict normalized MCP-output schemas ---

export const SearchOutputSchema = z
  .object({
    query: z.string(),
    answer: z.string().optional(),
    images: z.array(SourceImageSchema).optional(),
    results: z.array(SearchResultSchema),
    response_time: z.number().finite().optional(),
    request_id: z.string().optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const ExtractOutputSchema = z
  .object({
    results: z.array(ExtractResultSchema),
    failed_results: z.array(ExtractFailedSchema).optional(),
    response_time: z.number().finite().optional(),
    request_id: z.string().optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const CrawlOutputSchema = z
  .object({
    base_url: z.string(),
    results: z.array(CrawlResultSchema),
    response_time: z.number().finite(),
    request_id: z.string().optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const MapOutputSchema = z
  .object({
    base_url: z.string(),
    results: z.array(z.string()),
    response_time: z.number().finite(),
    request_id: z.string().optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const ResearchStartOutputSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.literal("pending"),
    input: z.string(),
    model: z.enum(["mini", "pro", "auto"]),
    response_time: z.number().finite(),
  })
  .strict();

const ResearchGetPendingSchema = z
  .object({
    request_id: z.string(),
    status: z.enum(["pending", "in_progress"]),
    response_time: z.number().finite(),
  })
  .strict();

const ResearchGetCompletedSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.literal("completed"),
    content: z.union([z.string(), z.record(z.string(), z.unknown())]),
    sources: z.array(ResearchSourceSchema),
    response_time: z.number().finite(),
  })
  .strict();

const ResearchGetFailedSchema = z
  .object({
    request_id: z.string(),
    status: z.literal("failed"),
    response_time: z.number().finite(),
  })
  .strict();

export const ResearchGetOutputSchema = z.discriminatedUnion("status", [
  ResearchGetPendingSchema,
  ResearchGetCompletedSchema,
  ResearchGetFailedSchema,
]);

export type SearchOutput = z.infer<typeof SearchOutputSchema>;
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;
export type CrawlOutput = z.infer<typeof CrawlOutputSchema>;
export type MapOutput = z.infer<typeof MapOutputSchema>;
export type ResearchStartOutput = z.infer<typeof ResearchStartOutputSchema>;
export type ResearchGetOutput = z.infer<typeof ResearchGetOutputSchema>;

// --- Permissive provider-input schemas (strip unknown) ---

const ProviderSourceImageSchema = z.preprocess(
  (value: unknown) => {
    // Tavily may return bare URL strings; normalize to SourceImage.
    if (typeof value === "string") return { url: value };
    return value;
  },
  z
    .object({
      url: z.string(),
      description: z.string().optional(),
    })
    .strip(),
);

const ProviderUsageSchema = z
  .object({
    credits: z.number(),
  })
  .strip();

const ProviderSearchResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number(),
    published_date: z.string().optional(),
    raw_content: z.string().optional(),
    favicon: z.string().optional(),
  })
  .strip();

export const ProviderSearchResponseSchema = z
  .object({
    query: z.string(),
    answer: z.string().optional(),
    images: z.array(ProviderSourceImageSchema).optional(),
    results: z.array(ProviderSearchResultSchema),
    response_time: FiniteNumber.optional(),
    request_id: z.string().optional(),
    usage: ProviderUsageSchema.optional(),
  })
  .strip();

const ProviderExtractResultSchema = z
  .object({
    url: z.string(),
    raw_content: z.string(),
    images: z.array(z.string()).optional(),
    favicon: z.string().optional(),
  })
  .strip();

const ProviderExtractFailedSchema = z
  .object({
    url: z.string(),
    error: z.string(),
  })
  .strip();

export const ProviderExtractResponseSchema = z
  .object({
    results: z.array(ProviderExtractResultSchema),
    failed_results: z.array(ProviderExtractFailedSchema).optional(),
    response_time: FiniteNumber.optional(),
    request_id: z.string().optional(),
    usage: ProviderUsageSchema.optional(),
  })
  .strip();

const ProviderCrawlResultSchema = z
  .object({
    url: z.string(),
    raw_content: z.string(),
    favicon: z.string().optional(),
  })
  .strip();

export const ProviderCrawlResponseSchema = z
  .object({
    base_url: z.string(),
    results: z.array(ProviderCrawlResultSchema),
    response_time: FiniteNumber,
    request_id: z.string().optional(),
    usage: ProviderUsageSchema.optional(),
  })
  .strip();

export const ProviderMapResponseSchema = z
  .object({
    base_url: z.string(),
    results: z.array(z.string()),
    response_time: FiniteNumber,
    request_id: z.string().optional(),
    usage: ProviderUsageSchema.optional(),
  })
  .strip();

export const ProviderResearchStartResponseSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.literal("pending"),
    input: z.string(),
    model: z.enum(["mini", "pro", "auto"]),
    response_time: FiniteNumber,
  })
  .strip();

const ProviderResearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    favicon: z.string().optional(),
  })
  .strip();

const ProviderResearchGetPendingSchema = z
  .object({
    request_id: z.string(),
    status: z.enum(["pending", "in_progress"]),
    response_time: FiniteNumber,
  })
  .strip();

const ProviderResearchGetCompletedSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.literal("completed"),
    content: z.union([z.string(), z.record(z.string(), z.unknown())]),
    sources: z.array(ProviderResearchSourceSchema),
    response_time: FiniteNumber,
  })
  .strip();

const ProviderResearchGetFailedSchema = z
  .object({
    request_id: z.string(),
    status: z.literal("failed"),
    response_time: FiniteNumber,
  })
  .strip();

export const ProviderResearchGetResponseSchema = z.union([
  ProviderResearchGetPendingSchema,
  ProviderResearchGetCompletedSchema,
  ProviderResearchGetFailedSchema,
]);

export function normalizeWithSchemas<T>(
  providerSchema: z.ZodTypeAny,
  outputSchema: z.ZodType<T>,
  raw: unknown,
): T {
  const provider = providerSchema.parse(raw);
  return outputSchema.parse(provider);
}
