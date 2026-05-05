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
          if (cached.source === "stale") {
            cacheNote = "\n[cached, may be outdated]";
          } else if (cached.source === "bm25") {
            cacheNote = "\n[semantic cache match]";
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
          // Store in cache (fire-and-forget)
          cache.set("search", { libraryName: params.libraryName }, fetchParams, raw).catch(() => {});
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

        // Format output
        const lines: string[] = [
          `Found ${results.length} libraries for "${params.libraryName}":`,
        ];

        for (let i = 0; i < results.length; i++) {
          const lib = results[i] as Record<string, unknown>;
          const idx = i + 1;
          const id = lib.id ?? "";
          const title = lib.title ?? lib.name ?? "Unknown";
          const description = lib.description ?? "";
          const versions = Array.isArray(lib.versions)
            ? (lib.versions as string[]).join(", ")
            : "";
          const trust = lib.trustScore ?? lib.trust_score ?? "?";
          const bench = lib.benchmarkScore ?? lib.benchmark_score ?? "?";
          const stars = lib.stars ?? lib.githubStars ?? lib.github_stars ?? "?";

          lines.push("");
          lines.push(`${idx}. ${title} — ${id}`);
          lines.push(`   ${description}`);
          if (versions) lines.push(`   Versions: ${versions}`);
          lines.push(`   Trust: ${trust}/10 · Benchmark: ${bench}/100 · ⭐ ${stars}`);
        }

        lines.push("");
        lines.push(
          "Use the library ID (e.g., " +
            (results[0] as Record<string, unknown>)?.id +
            ") with context7_get_context.",
        );
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
    description:
      "Get up-to-date documentation context and code examples for a library from Context7. " +
      "Requires a libraryId from context7_search_library (format: /owner/repo or /owner/repo@version). " +
      "Always prefer Context7 over training data for library-specific questions.",
    promptSnippet: "Retrieve documentation and code examples for a Context7 library ID",
    promptGuidelines: [
      "Use context7_get_context for library documentation instead of relying on training data. Training data may be outdated.",
      "When context7_get_context returns insufficient results, retry with researchMode: true for a deeper search.",
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
      researchMode: Type.Optional(
        Type.Boolean({
          description:
            "When true, use deeper agentic research (sandboxed agents, live web search). " +
            "Slower but higher quality. Use as retry if default results are insufficient.",
          default: false,
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
        if (params.researchMode) fetchParams.researchMode = true;

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
          if (cached.source === "stale") {
            cacheNote = "\n[cached, may be outdated]";
          } else if (cached.source === "bm25") {
            cacheNote = "\n[semantic cache match]";
          }
        } else {
          // Cache miss — fetch from API
          data = await context7Fetch<Record<string, unknown>>(
            "context",
            fetchParams,
            currentApiKey,
            signal,
          );
          // Store in cache (fire-and-forget)
          cache
            .set("context", { libraryId: params.libraryId }, fetchParams, data)
            .catch(() => {});
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
              const title = snippet.title ?? "Code Example";
              const lang = snippet.language ?? snippet.lang ?? "typescript";
              const code = snippet.code ?? snippet.content ?? "";
              const source = snippet.source
                ? `Source: ${snippet.source}`
                : "";

              outputLines.push(`**${title}** (${lang})`);
              outputLines.push("```" + lang);
              outputLines.push(String(code).trimEnd());
              outputLines.push("```");
              if (source) outputLines.push(source);
              outputLines.push("");
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
              const title = snippet.title ?? "Info";
              const snippetText =
                (snippet.content as string) ??
                (snippet.text as string) ??
                (snippet.description as string) ??
                "";
              outputLines.push(`**${title}** — ${snippetText}`);
              outputLines.push("");
            }
          }

          // Research mode note
          if (params.researchMode) {
            outputLines.push("[Research mode — deeper analysis]");
            outputLines.push("");
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
