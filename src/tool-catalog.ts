import { z, type ZodType } from "zod";
import type { RuntimeProfile } from "./config.js";
import type {
  CrawlInput,
  ExtractInput,
  MapInput,
  ResearchStartInput,
  SearchInput,
} from "./tavily-client.js";
import {
  CrawlOutputSchema,
  ExtractOutputSchema,
  MapOutputSchema,
  SearchOutputSchema,
  type CrawlOutput,
  type ExtractOutput,
  type MapOutput,
  type ResearchStartOutput,
  type SearchOutput,
} from "./tavily-schemas.js";

export interface ToolDefinition<Input, Output> {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodType<Input>;
  outputSchema: ZodType<Output>;
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: true;
    destructiveHint: false;
  };
  profiles: Array<"stdio" | "worker">;
}

const SearchInputSchema: ZodType<SearchInput> = z
  .object({
    query: z.string().describe("Search query"),
    search_depth: z
      .enum(["basic", "advanced", "fast", "ultra-fast"])
      .default("basic")
      .describe(
        "The depth of the search. 'basic' for generic results, 'advanced' for more thorough search, 'fast' for optimized low latency with high relevance, 'ultra-fast' for prioritizing latency above all else",
      ),
    topic: z
      .enum(["general"])
      .default("general")
      .describe(
        "The category of the search. This will determine which of our agents will be used for the search",
      ),
    time_range: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe(
        "The time range back from the current date to include in the search results",
      ),
    start_date: z
      .string()
      .default("")
      .describe(
        "Will return all results after the specified start date. Required to be written in the format YYYY-MM-DD.",
      ),
    end_date: z
      .string()
      .default("")
      .describe(
        "Will return all results before the specified end date. Required to be written in the format YYYY-MM-DD",
      ),
    max_results: z
      .number()
      .min(5)
      .max(20)
      .default(5)
      .describe("The maximum number of search results to return"),
    include_images: z
      .boolean()
      .default(false)
      .describe("Include a list of query-related images in the response"),
    include_image_descriptions: z
      .boolean()
      .default(false)
      .describe(
        "Include a list of query-related images and their descriptions in the response",
      ),
    include_raw_content: z
      .boolean()
      .default(false)
      .describe(
        "Include the cleaned and parsed HTML content of each search result",
      ),
    include_domains: z
      .array(z.string())
      .default([])
      .describe(
        "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site",
      ),
    exclude_domains: z
      .array(z.string())
      .default([])
      .describe(
        "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site",
      ),
    country: z
      .string()
      .default("")
      .describe(
        "Boost search results from a specific country. Must be a full country name (e.g., 'United States', 'Japan', 'Germany'). ISO country codes (e.g., 'us', 'jp') are not supported. Available only if topic is general. See https://docs.tavily.com/documentation/api-reference/search for the full list of supported countries.",
      ),
    include_favicon: z
      .boolean()
      .default(false)
      .describe("Whether to include the favicon URL for each result"),
    exact_match: z
      .boolean()
      .optional()
      .describe(
        "Only return results containing the exact phrase(s) in quotes in your query",
      ),
  })
  .strict();

const ExtractInputSchema: ZodType<ExtractInput> = z
  .object({
    urls: z
      .array(z.string())
      .min(1)
      .max(20)
      .describe("List of URLs to extract content from"),
    extract_depth: z
      .enum(["basic", "advanced"])
      .default("basic")
      .describe(
        "Use 'advanced' for LinkedIn, protected sites, or tables/embedded content",
      ),
    include_images: z
      .boolean()
      .default(false)
      .describe("Include images from pages"),
    format: z
      .enum(["markdown", "text"])
      .default("markdown")
      .describe("Output format"),
    include_favicon: z
      .boolean()
      .default(false)
      .describe("Include favicon URLs"),
    query: z
      .string()
      .optional()
      .describe("Query to rerank content chunks by relevance"),
  })
  .strict();

const CrawlInputSchema: ZodType<CrawlInput> = z
  .object({
    url: z.string().describe("The root URL to begin the crawl"),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(1)
      .describe(
        "Max depth of the crawl. Defines how far from the base URL the crawler can explore.",
      ),
    max_breadth: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        "Max number of links to follow per level of the tree (i.e., per page)",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Total number of links the crawler will process before stopping"),
    instructions: z
      .string()
      .optional()
      .describe(
        "Natural language instructions for the crawler. Instructions specify which types of pages the crawler should return.",
      ),
    select_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
      ),
    select_domains: z
      .array(z.string())
      .default([])
      .describe(
        "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
      ),
    allow_external: z
      .boolean()
      .default(true)
      .describe("Whether to return external links in the final response"),
    extract_depth: z
      .enum(["basic", "advanced"])
      .default("basic")
      .describe(
        "Advanced extraction retrieves more data, including tables and embedded content, with higher success but may increase latency",
      ),
    format: z
      .enum(["markdown", "text"])
      .default("markdown")
      .describe(
        "The format of the extracted web page content. markdown returns content in markdown format. text returns plain text and may increase latency.",
      ),
    include_favicon: z
      .boolean()
      .default(false)
      .describe("Whether to include the favicon URL for each result"),
  })
  .strict();

const MapInputSchema: ZodType<MapInput> = z
  .object({
    url: z.string().describe("The root URL to begin the mapping"),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(1)
      .describe(
        "Max depth of the mapping. Defines how far from the base URL the crawler can explore",
      ),
    max_breadth: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        "Max number of links to follow per level of the tree (i.e., per page)",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Total number of links the crawler will process before stopping"),
    instructions: z
      .string()
      .optional()
      .describe("Natural language instructions for the crawler"),
    select_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
      ),
    select_domains: z
      .array(z.string())
      .default([])
      .describe(
        "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
      ),
    allow_external: z
      .boolean()
      .default(true)
      .describe("Whether to return external links in the final response"),
  })
  .strict();

const ResearchStartInputSchema: ZodType<ResearchStartInput> = z
  .object({
    input: z
      .string()
      .describe("A comprehensive description of the research task"),
    model: z
      .enum(["mini", "pro", "auto"])
      .default("auto")
      .describe(
        "Defines the degree of depth of the research. 'mini' is good for narrow tasks with few subtopics. 'pro' is good for broad tasks with many subtopics. 'auto' automatically selects the best model.",
      ),
  })
  .strict();

const ResearchGetInputSchema = z
  .object({
    request_id: z
      .string()
      .describe("The request_id returned by tavily_research_start"),
    job_token: z
      .string()
      .min(1)
      .describe("Opaque job token returned by tavily_research_start"),
  })
  .strict();

export type ResearchGetInput = z.infer<typeof ResearchGetInputSchema>;

// MCP start output adds opaque job_token (not from Tavily provider body).
export const ResearchStartMcpOutputSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.literal("pending"),
    input: z.string(),
    model: z.enum(["mini", "pro", "auto"]),
    response_time: z.number().finite(),
    job_token: z.string(),
  })
  .strict();

// MCP SDK cannot convert discriminated unions into JSON Schema; use a flat object.
export const ResearchGetMcpOutputSchema = z
  .object({
    request_id: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    response_time: z.number().finite(),
    created_at: z.string().optional(),
    content: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
    sources: z
      .array(
        z
          .object({
            title: z.string(),
            url: z.string(),
            favicon: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ResearchGetMcpOutput = z.infer<typeof ResearchGetMcpOutputSchema>;

export const ResearchSyncOutputSchema = z
  .object({
    content: z.string(),
  })
  .strict();

export type ResearchSyncOutput = z.infer<typeof ResearchSyncOutputSchema>;

const openWorld = {
  openWorldHint: true as const,
  destructiveHint: false as const,
};

export const TOOL_CATALOG = [
  {
    name: "tavily_search",
    title: "Tavily Search",
    description:
      "Search the web for current information on any topic. Use for news, facts, or data beyond your knowledge cutoff. Returns snippets and source URLs.",
    inputSchema: SearchInputSchema,
    outputSchema: SearchOutputSchema,
    annotations: { readOnlyHint: true, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_extract",
    title: "Tavily Extract",
    description:
      "Extract content from URLs. Returns raw page content in markdown or text format.",
    inputSchema: ExtractInputSchema,
    outputSchema: ExtractOutputSchema,
    annotations: { readOnlyHint: true, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_crawl",
    title: "Tavily Crawl",
    description:
      "Crawl a website starting from a URL. Extracts content from pages with configurable depth and breadth.",
    inputSchema: CrawlInputSchema,
    outputSchema: CrawlOutputSchema,
    annotations: { readOnlyHint: true, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_map",
    title: "Tavily Map",
    description:
      "Map a website's structure. Returns a list of URLs found starting from the base URL.",
    inputSchema: MapInputSchema,
    outputSchema: MapOutputSchema,
    annotations: { readOnlyHint: true, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_research_start",
    title: "Tavily Research Start",
    description:
      "Start a comprehensive research job on a topic or question. Returns a request_id to poll with tavily_research_get. Rate limit: 20 requests per minute.",
    inputSchema: ResearchStartInputSchema,
    outputSchema: ResearchStartMcpOutputSchema,
    annotations: { readOnlyHint: false, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_research_get",
    title: "Tavily Research Get",
    description:
      "Retrieve the status or final report for a research job started with tavily_research_start.",
    inputSchema: ResearchGetInputSchema,
    outputSchema: ResearchGetMcpOutputSchema,
    annotations: { readOnlyHint: true, ...openWorld },
    profiles: ["stdio", "worker"] as Array<"stdio" | "worker">,
  },
  {
    name: "tavily_research",
    title: "Tavily Research",
    description:
      "Perform comprehensive research on a given topic or question. Use this tool when you need to gather information from multiple sources to answer a question or complete a task. Returns a detailed response based on the research findings. Rate limit: 20 requests per minute.",
    inputSchema: ResearchStartInputSchema,
    outputSchema: ResearchSyncOutputSchema,
    annotations: { readOnlyHint: false, ...openWorld },
    profiles: ["stdio"] as Array<"stdio" | "worker">,
  },
] as const satisfies ReadonlyArray<ToolDefinition<unknown, unknown>>;

export type ToolName = (typeof TOOL_CATALOG)[number]["name"];

export function toolsForProfile(profile: RuntimeProfile) {
  return TOOL_CATALOG.filter(tool => tool.profiles.includes(profile));
}

/** Longer descriptions used by --list-tools for human-facing CLI help. */
export const LIST_TOOLS_DESCRIPTIONS: Record<string, string> = {
  tavily_search:
    "A real-time web search tool powered by Tavily's AI engine. Features include customizable search depth (basic/advanced/fast/ultra-fast), domain filtering, and time-based filtering. Returns comprehensive results with titles, URLs, content snippets, and optional image results.",
  tavily_extract:
    "Extracts and processes content from specified URLs with advanced parsing capabilities. Supports both basic and advanced extraction modes, with the latter providing enhanced data retrieval including tables and embedded content. Ideal for data collection, content analysis, and research tasks.",
  tavily_crawl:
    "A sophisticated web crawler that systematically explores websites starting from a base URL. Features include configurable depth and breadth limits, domain filtering, and path pattern matching. Perfect for comprehensive site analysis, content discovery, and structured data collection.",
  tavily_map:
    "Creates detailed site maps by analyzing website structure and navigation paths. Offers configurable exploration depth and domain restrictions. Ideal for site audits, content organization analysis, and understanding website architecture and navigation patterns.",
  tavily_research:
    "Performs comprehensive research on any topic or question by gathering information from multiple sources. Supports different research depths ('mini' for narrow tasks, 'pro' for broad research, 'auto' for automatic selection). Ideal for in-depth analysis, report generation, and answering complex questions requiring synthesis of multiple sources.",
  tavily_research_start:
    "Starts an asynchronous research job and returns a request_id plus job_token. Poll tavily_research_get with both until the job reaches a terminal status.",
  tavily_research_get:
    "Fetches the current status or completed report for a research job. Requires request_id and job_token from tavily_research_start.",
};

// re-export input types used by handlers
export type {
  CrawlInput,
  CrawlOutput,
  ExtractInput,
  ExtractOutput,
  MapInput,
  MapOutput,
  ResearchStartInput,
  ResearchStartOutput,
  SearchInput,
  SearchOutput,
};
