# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- BM25-backed semantic cache for Context7 API responses with MD5 exact match, BM25 semantic lookup, atomic writes, eviction, and offline mode
- `context7_search_library` tool — resolve library names to Context7 library IDs
- `context7_get_context` tool — fetch documentation with code examples and research mode
- Agent skill (`/skill:context7`) with two-step workflow, query quality guidelines, and version awareness

### Fixed
- Narrowed extensions manifest to entry point only to prevent internal `cache.ts` module from being loaded as a separate extension
- Removed unnecessary `"type": "commonjs"` from `package.json`
- Reframed skill API key section from human-setup instructions to agent-action guidance
