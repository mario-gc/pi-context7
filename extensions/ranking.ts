/**
 * Library ranking logic for Context7 search results.
 *
 * Computes a composite quality score for each library using three signals:
 *   - Stars (log-normalized) — strongest weight, reflects real-world adoption
 *   - Trust score (linear 0–10) — source reputation
 *   - Benchmark score (linear 0–100) — documentation quality
 *
 * Weights are exported as constants so they can be tested and kept in sync
 * with SKILL.md documentation.
 *
 * @module extensions/ranking
 */

/**
 * Weight for the log-normalized stars signal.
 * Stars are the dominant ranking signal — popular, established libraries
 * should win by default unless they have notably poor documentation quality.
 */
export const WEIGHT_STARS = 0.6;

/**
 * Weight for the trust score signal (0–10).
 * Most major libraries score 9–10, so the difference is minimal — trust
 * acts as a tie-breaker when stars are similar.
 */
export const WEIGHT_TRUST = 0.25;

/**
 * Weight for the benchmark score signal (0–100).
 * The least stable metric (changes with each documentation refresh) and
 * the least correlated with what the user actually wants.
 */
export const WEIGHT_BENCHMARK = 0.15;

/**
 * Extract the stars value from a library record, checking multiple
 * possible field names (camelCase, snake_case, githubStars).
 */
export function getStars(lib: Record<string, unknown>): number {
  return ((lib.stars ?? lib.githubStars ?? lib.github_stars ?? 0) as number) | 0;
}

/**
 * Extract the trust score from a library record (0–10).
 */
export function getTrust(lib: Record<string, unknown>): number {
  return ((lib.trustScore ?? lib.trust_score ?? 0) as number) | 0;
}

/**
 * Extract the benchmark score from a library record (0–100).
 */
export function getBenchmark(lib: Record<string, unknown>): number {
  return ((lib.benchmarkScore ?? lib.benchmark_score ?? 0) as number) | 0;
}

/**
 * Compute the composite quality score for a library.
 *
 * Stars are log-normalized: `log(stars + 1) / log(maxStars + 1)`.
 * This ensures a 1,000-star library scores meaningfully (~0.65) next to a
 * 220k-star library, rather than near-zero with linear normalization.
 *
 * Trust and benchmark are linearly normalized to 0–1.
 *
 * @param lib - The library record from the API response.
 * @param maxStars - The highest star count in the result set (for log normalization).
 * @returns Composite score in the range [0, 1].
 */
export function computeQualityScore(
  lib: Record<string, unknown>,
  maxStars: number,
): number {
  const stars = getStars(lib);
  const trust = getTrust(lib);
  const benchmark = getBenchmark(lib);

  // Log-normalize stars: log(stars + 1) / log(maxStars + 1)
  // When maxStars is 0, all star contributions are 0 (avoids division by zero / NaN).
  const starsNorm =
    maxStars > 0 ? Math.log(stars + 1) / Math.log(maxStars + 1) : 0;

  // Linear normalize trust (0-10) and benchmark (0-100)
  const trustNorm = trust / 10;
  const benchmarkNorm = benchmark / 100;

  return (
    WEIGHT_STARS * starsNorm +
    WEIGHT_TRUST * trustNorm +
    WEIGHT_BENCHMARK * benchmarkNorm
  );
}