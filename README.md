# @mario-gc/pi-context7

Context7 integration for pi coding agent. Fetch up-to-date library documentation and code examples directly from Context7.

## Installation

**Global install (npm):**
```bash
pi install npm:@mario-gc/pi-context7
```

**Global install (GitHub):**
```bash
pi install git:github.com/mario-gc/pi-context7
```

**Project install (adds to `.pi/settings.json`):**
```bash
pi install -l npm:@mario-gc/pi-context7
pi install -l git:github.com/mario-gc/pi-context7
```

**Local development:**
```bash
pi -e ./extensions/context7.ts
```

## Usage

This package provides two tools for the agent:

1. **context7_search_library** — Search Context7 for libraries by name. Resolves a library name to a Context7 library ID.
2. **context7_get_context** — Get up-to-date documentation context and code examples for a library from Context7.

Workflow: search for a library → get documentation context for code examples and API reference.

### Skill

A companion skill (`context7`) is also available. Use `/skill:context7` to load it.

## API Key Setup

Context7 uses an API key for authenticated access (higher rate limits). Unauthenticated requests work but have stricter rate limits.

**Environment variable:**
```bash
export CONTEXT7_API_KEY=ctx7sk-your-api-key-here
```

**Auth file** (`~/.pi/agent/auth.json`):
```json
{
  "context7": {
    "apiKey": "ctx7sk-your-api-key-here"
  }
}
```

Generate an API key at [https://context7.com/dashboard](https://context7.com/dashboard).

## Cache

Responses are cached locally for performance and offline resilience.

**Cache location:** `~/.pi/agent/cache/context7/`

- Search results cached for 7 days
- Documentation context cached for 3 days

**Offline mode:** Set `PI_OFFLINE=1` to use cached results only:
```bash
PI_OFFLINE=1 pi -e ./extensions/context7.ts
```

**Cache TTL override:** Set `CONTEXT7_CACHE_TTL` in minutes:
```bash
CONTEXT7_CACHE_TTL=60 pi -e ./extensions/context7.ts
```

## License

MIT
