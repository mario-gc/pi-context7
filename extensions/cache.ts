/**
 * Context7 Cache Layer
 *
 * A BM25-backed semantic cache for Context7 API responses. Stores search results
 * and documentation context on disk, retrieves them by exact MD5 match or BM25
 * semantic similarity. Parallel-safe with zero runtime dependencies.
 *
 * On-disk structure:
 *   ~/.pi/agent/cache/context7/
 *   ├── libraries/            # Cached search response files (hash.json)
 *   ├── libraries.json        # Manifest for search cache
 *   ├── contexts/             # Cached context response files (hash.json)
 *   └── contexts.json         # Manifest for context cache
 *
 * @module extensions/cache
 */

import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_ROOT = join(homedir(), ".pi", "agent", "cache", "context7");

/** Subdirectory name for each endpoint. */
const DIR_NAMES: Record<string, string> = {
  search: "libraries",
  context: "contexts",
};

/** Default TTLs in seconds. */
const DEFAULT_TTL: Record<string, number> = {
  search: 604_800,  // 7 days
  context: 259_200, // 3 days
};

const MAX_CACHE_SIZE = 52_428_800; // 50 MB in bytes

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_CONSTANT_IDF = 1.5;

const BM25_THRESHOLD_ONLINE = 0.7;
const BM25_THRESHOLD_OFFLINE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry {
  response: unknown;
  cachedAt: number; // Unix timestamp ms
  ttl: number;      // Seconds
}

export interface CacheResult {
  data: unknown;
  source: "exact" | "bm25" | "stale" | null;
  entry?: CacheEntry;
}

interface ManifestEntry {
  scope: Record<string, string>;
  query: string;
  hash: string;
  cachedAt: number;
  ttl: number;
  size: number;
}

interface Manifest {
  entries: ManifestEntry[];
}

export interface CacheModule {
  init(): Promise<void>;
  get(
    endpoint: "search" | "context",
    scope: Record<string, string>,
    params: Record<string, string | boolean | undefined>,
  ): Promise<CacheResult>;
  set(
    endpoint: "search" | "context",
    scope: Record<string, string>,
    params: Record<string, string | boolean | undefined>,
    data: unknown,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let initialized = false;
const manifests: Record<string, Manifest> = {
  search: { entries: [] },
  context: { entries: [] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether the agent is in offline mode. */
function isOffline(): boolean {
  const v = process.env.PI_OFFLINE ?? process.env.CONTEXT7_OFFLINE;
  return v === "true" || v === "1";
}

/** Return the effective TTL (seconds) for the given endpoint. */
function getTTL(endpoint: "search" | "context"): number {
  const env = process.env.CONTEXT7_CACHE_TTL;
  if (env) {
    const minutes = parseInt(env, 10);
    if (!isNaN(minutes) && minutes > 0) return minutes * 60;
  }
  return DEFAULT_TTL[endpoint];
}

/**
 * Compute an MD5 hash from canonical params.
 *
 * Sorts keys alphabetically, omits `undefined` values, JSON-stringifies,
 * then returns the MD5 hex digest.
 */
function computeHash(params: Record<string, string | boolean | undefined>): string {
  const canonical: Record<string, string | boolean> = {};
  for (const key of Object.keys(params).sort()) {
    if (params[key] !== undefined) {
      canonical[key] = params[key] as string | boolean;
    }
  }
  return createHash("md5").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Extract the natural-language query text from params for BM25 matching.
 *
 * Looks for common keys (`query`, `q`) and returns the first non-empty string found.
 */
function extractQueryText(params: Record<string, string | boolean | undefined>): string {
  for (const key of ["query", "q"]) {
    const val = params[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return "";
}

/**
 * Tokenize text for BM25 scoring.
 *
 * Lowercases, splits on non-alphanumeric characters, filters empty tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 1);
}

/**
 * Compute BM25 score for a single query/document pair.
 *
 * Implements the simplified BM25 formula described in the spec.
 */
function bm25Score(queryTokens: string[], docTokens: string[], avgDocLen: number): number {
  const docLen = docTokens.length;
  const avgLen = avgDocLen > 0 ? avgDocLen : 1;

  let score = 0;
  for (const term of queryTokens) {
    const freq = docTokens.filter((t) => t === term).length;
    if (freq > 0) {
      const tf =
        (freq * (BM25_K1 + 1)) /
        (freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgLen)));
      score += tf * BM25_CONSTANT_IDF;
    }
  }
  return score;
}

/**
 * Run BM25 against a list of manifest entries and return the best match.
 *
 * @returns The best matching entry, or null if none reach the threshold.
 */
function bm25Find(query: string, entries: ManifestEntry[], threshold: number): ManifestEntry | null {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;

  const docTokenLists = entries.map((e) => tokenize(e.query));
  const avgDocLen =
    docTokenLists.reduce((sum, t) => sum + t.length, 0) / Math.max(entries.length, 1);

  let bestScore = 0;
  let bestEntry: ManifestEntry | null = null;

  for (let i = 0; i < entries.length; i++) {
    const score = bm25Score(queryTokens, docTokenLists[i], avgDocLen);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entries[i];
    }
  }

  return bestScore >= threshold ? bestEntry : null;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getEndpointDir(endpoint: "search" | "context"): string {
  return join(CACHE_ROOT, DIR_NAMES[endpoint]);
}

function getManifestPath(endpoint: "search" | "context"): string {
  return join(CACHE_ROOT, `${DIR_NAMES[endpoint]}.json`);
}

function getManifestTempPath(endpoint: "search" | "context"): string {
  return join(CACHE_ROOT, `${DIR_NAMES[endpoint]}.json.tmp`);
}

function getEntryPath(endpoint: "search" | "context", hash: string): string {
  return join(getEndpointDir(endpoint), `${hash}.json`);
}

function getEntryTempPath(endpoint: "search" | "context", hash: string): string {
  return join(getEndpointDir(endpoint), `${hash}.json.tmp`);
}

// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------

async function writeManifest(endpoint: "search" | "context"): Promise<void> {
  const tmpPath = getManifestTempPath(endpoint);
  const finalPath = getManifestPath(endpoint);
  await writeFile(tmpPath, JSON.stringify(manifests[endpoint]), "utf-8");
  await rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// Task 4: Eviction
// ---------------------------------------------------------------------------

/**
 * Check total cache size across both manifests and evict oldest entries
 * if the total exceeds 50 MB.
 */
async function evictIfNeeded(): Promise<void> {
  type TaggedEntry = { entry: ManifestEntry; endpoint: "search" | "context" };

  let totalSize = 0;
  const allEntries: TaggedEntry[] = [];

  for (const endpoint of ["search", "context"] as const) {
    for (const e of manifests[endpoint].entries) {
      totalSize += e.size;
      allEntries.push({ entry: e, endpoint });
    }
  }

  if (totalSize <= MAX_CACHE_SIZE) return;

  // Sort oldest-first
  allEntries.sort((a, b) => a.entry.cachedAt - b.entry.cachedAt);

  let currentSize = totalSize;
  let evictedCount = 0;

  for (const { entry, endpoint } of allEntries) {
    if (currentSize <= MAX_CACHE_SIZE) break;

    // Delete the cached response file
    const filePath = getEntryPath(endpoint, entry.hash);
    try {
      await unlink(filePath);
    } catch {
      // File may already be gone — that's fine
    }

    // Remove from in-memory manifest
    const idx = manifests[endpoint].entries.findIndex((e) => e.hash === entry.hash);
    if (idx !== -1) {
      manifests[endpoint].entries.splice(idx, 1);
    }

    currentSize -= entry.size;
    evictedCount++;
  }

  // Persist updated manifests atomically
  for (const endpoint of ["search", "context"] as const) {
    await writeManifest(endpoint);
  }

  const freedMB = ((totalSize - currentSize) / 1024 / 1024).toFixed(1);
  console.log(`[cache] Evicted ${evictedCount} entries (${freedMB} MB freed)`);
}

// ---------------------------------------------------------------------------
// Task 1: Init, Manifest Loading, Exact Match
// ---------------------------------------------------------------------------

/**
 * Initialize the cache layer.
 *
 * 1. Create directories (`libraries/`, `contexts/`)
 * 2. Load manifests into memory (or initialize as empty)
 * 3. Clean stale `.tmp` files
 * 4. Run eviction check
 */
async function init(): Promise<void> {
  if (initialized) return;

  // 1. Ensure directories exist
  await mkdir(join(CACHE_ROOT, "libraries"), { recursive: true });
  await mkdir(join(CACHE_ROOT, "contexts"), { recursive: true });

  // 2. Load manifests
  for (const endpoint of ["search", "context"] as const) {
    const mPath = getManifestPath(endpoint);
    try {
      const content = await readFile(mPath, "utf-8");
      const parsed: Manifest = JSON.parse(content);
      manifests[endpoint] = {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      manifests[endpoint] = { entries: [] };
    }
  }

  // 3. Clean stale .tmp files from both directories and root
  for (const endpoint of ["search", "context"] as const) {
    const dir = getEndpointDir(endpoint);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.endsWith(".tmp")) {
          try {
            await unlink(join(dir, file));
          } catch {
            // Race with another init() — ignore
          }
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  // Also clean manifest .tmp files from the root cache dir
  try {
    const rootFiles = await readdir(CACHE_ROOT);
    for (const file of rootFiles) {
      if (file.endsWith(".tmp")) {
        try {
          await unlink(join(CACHE_ROOT, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // Root may not exist
  }

  // 4. Eviction check
  await evictIfNeeded();

  initialized = true;
}

/**
 * Read a cached entry from disk by hash.
 */
async function readCacheEntry(endpoint: "search" | "context", hash: string): Promise<CacheEntry | null> {
  const filePath = getEntryPath(endpoint, hash);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as CacheEntry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task 2: BM25 Semantic Lookup
// ---------------------------------------------------------------------------

/**
 * Attempt a BM25 semantic lookup against manifest entries filtered by scope.
 *
 * - **search** endpoint: filters by `scope.libraryName`
 * - **context** endpoint: filters by `scope.libraryId`
 *
 * @param excludeHash - If provided, this entry is excluded from candidates.
 *   Used when the exact match was found (but stale) to avoid BM25 returning
 *   the same entry we already know is stale.
 */
async function tryBm25(
  endpoint: "search" | "context",
  scope: Record<string, string>,
  params: Record<string, string | boolean | undefined>,
  threshold: number,
  excludeHash?: string,
): Promise<CacheResult | null> {
  const query = extractQueryText(params);
  if (!query) return null;

  // Filter manifest entries by scope
  let candidates = manifests[endpoint].entries;

  if (endpoint === "search") {
    // Only match entries for the same library
    if (scope.libraryName) {
      candidates = candidates.filter((e) => e.scope.libraryName === scope.libraryName);
    }
  } else {
    // Only match entries for the same library/document
    if (scope.libraryId) {
      candidates = candidates.filter((e) => e.scope.libraryId === scope.libraryId);
    }
  }

  // Exclude the stale-exact-match entry so BM25 finds a *different* cached query
  if (excludeHash) {
    candidates = candidates.filter((e) => e.hash !== excludeHash);
  }

  if (candidates.length === 0) return null;

  const match = bm25Find(query, candidates, threshold);
  if (!match) return null;

  // Read the matched entry's cached data from disk
  const entry = await readCacheEntry(endpoint, match.hash);
  if (!entry) return null;

  return { data: entry.response, source: "bm25" };
}

// ---------------------------------------------------------------------------
// Task 5: Offline Mode
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached response.
 *
 * Flow:
 * 1. Compute canonical hash → try exact match
 * 2. If exact fresh → return `source:"exact"`
 * 3. If exact stale (online) → run BM25; fall back to stale if BM25 fails
 * 4. If exact stale (offline) → return `source:"stale"` directly
 * 5. If exact not found → run BM25 with appropriate threshold
 * 6. If nothing matches → return `source:null`
 */
async function get(
  endpoint: "search" | "context",
  scope: Record<string, string>,
  params: Record<string, string | boolean | undefined>,
): Promise<CacheResult> {
  await init();

  const hash = computeHash(params);
  const offline = isOffline();
  const threshold = offline ? BM25_THRESHOLD_OFFLINE : BM25_THRESHOLD_ONLINE;

  // 1. Try exact match
  const entry = await readCacheEntry(endpoint, hash);

  if (entry) {
    const isFresh = entry.cachedAt + entry.ttl * 1000 > Date.now();

    if (isFresh) {
      // Fresh exact match → return immediately
      return { data: entry.response, source: "exact" };
    }

    // Stale exact match
    if (offline) {
      // Offline: return stale data directly — caller prepends [cached, may be outdated]
      return { data: entry.response, source: "stale" };
    }

    // Online: try BM25 first (maybe a similar query was cached more recently)
    // Pass the current hash so BM25 skips the same stale entry.
    const bm25Result = await tryBm25(endpoint, scope, params, threshold, hash);
    if (bm25Result) {
      return bm25Result;
    }

    // No BM25 match either — fall back to the stale exact match
    return { data: entry.response, source: "stale" };
  }

  // 2. No exact match → try BM25 semantic lookup
  const bm25Result = await tryBm25(endpoint, scope, params, threshold);
  if (bm25Result) {
    return bm25Result;
  }

  // 3. Nothing cached
  return { data: null, source: null };
}

// ---------------------------------------------------------------------------
// Task 3: Atomic Writes
// ---------------------------------------------------------------------------

/**
 * Store a response in the cache atomically.
 *
 * 1. Compute hash from canonical params
 * 2. Write `{ response, cachedAt, ttl }` to `<hash>.json.tmp`
 * 3. `rename()` → `<hash>.json` (atomic on same filesystem)
 * 4. Update in-memory manifest with size tracking
 * 5. Write manifest to `<endpoint>.json.tmp` → `rename()` to `<endpoint>.json`
 */
async function set(
  endpoint: "search" | "context",
  scope: Record<string, string>,
  params: Record<string, string | boolean | undefined>,
  data: unknown,
): Promise<void> {
  await init();

  const hash = computeHash(params);
  const ttl = getTTL(endpoint);
  const now = Date.now();

  // Build the cache entry
  const entry: CacheEntry = {
    response: data,
    cachedAt: now,
    ttl,
  };

  // 1. Write entry file atomically
  const tmpPath = getEntryTempPath(endpoint, hash);
  const finalPath = getEntryPath(endpoint, hash);
  await writeFile(tmpPath, JSON.stringify(entry), "utf-8");
  await rename(tmpPath, finalPath);

  // 2. Compute response size (in bytes) for eviction accounting
  const size = Buffer.byteLength(JSON.stringify(data));
  const query = extractQueryText(params);

  // 3. Update in-memory manifest
  const existingIdx = manifests[endpoint].entries.findIndex((e) => e.hash === hash);
  const manifestEntry: ManifestEntry = {
    scope: { ...scope },
    query,
    hash,
    cachedAt: now,
    ttl,
    size,
  };

  if (existingIdx !== -1) {
    // Update existing entry
    manifests[endpoint].entries[existingIdx] = manifestEntry;
  } else {
    // Append new entry
    manifests[endpoint].entries.push(manifestEntry);
  }

  // 4. Write manifest atomically
  await writeManifest(endpoint);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new cache module instance.
 *
 * Usage:
 * ```typescript
 * import { createCache } from "./extensions/cache";
 * const cache = createCache();
 * await cache.init();
 * const result = await cache.get("search", { libraryName: "react" }, { query: "useState" });
 * ```
 */
export function createCache(): CacheModule {
  return { init, get, set };
}
