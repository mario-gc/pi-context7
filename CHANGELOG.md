# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `CONTEXT7_CACHE_ROOT` environment variable override for cache directory (defaults to `~/.pi/agent/cache/context7`)
- Unit tests for BM25 scoring and cache timing (`extensions/cache.test.ts`)
- `npm test` and `npm run typecheck` scripts in `package.json`

### Changed
- Library auto-ranking weights updated: Stars 60% (was 40%), Trust 25% (was 35%), Benchmark 15% (was 25%). Stars is now the dominant signal so popular libraries rank first unless they have notably poor documentation quality.
- Extracted `computeQualityScore` and weight constants to `extensions/ranking.ts` for unit testability

### Fixed
- Cache write timing: `cache.set` is now awaited (was fire-and-forget), preventing BM25 cache misses for rapid sequential queries
- Tool execution mode set to `sequential` for both context7 tools, preventing parallel cache misses
- Cache write errors now logged via `console.error` instead of silently swallowed

## [0.1.2] - 2026-06-19

### Added
- Library auto-ranking with composite quality score (Stars 40% + Trust 35% + Benchmark 25%)
- Non-finalized libraries filtered from search results
- Top 3 results shown with Recommended marker
- Library Rules section in `context7_get_context` output when rules are present

### Changed
- BM25 cache scoring uses corpus-frequency IDF instead of constant value
- English stopwords filtered before BM25 scoring
- BM25 thresholds changed to raw scores with IDF floor and term overlap checks
- `infoSnippets` uses breadcrumb as title and pageId as source link
- SKILL.md documents automatic ranking and updated retry strategy

### Fixed
- False cache hits from common English words dominating BM25 scores
- `infoSnippets` rendering as "Info" instead of using breadcrumb field
- Removed unused `researchMode` parameter from `context7_get_context`

## [0.1.1] - 2026-05-05

### Fixed
- Code snippet display in `context7_get_context`: now correctly renders `codeTitle`, `codeDescription`, `codeLanguage`, and `codeList[].code` from the API — no more empty code blocks
- Missing cache source notifications: both tools now show `[cache hit]` for fresh exact matches and `[fetched from API]` for API fetches

## [0.1.0] - 2026-05-05

### Added
- BM25-backed semantic cache for Context7 API responses with MD5 exact match, BM25 semantic lookup, atomic writes, eviction, and offline mode
- `context7_search_library` tool — resolve library names to Context7 library IDs
- `context7_get_context` tool — fetch documentation with code examples and research mode
- Agent skill (`/skill:context7`) with two-step workflow, query quality guidelines, and version awareness

### Fixed
- Narrowed extensions manifest to entry point only to prevent internal `cache.ts` module from being loaded as a separate extension
- Removed unnecessary `"type": "commonjs"` from `package.json`
- Reframed skill API key section from human-setup instructions to agent-action guidance
