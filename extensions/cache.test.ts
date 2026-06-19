/**
 * Unit tests for BM25 scoring and cache timing.
 *
 * Covers:
 * - BM25 cache hit for semantically equivalent reordered queries (same tokens, different order)
 * - BM25 cache miss for queries sharing only stopwords or insufficient term overlap
 * - cache.set writes file + updates manifest before returning (timing guarantee)
 * - cache.get returns BM25 hit after an awaited set completes
 *
 * @module extensions/cache.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  bm25Find,
  tokenize,
  tokenizeForScoring,
  type ManifestEntry,
} from "./cache.ts";
import { createCache } from "./cache.ts";

// ---------------------------------------------------------------------------
// Test fixtures — a temp cache root that doesn't touch the real cache
// ---------------------------------------------------------------------------

const TEST_CACHE_ROOT = join(tmpdir(), `context7-cache-test-${Date.now()}`);

before(async () => {
  process.env.CONTEXT7_CACHE_ROOT = TEST_CACHE_ROOT;
  await mkdir(TEST_CACHE_ROOT, { recursive: true });
});

after(async () => {
  delete process.env.CONTEXT7_CACHE_ROOT;
  try {
    await rm(TEST_CACHE_ROOT, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Helper: build a minimal manifest entry
// ---------------------------------------------------------------------------

function makeEntry(query: string, hash: string, scope: Record<string, string> = {}): ManifestEntry {
  return {
    scope,
    query,
    hash,
    cachedAt: 0,
    ttl: 300,
    size: 100,
  };
}

// ===========================================================================
// BM25 Scoring Tests
// ===========================================================================

describe("BM25 scoring", () => {
  describe("tokenizeForScoring", () => {
    it("removes English stopwords", () => {
      const tokens = tokenizeForScoring("how to set up express");
      // "how", "to", "set", "up" are stopwords; only "express" remains
      assert.deepEqual(tokens, ["express"]);
    });

    it("keeps domain-specific terms", () => {
      const tokens = tokenizeForScoring("useState hook patterns in react");
      // "in" is a stopword; the rest are domain terms
      assert.deepEqual(tokens, ["usestate", "hook", "patterns", "react"]);
    });

    it("returns same tokens for reordered queries", () => {
      const a = tokenizeForScoring("best practices for layout and content");
      const b = tokenizeForScoring("best practices for content and layout");
      // "for" and "and" are stopwords; both produce [best, practices, layout, content]
      assert.deepEqual(a.sort(), b.sort());
      assert.deepEqual(a.sort(), ["best", "content", "layout", "practices"]);
    });
  });

  describe("bm25Find — cache hit for reordered equivalent queries", () => {
    it("matches same tokens in different order", () => {
      // Criterion 1 & 4: two queries with same tokens, different order
      const entries = [
        makeEntry("best practices for layout and content", "h1", { libraryId: "/test/lib" }),
      ];

      const result = bm25Find("best practices for content and layout", entries, 0.5);

      assert.notEqual(result, null, "Should match reordered query");
      assert.equal(result!.hash, "h1");
    });

    it("matches regardless of which query is cached vs looked up", () => {
      const entries = [
        makeEntry("best practices for content and layout", "h2", { libraryId: "/test/lib" }),
      ];

      const result = bm25Find("best practices for layout and content", entries, 0.5);

      assert.notEqual(result, null);
      assert.equal(result!.hash, "h2");
    });
  });

  describe("bm25Find — cache miss for stopword-only overlap", () => {
    it("rejects queries sharing only stopwords", () => {
      // Criterion 5: queries sharing only stopwords after filtering
      // "how to configure nextjs" → tokens: [configure, nextjs] (how, to are stopwords)
      // "how to set up express" → tokens: [express] (how, to, set, up are stopwords)
      // Overlap: 0 matching terms → miss
      const entries = [
        makeEntry("how to set up express", "h1", { libraryId: "/test/lib" }),
      ];

      const result = bm25Find("how to configure nextjs", entries, 0.5);

      assert.equal(result, null, "Should not match on stopword-only overlap");
    });
  });

  describe("bm25Find — cache miss for insufficient overlap", () => {
    it("rejects queries with < 50% term overlap", () => {
      // Criterion 5: "useState hook patterns" vs "useEffect hook cleanup"
      // shares only "hook" (1 of 3, 33%) — below the 50% threshold
      const entries = [
        makeEntry("useState hook patterns", "h1", { libraryId: "/test/lib" }),
      ];

      const result = bm25Find("useEffect hook cleanup", entries, 0.5);

      assert.equal(result, null, "Should not match with <50% term overlap");
    });

    it("rejects single shared term even if it's domain-specific", () => {
      // "hook" is a domain term, but sharing only 1 of 3 terms (33%) is insufficient
      const entries = [
        makeEntry("react hook forms validation", "h1", { libraryId: "/test/lib" }),
      ];

      // "hook" matches, but 1/3 = 33% < 50%
      const result = bm25Find("custom hook rendering", entries, 0.5);

      assert.equal(result, null, "Should not match with single shared term");
    });
  });

  describe("bm25Find — edge cases", () => {
    it("returns null for empty query", () => {
      const entries = [makeEntry("some cached query", "h1")];
      assert.equal(bm25Find("", entries, 0.5), null);
    });

    it("returns null for all-stopword query", () => {
      const entries = [makeEntry("how to use express", "h1")];
      // "how to use" are all stopwords → queryTokens is empty after filtering
      assert.equal(bm25Find("how to for", entries, 0.5), null);
    });

    it("returns null when no entries provided", () => {
      assert.equal(bm25Find("some query", [], 0.5), null);
    });
  });
});

// ===========================================================================
// Cache Timing Tests
// ===========================================================================

describe("cache timing", () => {
  describe("cache.set writes file and updates manifest before returning", () => {
    it("file exists on disk after awaited set()", async () => {
      // Criterion 6: cache.set completes (file written + manifest updated) before returning
      const cache = createCache();
      await cache.init();

      const scope = { libraryId: "/timing/file-test" };
      const params = { libraryId: "/timing/file-test", query: "file existence check" };
      const data = { results: [{ id: 1, text: "test data" }] };

      await cache.set("context", scope, params, data);

      // The cache file should exist on disk immediately after set() returns
      // We verify via cache.get() which reads from disk — if the file wasn't
      // written, this would return a cache miss.
      const result = await cache.get("context", scope, params);
      assert.equal(result.source, "exact", "File should be readable immediately after awaited set");
      assert.deepEqual(result.data, data);
    });

    it("manifest entry is visible to subsequent get() after awaited set()", async () => {
      // This directly tests the fire-and-forget fix: with await, the manifest
      // is updated before set() returns, so a subsequent BM25 lookup sees it.
      const cache = createCache();
      await cache.init();

      const scope = { libraryId: "/timing/manifest-test" };
      const paramsA = { libraryId: "/timing/manifest-test", query: "best practices for layout and content" };
      const paramsB = { libraryId: "/timing/manifest-test", query: "best practices for content and layout" };
      const data = { snippets: [{ text: "cached response" }] };

      // 1. Write entry A
      await cache.set("context", scope, paramsA, data);

      // 2. Look up with query B (same tokens, different order) — should BM25 hit
      const result = await cache.get("context", scope, paramsB);
      assert.equal(result.source, "bm25", "BM25 should find the entry written by awaited set()");
      assert.deepEqual(result.data, data);
    });

    it("awaited set() makes entry visible for exact match too", async () => {
      const cache = createCache();
      await cache.init();

      const scope = { libraryName: "timing-lib" };
      const params = { libraryName: "timing-lib", query: "exact match timing" };
      const data = { results: [{ id: "timing", title: "Timing Test" }] };

      await cache.set("search", scope, params, data);

      const result = await cache.get("search", scope, params);
      assert.equal(result.source, "exact");
      assert.deepEqual(result.data, data);
    });
  });

  describe("sequential cache writes produce BM25 hits", () => {
    it("simulates two sequential tool calls: second hits cache from first", async () => {
      // This simulates the real-world scenario from the spec:
      // two context7_get_context calls with reordered query terms
      // in the same LLM response, executed sequentially.
      const cache = createCache();
      await cache.init();

      const scope = { libraryId: "/sequential/sim" };
      const queryA = "best practices for layout and content";
      const queryB = "best practices for content and layout";

      const paramsA = { libraryId: "/sequential/sim", query: queryA, type: "json" };
      const paramsB = { libraryId: "/sequential/sim", query: queryB, type: "json" };

      const apiData = { codeSnippets: [{ codeTitle: "Example", code: "console.log(1)" }] };

      // --- First tool call (simulated) ---
      // Cache miss → fetch from API → await cache.set
      let result = await cache.get("context", scope, paramsA);
      assert.equal(result.source, null, "First call should be a cache miss");

      // Simulate the awaited cache.set (as the tool now does)
      await cache.set("context", scope, paramsA, apiData);

      // --- Second tool call (simulated) ---
      // With sequential execution + awaited set, the manifest is updated.
      // queryB has the same tokens as queryA → BM25 hit.
      result = await cache.get("context", scope, paramsB);
      assert.equal(result.source, "bm25", "Second call should BM25 hit the first call's cache");
      assert.deepEqual(result.data, apiData);
    });
  });
});