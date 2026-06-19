/**
 * Context7 Extension for pi coding agent.
 *
 * Registers two tools backed by the cache layer from cache.ts:
 * 1. context7_search_library — Search Context7 for libraries by name
 * 2. context7_get_context — Get documentation context and code examples
 *
 * @module extensions/context7
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCache, type CacheModule } from "./cache.js";
import {
  computeQualityScore,
  getStars,
} from "./ranking.js";

export default function (pi: ExtensionAPI) {
  let cache: CacheModule;
  let apiKey: string | undefined;

  // -----------------------------------------------------------------------
  // API Key Resolution
  // -----------------------------------------------------------------------

  function resolveApiKey(): string | undefined {
    if (process.env.CONTEXT7_API_KEY) return process.env.CONTEXT7_API_KEY;

    try {
      const authPath = join(homedir(), ".pi", "agent", "auth.json");
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      return auth?.context7?.apiKey;
    } catch {
      /* not found, unauthenticated */
    }

    return undefined;
  }

  // -----------------------------------------------------------------------
  // Session Init
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    cache = await createCache();
    apiKey = resolveApiKey();

    if (!apiKey) {
      ctx.ui.notify(
        "Context7: no API key set. Rate limits apply. " +
          "Set CONTEXT7_API_KEY for higher limits.",
        "info",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Signal helper — race caller signal with timeout
  // -----------------------------------------------------------------------

  function createCombinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    if (!signal) return AbortSignal.timeout(timeoutMs);

    // AbortSignal.any is available in Node 20+
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]);
    }

    // Fallback: create a controller aborted by either signal
    const controller = new AbortController();
    const onAbort = () => {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    AbortSignal.timeout(timeoutMs).addEventListener("abort", onAbort, { once: true });
    return controller.signal;
  }

  // -----------------------------------------------------------------------
  // HTTP Client (Context7-specific)
  // -----------------------------------------------------------------------

  async function context7Fetch<T>(
    endpoint: string,
    params: Record<string, string | boolean | undefined>,
    apiKey?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`https://context7.com/api/v2/${endpoint}`);

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const combinedSignal = createCombinedSignal(10_000, signal);
        const response = await fetch(url.toString(), { headers, signal: combinedSignal });

        if (response.ok) {
          return (await response.json()) as T;
        }

        // Try to parse structured error body
        let apiMessage: string | undefined;
        try {
          const errorBody = await response.json();
          if (errorBody?.message) apiMessage = errorBody.message;
        } catch {
          /* ignore parse errors */
        }

        // 401 — Invalid API key
        if (response.status === 401) {
          throw new Error(
            "Context7 API error: Invalid API key. Generate one at " +
              "https://context7.com/dashboard and set CONTEXT7_API_KEY.",
          );
        }

        // 403 — Access denied
        if (response.status === 403) {
          throw new Error(
            "Context7 API error: Access denied. Your plan may not include this library.",
          );
        }

        // 404 — Not found
        if (response.status === 404) {
          throw new Error(
            "Context7 API error: Library not found. Check the library ID.",
          );
        }

        // 429 — Rate limited
        if (response.status === 429) {
          if (attempt < maxRetries) {
            const retryAfter = response.headers.get("Retry-After");
            const delayMs = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw new Error(
            "Context7 API error: Rate limit exceeded. Wait and retry, " +
              "or set CONTEXT7_API_KEY for higher limits.",
          );
        }

        // 5xx — Server error
        if (response.status >= 500) {
          throw new Error(
            `Context7 API error: Server error (${response.status}). Try again later.`,
          );
        }

        // Other 4xx
        throw new Error(
          apiMessage
            ? `Context7 API error: ${apiMessage}`
            : `Context7 API error: HTTP ${response.status}`,
        );
      } catch (err) {
        const isContext7Error =
          err instanceof Error && err.message.startsWith("Context7 API error");

        if (isContext7Error) {
          // These are already formatted — throw immediately
          throw err;
        }

        // Network / timeout / other transient errors — retry with backoff
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw new Error(
          `Context7 API error: Network error after ${maxRetries + 1} attempts. ${lastError.message}`,
        );
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new Error("Context7 API error: Request failed after retries.");
  }

  // -----------------------------------------------------------------------
  // Tool: context7_search_library
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "context7_search_library",
    label: "Context7 Search Library",
    executionMode: "sequential",
    description:
      "Search Context7 for libraries by name. Returns matching libraries with IDs, descriptions, " +
      "trust scores, and available versions. Use this first to resolve a library name to a " +
      "Context7 library ID before calling context7_get_context.",
    promptSnippet: "Search for libraries on Context7 by name (e.g., 'react', 'nextjs')",
    parameters: Type.Object({
      libraryName: Type.String({
        description:
          "Library name to search for (e.g., 'react', 'nextjs', 'express', 'prisma')",
      }),
      query: Type.String({
        description:
          "The user's full question or task — used for intelligent relevance ranking. " +
          "Be specific. Good: 'How to set up JWT auth in Express middleware', Bad: 'auth'",
      }),
      fast: Type.Optional(
        Type.Boolean({
          description:
            "When true, skip LLM reranking for faster but less accurate results",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const currentApiKey = apiKey;

        // Build params for fetch + cache
        const fetchParams: Record<string, string | boolean | undefined> = {
          libraryName: params.libraryName,
          query: params.query,
        };
        if (params.fast) fetchParams.fast = true;

        // Try cache first
        const cached = await cache.get(
          "search",
          { libraryName: params.libraryName },
          fetchParams,
        );

        let results: unknown[];
        let cacheNote = "";

        if (cached.source !== null) {
          // Cache hit
          results = ((cached.data as { results?: unknown[] })?.results ?? []) as unknown[];
          if (cached.source === "exact") {
            cacheNote = "\n[cache hit]";
          } else if (cached.source === "bm25") {
            cacheNote = "\n[semantic cache match]";
          } else if (cached.source === "stale") {
            cacheNote = "\n[cached, may be outdated]";
          }
        } else {
          // Cache miss — fetch from API
          const raw = await context7Fetch<{ results: unknown[] }>(
            "libs/search",
            fetchParams,
            currentApiKey,
            signal,
          );
          results = raw.results ?? [];
          // Store in cache (await to guarantee manifest is updated before returning)
          await cache
            .set("search", { libraryName: params.libraryName }, fetchParams, raw)
            .catch((err) => {
              console.error("[context7] cache write failed:", err);
            });
          cacheNote = "\n[fetched from API]";
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No libraries found for '${params.libraryName}'. Try a different name or be more specific.`,
              },
            ],
            details: { results: [] },
          };
        }

        // -----------------------------------------------------------------------
        // Library auto-ranking: filter non-finalized, compute composite quality
        // score, sort, and show top 3 with a Recommended marker.
        // Weights and scoring logic live in ranking.ts (imported at module top).
        // -----------------------------------------------------------------------

        // Step 1 — Filter non-finalized libraries
        const finalized = results.filter((lib) => {
          const state = (lib as Record<string, unknown>).state;
          return state === "finalized" || state === undefined; // keep if finalized or field missing
        });

        if (finalized.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Found ${results.length} libraries for "${params.libraryName}" but none are finalized yet. ` +
                  "Try again later or use a different search term.",
              },
            ],
            details: { results },
          };
        }

        // Step 2 — Compute maxStars across the finalized results
        const maxStars = Math.max(
          ...finalized.map(
            (lib) => getStars(lib as Record<string, unknown>),
          ),
          0,
        );

        // Step 3 — Score, sort, and slice top 3
        const scored = finalized
          .map((lib) => ({
            lib,
            score: computeQualityScore(lib as Record<string, unknown>, maxStars),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);

        // Step 4 — Format output
        const lines: string[] = [];

        if (results.length > 3) {
          lines.push(
            `Found ${results.length} libraries for "${params.libraryName}" — showing top ${scored.length} by quality:`,
          );
        } else {
          lines.push(
            `Found ${results.length} ${results.length === 1 ? "library" : "libraries"} for "${params.libraryName}":`,
          );
        }
        lines.push("");

        for (let i = 0; i < scored.length; i++) {
          const lib = scored[i].lib as Record<string, unknown>;
          const idx = i + 1;
          const id = (lib.id ?? "") as string;
          const title = (lib.title ?? lib.name ?? "Unknown") as string;
          const description = (lib.description ?? "") as string;
          const versions = Array.isArray(lib.versions)
            ? (lib.versions as string[]).join(", ")
            : "";
          const trust = lib.trustScore ?? lib.trust_score ?? "?";
          const bench = lib.benchmarkScore ?? lib.benchmark_score ?? "?";
          const stars = ((lib.stars ?? lib.githubStars ?? lib.github_stars ?? 0) as number) | 0;

          const marker = i === 0 ? "⭐ Recommended: " : `${idx}. `;
          lines.push(`${marker}${title} — ${id}`);
          lines.push(`   ${description}`);
          if (versions) lines.push(`   Versions: ${versions}`);
          lines.push(
            `   Stars: ${stars.toLocaleString()} · Trust: ${trust}/10 · Benchmark: ${bench}/100`,
          );
          if (i === 0) {
            lines.push(`   → Use this ID with context7_get_context`);
          }
          lines.push("");
        }

        // Always suggest the top result's ID
        const topId = (scored[0]?.lib as Record<string, unknown>)?.id as
          | string
          | undefined;
        if (topId) {
          lines.push(`Use ${topId} with context7_get_context.`);
        }
        if (cacheNote) lines.push(cacheNote);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { results },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tool: context7_get_context
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "context7_get_context",
    label: "Context7 Get Context",
    executionMode: "sequential",
    description:
      "Get up-to-date documentation context and code examples for a library from Context7. " +
      "Requires a libraryId from context7_search_library (format: /owner/repo or /owner/repo@version). " +
      "Always prefer Context7 over training data for library-specific questions.",
    promptSnippet: "Retrieve documentation and code examples for a Context7 library ID",
    promptGuidelines: [
      "Use context7_get_context for library documentation instead of relying on training data. Training data may be outdated.",
      "Always run context7_search_library first to resolve library names to Context7 IDs before calling context7_get_context.",
    ],
    parameters: Type.Object({
      libraryId: Type.String({
        description:
          "Context7 library ID in format /owner/repo or /owner/repo@version " +
          "(e.g., '/facebook/react', '/vercel/next.js@v15.1.8')",
      }),
      query: Type.String({
        description:
          "The specific question or task. Be specific and include relevant details. " +
          "Good: 'How to set up JWT authentication in Express middleware', Bad: 'auth'",
      }),
      type: Type.Optional(
        StringEnum(["json", "txt"] as const, {
          description:
            "Response format. 'json' returns structured snippets, 'txt' returns raw text.",
          default: "json",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        // 1. Validate libraryId format: /owner/repo or /owner/repo@version or /owner/repo/version
        const libIdRegex = /^\/[^/]+\/[^/]+([/@][^/]+)?$/;
        if (!libIdRegex.test(params.libraryId)) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid libraryId format. Expected /owner/repo or /owner/repo@version",
              },
            ],
            details: { error: "Invalid libraryId format" },
          };
        }

        const currentApiKey = apiKey;
        const responseType = params.type ?? "json";

        const fetchParams: Record<string, string | boolean | undefined> = {
          libraryId: params.libraryId,
          query: params.query,
          type: responseType,
        };


        // Try cache
        const cached = await cache.get(
          "context",
          { libraryId: params.libraryId },
          fetchParams,
        );

        let data: Record<string, unknown>;
        let cacheNote = "";

        if (cached.source !== null) {
          // Cache hit
          data = cached.data as Record<string, unknown>;
          if (cached.source === "exact") {
            cacheNote = "\n[cache hit]";
          } else if (cached.source === "bm25") {
            cacheNote = "\n[semantic cache match]";
          } else if (cached.source === "stale") {
            cacheNote = "\n[cached, may be outdated]";
          }
        } else {
          // Cache miss — fetch from API
          data = await context7Fetch<Record<string, unknown>>(
            "context",
            fetchParams,
            currentApiKey,
            signal,
          );
          // Store in cache (await to guarantee manifest is updated before returning)
          await cache
            .set("context", { libraryId: params.libraryId }, fetchParams, data)
            .catch((err) => {
              console.error("[context7] cache write failed:", err);
            });
          cacheNote = "\n[fetched from API]";
        }

        // Format output
        const outputLines: string[] = [];
        outputLines.push(`## Context7 Documentation for ${params.libraryId}`);
        outputLines.push("");

        if (responseType === "txt") {
          // Raw text mode
          const textContent =
            (data?.text as string) ??
            (data?.content as string) ??
            JSON.stringify(data, null, 2);
          outputLines.push(String(textContent));
        } else {
          // Structured JSON mode
          const codeSnippets = data?.codeSnippets as
            | Array<Record<string, unknown>>
            | undefined;
          if (codeSnippets && codeSnippets.length > 0) {
            outputLines.push("### Code Snippets");
            outputLines.push("");

            for (const snippet of codeSnippets) {
              // Use codeTitle/codeDescription from the API, with fallbacks
              const snippetTitle = (snippet.codeTitle ?? snippet.title ?? "Code Example") as string;
              const snippetDesc = snippet.codeDescription as string | undefined;

              // Use codeLanguage from the API, with fallback
              const snippetLang = (snippet.codeLanguage ?? snippet.language ?? snippet.lang ?? "typescript") as string;

              // codeList is an array of { language, code } from the API
              const codeList = (snippet.codeList ?? []) as Array<Record<string, unknown>>;

              // Source URL from the API (codeId) with fallbacks
              const sourceUrl = (snippet.codeId ?? snippet.source ?? snippet.pageTitle) as string | undefined;

              if (codeList.length > 0) {
                // Each codeList item gets its own code block
                outputLines.push(`**${snippetTitle}**`);
                if (snippetDesc) outputLines.push(`> ${snippetDesc}`);
                outputLines.push("");

                for (const item of codeList) {
                  const itemLang = (item.language ?? snippetLang) as string;
                  const itemCode = (item.code ?? "") as string;
                  if (itemCode) {
                    outputLines.push("```" + itemLang);
                    outputLines.push(String(itemCode).trimEnd());
                    outputLines.push("```");
                  }
                }

                if (sourceUrl) outputLines.push(`Source: ${sourceUrl}`);
                outputLines.push("");
              } else {
                // Fallback: try top-level code property (alternate format)
                const legacyCode = (snippet.code ?? snippet.content ?? "") as string;
                if (legacyCode) {
                  outputLines.push(`**${snippetTitle}** (${snippetLang})`);
                  if (snippetDesc) outputLines.push(`> ${snippetDesc}`);
                  outputLines.push("```" + snippetLang);
                  outputLines.push(String(legacyCode).trimEnd());
                  outputLines.push("```");
                  if (sourceUrl) outputLines.push(`Source: ${sourceUrl}`);
                  outputLines.push("");
                }
              }
            }
          }

          // Info / Documentation snippets
          const infoSnippets = data?.infoSnippets as
            | Array<Record<string, unknown>>
            | undefined;
          if (infoSnippets && infoSnippets.length > 0) {
            outputLines.push("### Documentation");
            outputLines.push("");

            for (const snippet of infoSnippets) {
              const breadcrumb = (snippet.breadcrumb as string) ?? "Documentation";
              const snippetContent = (snippet.content as string) ?? "";
              const pageId = snippet.pageId as string | undefined;

              outputLines.push(`**${breadcrumb}**`);
              if (snippetContent) outputLines.push(snippetContent);
              if (pageId) outputLines.push(`Source: ${pageId}`);
              outputLines.push("");
            }
          }

          // Library rules (global, libraryOwn, libraryTeam)
          const rules = data?.rules as
            | Record<string, string[]>
            | undefined;
          if (rules) {
            const allRules: string[] = [];
            if (Array.isArray(rules.global)) allRules.push(...rules.global);
            if (Array.isArray(rules.libraryOwn)) allRules.push(...rules.libraryOwn);
            if (Array.isArray(rules.libraryTeam)) allRules.push(...rules.libraryTeam);

            if (allRules.length > 0) {
              outputLines.push("### Library Rules");
              outputLines.push("");
              for (const rule of allRules) {
                outputLines.push(`- ${rule}`);
              }
              outputLines.push("");
            }
          }
        }

        if (cacheNote) outputLines.push(cacheNote);

        const formatted = outputLines.join("\n").trim();

        return {
          content: [{ type: "text", text: formatted || "No context data returned." }],
          details: {
            codeSnippets: (data?.codeSnippets as unknown) ?? [],
            infoSnippets: (data?.infoSnippets as unknown) ?? [],
            rules: (data?.rules as unknown) ?? [],
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
        };
      }
    },
  });
}
