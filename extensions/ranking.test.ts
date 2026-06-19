/**
 * Unit tests for library ranking logic (extensions/ranking.ts).
 *
 * Verifies:
 *   - Weight constants sum to exactly 1.0
 *   - Individual weight values are correct (0.6, 0.25, 0.15)
 *   - React (220k stars) outranks Preact (36k stars) with the new weights
 *   - Log normalization works correctly (no NaN, no division by zero)
 *   - Edge cases: stars=0, single result, all same stars, missing fields
 *
 * Run with: npm test
 *
 * @module extensions/ranking.test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  WEIGHT_STARS,
  WEIGHT_TRUST,
  WEIGHT_BENCHMARK,
  computeQualityScore,
  getStars,
  getTrust,
  getBenchmark,
} from "./ranking.ts";

// ---------------------------------------------------------------------------
// Helper: score a set of libraries and return them sorted by composite score
// (descending), mirroring the ranking logic in context7.ts.
// ---------------------------------------------------------------------------

function rankLibraries(libs: Record<string, unknown>[]): Array<{
  lib: Record<string, unknown>;
  score: number;
}> {
  const finalized = libs.filter(
    (lib) => lib.state === "finalized" || lib.state === undefined,
  );

  const maxStars = Math.max(...finalized.map((lib) => getStars(lib)), 0);

  return finalized
    .map((lib) => ({ lib, score: computeQualityScore(lib, maxStars) }))
    .sort((a, b) => b.score - a.score);
}

// ===========================================================================
// Weight Constants
// ===========================================================================

describe("Weight constants", () => {
  test("WEIGHT_STARS is 0.6", () => {
    assert.equal(WEIGHT_STARS, 0.6);
  });

  test("WEIGHT_TRUST is 0.25", () => {
    assert.equal(WEIGHT_TRUST, 0.25);
  });

  test("WEIGHT_BENCHMARK is 0.15", () => {
    assert.equal(WEIGHT_BENCHMARK, 0.15);
  });

  test("weights sum to exactly 1.0", () => {
    const sum = WEIGHT_STARS + WEIGHT_TRUST + WEIGHT_BENCHMARK;
    assert.equal(sum, 1.0);
  });

  test("no weight is zero or negative", () => {
    assert.ok(WEIGHT_STARS > 0, "WEIGHT_STARS must be positive");
    assert.ok(WEIGHT_TRUST > 0, "WEIGHT_TRUST must be positive");
    assert.ok(WEIGHT_BENCHMARK > 0, "WEIGHT_BENCHMARK must be positive");
  });
});

// ===========================================================================
// React vs Preact — the motivating example from the spec
// ===========================================================================

describe("React outranks Preact (stars=220000 vs 36000)", () => {
  const react = {
    id: "/facebook/react",
    title: "React",
    stars: 220000,
    trustScore: 10,
    benchmarkScore: 95.5,
    state: "finalized",
  };
  const preact = {
    id: "/preactjs/preact",
    title: "Preact",
    stars: 36000,
    trustScore: 9,
    benchmarkScore: 88.0,
    state: "finalized",
  };

  test("React composite score is greater than Preact", () => {
    const ranked = rankLibraries([preact, react]); // preact first to verify sorting
    assert.equal(ranked[0].lib.id, "/facebook/react");
    assert.equal(ranked[1].lib.id, "/preactjs/preact");
    assert.ok(
      ranked[0].score > ranked[1].score,
      `React (${ranked[0].score}) should outrank Preact (${ranked[1].score})`,
    );
  });

  test("React composite score is close to 1.0 (max)", () => {
    const maxStars = 220000;
    const score = computeQualityScore(react, maxStars);
    // React has the highest stars (starsNorm=1.0), max trust (1.0), high benchmark (0.955)
    // Expected: 0.6*1 + 0.25*1 + 0.15*0.955 = 0.99325
    assert.ok(
      score > 0.99,
      `React score should be ~0.993, got ${score}`,
    );
  });

  test("Preact composite score is meaningfully below React", () => {
    const maxStars = 220000;
    const reactScore = computeQualityScore(react, maxStars);
    const preactScore = computeQualityScore(preact, maxStars);
    const gap = reactScore - preactScore;
    // The gap should be at least 0.1 (significant margin)
    assert.ok(
      gap > 0.1,
      `React-Preact gap should be > 0.1, got ${gap}`,
    );
  });

  test("ranking works regardless of input order", () => {
    const order1 = rankLibraries([react, preact]);
    const order2 = rankLibraries([preact, react]);
    assert.equal(order1[0].lib.id, order2[0].lib.id);
  });
});

// ===========================================================================
// Log Normalization
// ===========================================================================

describe("Log normalization", () => {
  test("library with max stars gets starsNorm = 1.0", () => {
    const lib = { stars: 100000, trustScore: 0, benchmarkScore: 0 };
    const score = computeQualityScore(lib, 100000);
    // starsNorm = log(100001)/log(100001) = 1.0
    // composite = 0.6 * 1.0 + 0.25 * 0 + 0.15 * 0 = 0.6
    assert.equal(score, 0.6);
  });

  test("library with 0 stars gets starsNorm = 0 (no NaN)", () => {
    const lib = { stars: 0, trustScore: 5, benchmarkScore: 50 };
    const score = computeQualityScore(lib, 100000);
    // starsNorm = log(1)/log(100001) = 0/11.51 = 0
    // composite = 0.6*0 + 0.25*0.5 + 0.15*0.5 = 0.125 + 0.075 = 0.2
    assert.ok(!Number.isNaN(score), "score must not be NaN");
    assert.equal(score, 0.2);
  });

  test("log scale compresses extreme range (1k vs 220k stars)", () => {
    const maxStars = 220000;
    const smallLib = { stars: 1000, trustScore: 0, benchmarkScore: 0 };
    const bigLib = { stars: 220000, trustScore: 0, benchmarkScore: 0 };
    const smallScore = computeQualityScore(smallLib, maxStars);
    const bigScore = computeQualityScore(bigLib, maxStars);

    // Small library should still score meaningfully (not near zero)
    // log(1001)/log(220001) ≈ 6.91/12.30 ≈ 0.562
    // composite = 0.6 * 0.562 ≈ 0.337
    assert.ok(
      smallScore > 0.3,
      `1k-star lib should score > 0.3 with log norm, got ${smallScore}`,
    );
    // Big library gets full stars weight
    assert.equal(bigScore, 0.6);
    // But not 220x higher (which linear would give)
    assert.ok(
      bigScore / smallScore < 3,
      "log scale should compress the range significantly",
    );
  });

  test("starsNorm increases monotonically with star count", () => {
    const maxStars = 100000;
    const starCounts = [0, 10, 100, 1000, 10000, 100000];
    const scores = starCounts.map((s) =>
      computeQualityScore({ stars: s, trustScore: 0, benchmarkScore: 0 }, maxStars),
    );
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i] > scores[i - 1],
        `score should increase from ${starCounts[i - 1]} to ${starCounts[i]} stars`,
      );
    }
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge cases", () => {
  test("stars=0 does not cause NaN or Infinity", () => {
    const lib = { stars: 0, trustScore: 10, benchmarkScore: 100 };
    const score = computeQualityScore(lib, 50000);
    assert.ok(Number.isFinite(score), "score must be finite");
    // starsNorm = log(1)/log(50001) = 0
    // composite = 0.6*0 + 0.25*1 + 0.15*1 = 0.4
    assert.equal(score, 0.4);
  });

  test("maxStars=0 (all libraries have 0 stars) does not crash", () => {
    const lib = { stars: 0, trustScore: 10, benchmarkScore: 100 };
    const score = computeQualityScore(lib, 0);
    // maxStars=0 → starsNorm=0 (guard clause)
    // composite = 0.6*0 + 0.25*1 + 0.15*1 = 0.4
    assert.ok(Number.isFinite(score), "score must be finite");
    assert.equal(score, 0.4);
  });

  test("single result is always ranked first (Recommended)", () => {
    const lib = {
      id: "/some/lib",
      title: "SomeLib",
      stars: 50,
      trustScore: 3,
      benchmarkScore: 40,
      state: "finalized",
    };
    const ranked = rankLibraries([lib]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].lib.id, "/some/lib");
    assert.ok(ranked[0].score > 0, "single result should have a positive score");
  });

  test("all same stars — ranking falls to trust and benchmark", () => {
    // When all libraries have the same stars, starsNorm = 1.0 for all,
    // so the composite is determined by trust and benchmark.
    const libA = {
      id: "/a",
      title: "A",
      stars: 5000,
      trustScore: 10,
      benchmarkScore: 90,
      state: "finalized",
    };
    const libB = {
      id: "/b",
      title: "B",
      stars: 5000,
      trustScore: 5,
      benchmarkScore: 50,
      state: "finalized",
    };
    const libC = {
      id: "/c",
      title: "C",
      stars: 5000,
      trustScore: 7,
      benchmarkScore: 70,
      state: "finalized",
    };

    const ranked = rankLibraries([libB, libC, libA]);
    assert.equal(ranked[0].lib.id, "/a"); // highest trust + benchmark
    assert.equal(ranked[1].lib.id, "/c");
    assert.equal(ranked[2].lib.id, "/b"); // lowest trust + benchmark
  });

  test("missing trustScore and benchmarkScore treated as 0", () => {
    const lib = { stars: 10000, state: "finalized" }; // no trustScore, no benchmarkScore
    const score = computeQualityScore(lib, 10000);
    // starsNorm = 1.0, trustNorm = 0, benchmarkNorm = 0
    // composite = 0.6 * 1.0 + 0.25 * 0 + 0.15 * 0 = 0.6
    assert.ok(Number.isFinite(score));
    assert.equal(score, 0.6);
  });

  test("missing stars field treated as 0", () => {
    const lib = { trustScore: 10, benchmarkScore: 100, state: "finalized" };
    const score = computeQualityScore(lib, 50000);
    assert.ok(Number.isFinite(score));
    // stars=0 → starsNorm=0, trustNorm=1, benchmarkNorm=1
    // composite = 0 + 0.25 + 0.15 = 0.4
    assert.equal(score, 0.4);
  });

  test("non-finalized libraries are filtered out during ranking", () => {
    const finalized = {
      id: "/finalized",
      title: "Finalized",
      stars: 100,
      trustScore: 5,
      benchmarkScore: 50,
      state: "finalized",
    };
    const processing = {
      id: "/processing",
      title: "Processing",
      stars: 999999,
      trustScore: 10,
      benchmarkScore: 100,
      state: "processing",
    };
    const initial = {
      id: "/initial",
      title: "Initial",
      stars: 888888,
      trustScore: 10,
      benchmarkScore: 100,
      state: "initial",
    };

    const ranked = rankLibraries([processing, initial, finalized]);
    assert.equal(ranked.length, 1, "only finalized libraries should remain");
    assert.equal(ranked[0].lib.id, "/finalized");
  });

  test("state missing (undefined) is kept (backwards compatible)", () => {
    const lib = {
      id: "/no-state",
      title: "NoState",
      stars: 1000,
      trustScore: 7,
      benchmarkScore: 70,
      // no state field
    };
    const ranked = rankLibraries([lib]);
    assert.equal(ranked.length, 1);
  });
});

// ===========================================================================
// Field Accessor Helpers
// ===========================================================================

describe("Field accessors handle alternate field names", () => {
  test("getStars checks stars, githubStars, github_stars", () => {
    assert.equal(getStars({ stars: 100 }), 100);
    assert.equal(getStars({ githubStars: 200 }), 200);
    assert.equal(getStars({ github_stars: 300 }), 300);
    assert.equal(getStars({}), 0);
  });

  test("getTrust checks trustScore, trust_score", () => {
    assert.equal(getTrust({ trustScore: 8 }), 8);
    assert.equal(getTrust({ trust_score: 6 }), 6);
    assert.equal(getTrust({}), 0);
  });

  test("getBenchmark checks benchmarkScore, benchmark_score", () => {
    assert.equal(getBenchmark({ benchmarkScore: 75.5 }), 75);
    assert.equal(getBenchmark({ benchmark_score: 42.7 }), 42);
    assert.equal(getBenchmark({}), 0);
  });
});

// ===========================================================================
// Score Range Validation
// ===========================================================================

describe("Score range validation", () => {
  test("perfect library (max stars, max trust, max benchmark) scores 1.0", () => {
    const lib = { stars: 100000, trustScore: 10, benchmarkScore: 100 };
    const score = computeQualityScore(lib, 100000);
    assert.equal(score, 1.0);
  });

  test("worst library (0 everything) scores 0.0", () => {
    const lib = { stars: 0, trustScore: 0, benchmarkScore: 0 };
    const score = computeQualityScore(lib, 100000);
    assert.equal(score, 0.0);
  });

  test("all scores are in [0, 1] range", () => {
    const maxStars = 50000;
    const testCases = [
      { stars: 0, trustScore: 0, benchmarkScore: 0 },
      { stars: 1, trustScore: 1, benchmarkScore: 1 },
      { stars: 100, trustScore: 5, benchmarkScore: 50 },
      { stars: 1000, trustScore: 7, benchmarkScore: 70 },
      { stars: 50000, trustScore: 10, benchmarkScore: 100 },
    ];
    for (const tc of testCases) {
      const score = computeQualityScore(tc, maxStars);
      assert.ok(
        score >= 0 && score <= 1,
        `score ${score} for ${JSON.stringify(tc)} is out of [0,1]`,
      );
    }
  });
});