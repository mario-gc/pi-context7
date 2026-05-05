---
name: context7
description: >-
  Fetches up-to-date documentation, API references, and code examples for any
  library, framework, or tool via Context7. Use this skill when the user asks
  about library setup, configuration, API syntax, version-specific behavior, or
  needs code examples involving specific libraries (React, Next.js, Prisma,
  Express, Tailwind, Supabase, etc.). Always prefer Context7 over training data
  for library-specific questions — training data may be outdated. Do not use for
  general programming questions, pure language syntax, or questions answerable
  without library documentation.
---

# Context7 Documentation Lookup

Retrieve current, version-specific documentation and code examples using Context7.

## Workflow

### Step 1: Resolve the Library

Call `context7_search_library` with:

- `libraryName`: The library extracted from the user's question (e.g., "react", "nextjs", "prisma")
- `query`: The user's full question or task description — improves ranking
- `fast`: Set to `true` only for latency-sensitive cases (trades accuracy)

### Step 2: Select the Best Match

From the results, choose based on:
- Exact or closest name match to what the user asked for
- Higher benchmark scores (out of 100) indicate better documentation quality
- Higher trust scores (out of 10) indicate more authoritative sources
- If the user mentioned a version (e.g., "React 19"), prefer version-specific IDs from the `versions` list

### Step 3: Fetch Documentation

Call `context7_get_context` with:

- `libraryId`: The selected Context7 library ID (e.g., `/vercel/next.js`)
- `query`: The user's specific question — be descriptive
- `type`: Use "json" for structured snippets (default), "txt" for plain text
- `researchMode`: Only use this as a **retry** if the initial results are insufficient

### Step 4: Use the Documentation

Incorporate the fetched documentation into your response:
- Answer the user's question using current, accurate information
- Include relevant code examples from the docs
- Cite the library version when relevant
- Reference the source page/breadcrumb when helpful (from `pageTitle` or `breadcrumb`)

## Query Quality

| Good | Bad |
|------|-----|
| "How to set up JWT authentication in Express middleware" | "auth" |
| "React useEffect cleanup function with async operations" | "hooks" |
| "Prisma one-to-many relation with cascade delete" | "relations" |

Pass the user's intent and relevant details — single-word queries return generic results.

## Version Awareness

When users mention specific versions:
- Use version-specific library IDs from the search results: `/vercel/next.js@v15.1.8`
- Both `@` and `/` separators work: `/vercel/next.js/v15.1.8`
- If the exact version isn't available, pick the closest match

## Retry Strategy

If `context7_get_context` returns insufficient or irrelevant results:
1. Retry with `researchMode: true` — this uses deeper agentic search
2. If still insufficient, consider refining the query with more specific terms
3. Do not silently fall back to training data without telling the user

## Guidelines

- Always run `context7_search_library` before `context7_get_context` — you need a valid library ID
- Pass the user's full question as `query` for better relevance
- Prefer official/primary packages over community forks when multiple matches exist
- If you encounter rate limits or quota errors, inform the user they can set `CONTEXT7_API_KEY` for higher limits. API keys are available at https://context7.com/dashboard.
- Results are cached locally for reuse — similar queries may hit the cache automatically
