// Minimal semver-aware version comparator + bump-severity classifier.
// We do NOT pull in the `semver` package because the update-checker
// only needs three operations: parse-or-null, compare, classify-bump.
// Anything more sophisticated (pre-release ordering, range matching)
// is out of scope — registry tags that aren't simple semver fall
// through to `unknown` and are surfaced as such.

export interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifier (e.g. `-rc1`). Tracked but ignored for
   *  bump-severity classification — `1.0.0-rc2` → `1.0.0` is still
   *  a patch in our model. */
  readonly pre: string | null;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.-]+))?$/;

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-rc1`. Returns null on non-match. */
export function parseSemver(tag: string): SemverVersion | null {
  if (!tag || typeof tag !== 'string') return null;
  const m = SEMVER_RE.exec(tag.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre: m[4] ?? null,
  };
}

/** -1 / 0 / 1 strcmp-style comparator. Pre-release is treated as
 *  lower than no-pre at the same M.m.p (per semver spec). */
export function compareSemver(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A version WITH a pre-release is LOWER than the same version
  // WITHOUT one. `1.0.0-rc1` < `1.0.0`.
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  // Both have pre-releases — lexicographic, no dotted-segment parsing.
  return a.pre < b.pre ? -1 : 1;
}

export type BumpSeverity = 'no-update' | 'patch' | 'minor' | 'major' | 'unknown';

/** Compare a current version to a candidate latest. The candidate
 *  is assumed to be `>= current` already (the caller filters out
 *  older tags before calling). */
export function classifyBump(current: SemverVersion, latest: SemverVersion): BumpSeverity {
  if (latest.major > current.major) return 'major';
  if (latest.major < current.major) return 'no-update'; // defensive
  if (latest.minor > current.minor) return 'minor';
  if (latest.minor < current.minor) return 'no-update';
  if (latest.patch > current.patch) return 'patch';
  if (latest.patch < current.patch) return 'no-update';
  return 'no-update'; // same triple — pre-release differences ignored
}

/**
 * Pick the highest-versioned tag in a list that is >= `current` AND
 * not a pre-release (we don't auto-suggest pre-releases). Returns
 * null when no tag in the list is parseable as semver or no parseable
 * tag is greater than current.
 */
export function pickLatestStable(
  tags: readonly string[],
  current: SemverVersion,
): { tag: string; version: SemverVersion } | null {
  let best: { tag: string; version: SemverVersion } | null = null;
  for (const raw of tags) {
    const v = parseSemver(raw);
    if (!v || v.pre !== null) continue;
    if (compareSemver(v, current) <= 0) continue;
    if (best === null || compareSemver(v, best.version) > 0) {
      best = { tag: raw, version: v };
    }
  }
  return best;
}
