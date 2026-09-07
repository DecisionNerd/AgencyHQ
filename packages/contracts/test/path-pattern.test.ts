import assert from "node:assert/strict";
import test from "node:test";

import {
  denySetCovers,
  matchesPath,
  parsePathPattern,
  pathSetSubset,
  patternSubset,
} from "../src/path-pattern.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pp(s: string) {
  return parsePathPattern(s);
}

// ---------------------------------------------------------------------------
// parsePathPattern — acceptance table
// ---------------------------------------------------------------------------

test("parsePathPattern: accepts simple file name", () => {
  assert.doesNotThrow(() => pp("foo.ts"));
});

test("parsePathPattern: accepts nested path", () => {
  assert.doesNotThrow(() => pp("src/index.ts"));
});

test("parsePathPattern: accepts ** whole-segment wildcard", () => {
  assert.doesNotThrow(() => pp("src/**"));
});

test("parsePathPattern: accepts ** in middle of path", () => {
  assert.doesNotThrow(() => pp("a/**/b"));
});

test("parsePathPattern: accepts single * in a segment", () => {
  assert.doesNotThrow(() => pp("src/*.ts"));
});

test("parsePathPattern: accepts ? in a segment", () => {
  assert.doesNotThrow(() => pp("src/f?o.ts"));
});

test("parsePathPattern: accepts segments with dots and hyphens", () => {
  assert.doesNotThrow(() => pp("dist/my-lib.d.ts"));
});

// ---------------------------------------------------------------------------
// parsePathPattern — rejection table
// ---------------------------------------------------------------------------

test("parsePathPattern: rejects empty string", () => {
  assert.throws(() => pp(""), /empty/i);
});

test("parsePathPattern: rejects absolute path", () => {
  assert.throws(() => pp("/etc/passwd"), /absolute/i);
});

test("parsePathPattern: rejects ./ prefix", () => {
  assert.throws(() => pp("./src"), /\.\/|leading/i);
});

test("parsePathPattern: rejects trailing slash", () => {
  assert.throws(() => pp("src/"), /trailing/i);
});

test("parsePathPattern: rejects .. segment", () => {
  assert.throws(() => pp("src/../etc"), /\.\./);
});

test("parsePathPattern: rejects backslash", () => {
  assert.throws(() => pp("src\\index.ts"), /backslash/i);
});

test("parsePathPattern: rejects empty segment (double slash)", () => {
  assert.throws(() => pp("src//foo"), /empty/i);
});

// ---------------------------------------------------------------------------
// matchesPath — table mirroring trigger/test/paths.test.ts cases
// ---------------------------------------------------------------------------

test("matchesPath: src/* allows a direct child but not nested", () => {
  assert.equal(matchesPath(pp("src/*"), "src/a.ts"), true);
  assert.equal(matchesPath(pp("src/*"), "src/x/b.ts"), false);
});

test("matchesPath: src/** allows nested files", () => {
  assert.equal(matchesPath(pp("src/**"), "src/x/b.ts"), true);
  assert.equal(matchesPath(pp("src/**"), "src/a.ts"), true);
});

test("matchesPath: ** matches everything including slashes", () => {
  assert.equal(matchesPath(pp("**"), "a/b/c"), true);
  assert.equal(matchesPath(pp("**"), "foo"), true);
});

test("matchesPath: ? matches exactly one non-slash char", () => {
  assert.equal(matchesPath(pp("src/f?o.ts"), "src/foo.ts"), true);
  assert.equal(matchesPath(pp("src/f?o.ts"), "src/fo.ts"), false);
  assert.equal(matchesPath(pp("src/f?o.ts"), "src/f/o.ts"), false);
});

test("matchesPath: *.ts matches .ts files in a segment", () => {
  assert.equal(matchesPath(pp("*.ts"), "index.ts"), true);
  assert.equal(matchesPath(pp("*.ts"), "index.js"), false);
  assert.equal(matchesPath(pp("*.ts"), "src/index.ts"), false); // * doesn't cross /
});

test("matchesPath: exact literal does not match other paths", () => {
  assert.equal(matchesPath(pp("src/index.ts"), "src/index.ts"), true);
  assert.equal(matchesPath(pp("src/index.ts"), "src/other.ts"), false);
});

test("matchesPath: **/*.ts matches ts files at any depth", () => {
  assert.equal(matchesPath(pp("**/*.ts"), "src/index.ts"), true);
  assert.equal(matchesPath(pp("**/*.ts"), "a/b/c.ts"), true);
  assert.equal(matchesPath(pp("**/*.ts"), "a/b/c.js"), false);
});

// ---------------------------------------------------------------------------
// patternSubset — basic cases
// ---------------------------------------------------------------------------

test("patternSubset: identical patterns are subsets of each other", () => {
  assert.equal(patternSubset(pp("src/**"), pp("src/**")), true);
  assert.equal(patternSubset(pp("*.ts"), pp("*.ts")), true);
});

test("patternSubset: src/parser/** is narrower than src/**", () => {
  assert.equal(patternSubset(pp("src/parser/**"), pp("src/**")), true);
});

test("patternSubset: src/** is NOT narrower than src/parser/**", () => {
  assert.equal(patternSubset(pp("src/**"), pp("src/parser/**")), false);
});

test("patternSubset: **/*.ts and src/** are not subsets of each other (ADR example)", () => {
  assert.equal(patternSubset(pp("**/*.ts"), pp("src/**")), false);
  assert.equal(patternSubset(pp("src/**"), pp("**/*.ts")), false);
});

test("patternSubset: any pattern is a subset of **", () => {
  assert.equal(patternSubset(pp("src/**"), pp("**")), true);
  assert.equal(patternSubset(pp("src/index.ts"), pp("**")), true);
  assert.equal(patternSubset(pp("*.ts"), pp("**")), true);
});

test("patternSubset: src/* is a subset of src/**", () => {
  assert.equal(patternSubset(pp("src/*"), pp("src/**")), true);
});

test("patternSubset: src/** is NOT a subset of src/*", () => {
  assert.equal(patternSubset(pp("src/**"), pp("src/*")), false);
});

test("patternSubset: literal is a subset of *", () => {
  assert.equal(patternSubset(pp("foo.ts"), pp("*")), true);
});

test("patternSubset: literal is NOT a subset of different literal", () => {
  assert.equal(patternSubset(pp("foo.ts"), pp("bar.ts")), false);
});

test("patternSubset: a/**/b is a subset of a/**", () => {
  assert.equal(patternSubset(pp("a/**/b"), pp("a/**")), true);
});

test("patternSubset: ** is NOT a subset of src/**", () => {
  assert.equal(patternSubset(pp("**"), pp("src/**")), false);
});

// ---------------------------------------------------------------------------
// Exhaustive subset agreement test
// ---------------------------------------------------------------------------

/**
 * Build all path strings up to `maxSegs` segments from the given alphabet.
 */
function buildPaths(alphabet: string[], maxSegs: number): string[] {
  const paths: string[] = [];
  function recurse(current: string, depth: number) {
    if (depth > 0) paths.push(current);
    if (depth < maxSegs) {
      for (const seg of alphabet) {
        recurse(depth === 0 ? seg : `${current}/${seg}`, depth + 1);
      }
    }
  }
  recurse("", 0);
  return paths;
}

const PATH_ALPHABET = ["a", "b", "a.ts", "ab"];
const SAMPLE_PATHS = buildPaths(PATH_ALPHABET, 3);

/**
 * Brute-force subset check over the sample path set.
 * Returns true iff for every path in sample that matches `narrow`, it also matches `wide`.
 * (May miss paths outside the sample — see patternSubset spec note.)
 */
function bruteForceSubset(narrow: string, wide: string): boolean {
  const nr = parsePathPattern(narrow);
  const wr = parsePathPattern(wide);
  return SAMPLE_PATHS.every((path) => !matchesPath(nr, path) || matchesPath(wr, path));
}

// Pattern pairs where patternSubset claims to be exact.
// (Patterns whose algorithm returns true should NEVER have a counterexample.)
const PATTERN_PAIRS: Array<[string, string]> = [
  // identical
  ["a", "a"],
  ["a/**", "a/**"],
  ["**", "**"],
  // strict narrowing
  ["a/b", "a/**"],
  ["a/b", "a/*"],
  ["a/b", "**"],
  ["a/b", "*/*"],
  ["a/*", "a/**"],
  ["a/*", "**"],
  ["a/**", "**"],
  ["a/b/**", "a/**"],
  ["a/b/**", "**"],
  ["a/b/*", "a/**"],
  ["a/b/*", "a/b/**"],
  // NOT subsets
  ["a/**", "a/b/**"],
  ["**", "a/**"],
  ["a/b", "a/b.ts"],
  ["a/*", "a/b"],
  ["a/**", "a/b"],
  ["a.ts", "*"],
  ["a.ts", "**"],
  ["a.ts", "a.ts"],
  ["a.ts", "b"],
  // multi-segment ** patterns
  ["a/**/b", "a/**"],
  ["a", "*"],
  ["a/b", "*/*"],
];

test("patternSubset exhaustive agreement over sample paths (~30 pattern pairs)", () => {
  let checked = 0;
  for (const [narrow, wide] of PATTERN_PAIRS) {
    const algo = patternSubset(pp(narrow), pp(wide));
    const brute = bruteForceSubset(narrow, wide);
    // The algorithm must never claim true when brute-force finds a counterexample.
    if (algo) {
      assert.equal(
        brute,
        true,
        `patternSubset(${narrow}, ${wide}) = true but brute-force found a counterexample`,
      );
    }
    // Algo returning false when brute-force returns true is acceptable only if
    // the counterexample lies outside the sample (we document this in the spec).
    checked++;
  }
  assert.ok(checked >= 25, `only ${checked} pairs checked; need at least 25`);
});

// ---------------------------------------------------------------------------
// pathSetSubset
// ---------------------------------------------------------------------------

test("pathSetSubset: every narrow pattern covered by a wide pattern", () => {
  const narrow = [pp("src/parser/**"), pp("src/utils/**")];
  const wide = [pp("src/**"), pp("test/**")];
  assert.equal(pathSetSubset(narrow, wide), true);
});

test("pathSetSubset: fails when a narrow pattern has no wide cover", () => {
  const narrow = [pp("src/**"), pp("infra/**")];
  const wide = [pp("src/**")];
  assert.equal(pathSetSubset(narrow, wide), false);
});

test("pathSetSubset: empty narrow set is always a subset", () => {
  assert.equal(pathSetSubset([], [pp("src/**")]), true);
});

test("pathSetSubset: any narrow set is a subset of [**]", () => {
  const narrow = [pp("src/**"), pp("test/**"), pp("*.ts")];
  assert.equal(pathSetSubset(narrow, [pp("**")]), true);
});

// ---------------------------------------------------------------------------
// denySetCovers
// ---------------------------------------------------------------------------

test("denySetCovers: narrow deny that strictly contains wide deny passes", () => {
  // Inner denies more than outer → OK (inner is allowed to deny more).
  const wideDeny = [pp("secrets/**")];
  const narrowDeny = [pp("secrets/**"), pp("infra/**")];
  assert.equal(denySetCovers(narrowDeny, wideDeny), true);
});

test("denySetCovers: narrow deny that exactly matches wide deny passes", () => {
  const deny = [pp("secrets/**")];
  assert.equal(denySetCovers(deny, deny), true);
});

test("denySetCovers: narrow deny missing a wide pattern fails", () => {
  const wideDeny = [pp("secrets/**"), pp("infra/**")];
  const narrowDeny = [pp("secrets/**")];
  assert.equal(denySetCovers(narrowDeny, wideDeny), false);
});

test("denySetCovers: empty wide deny is always covered", () => {
  assert.equal(denySetCovers([], []), true);
  assert.equal(denySetCovers([pp("secrets/**")], []), true);
});

test("denySetCovers: narrow with ** covers any wide deny set", () => {
  const wideDeny = [pp("secrets/**"), pp("infra/**"), pp("*.env")];
  const narrowDeny = [pp("**")];
  assert.equal(denySetCovers(narrowDeny, wideDeny), true);
});
