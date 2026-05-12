// OCI image reference parser. Handles the four canonical shapes:
//
//   nginx
//   nginx:1.27
//   docker.io/library/nginx:1.27
//   ghcr.io/owner/app@sha256:<hex>
//
// Normalisation: bare names ('nginx') resolve to 'docker.io/library/nginx';
// host-less names with a slash ('owner/app') resolve to 'docker.io/owner/app';
// missing tag → null tag (the consumer chooses how to surface that). The
// update-checker uses the normalised host + repo to talk to the right
// registry.
//
// Reference: https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pulling-manifests

export interface ParsedImageReference {
  /** Registry hostname, normalised (`docker.io`, `ghcr.io`, …).
   *  No port stripping — `registry.example.com:5000` stays intact. */
  readonly registryHost: string;
  /** Repository name with namespace, no leading slash, no tag/digest.
   *  Always includes a namespace — bare `nginx` becomes `library/nginx`. */
  readonly repository: string;
  /** Tag if present (`1.27`, `latest`). Null when only a digest was given. */
  readonly tag: string | null;
  /** Digest (`sha256:<64-hex>`) when the reference was digest-pinned. */
  readonly digest: string | null;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const REPO_SEGMENT_RE = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;

/**
 * Parse an image reference. Returns null on syntactically invalid input
 * (caller surfaces this as a structural error). Lenient where the OCI
 * spec is lenient — bare `nginx`, hostless `owner/app`, both fine.
 */
export function parseImageReference(raw: string): ParsedImageReference | null {
  if (!raw || typeof raw !== 'string') return null;
  const input = raw.trim();
  if (input.length === 0 || input.length > 500) return null;

  // Split off digest first (digests can never appear inside the tag).
  let beforeDigest = input;
  let digest: string | null = null;
  const atIdx = input.lastIndexOf('@');
  if (atIdx !== -1) {
    const digestPart = input.slice(atIdx + 1);
    if (!DIGEST_RE.test(digestPart)) return null;
    digest = digestPart;
    beforeDigest = input.slice(0, atIdx);
  }

  // Split off tag (last `:` segment that's NOT a port in the host part).
  let tag: string | null = null;
  let beforeTag = beforeDigest;
  // The tag separator is the last `:` AFTER the final `/`. Anything
  // earlier is part of a host:port. If there's no `/`, the whole
  // string is the repo segment and any `:` is a tag.
  const lastSlash = beforeDigest.lastIndexOf('/');
  const lastColon = beforeDigest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    const tagPart = beforeDigest.slice(lastColon + 1);
    if (!TAG_RE.test(tagPart)) return null;
    tag = tagPart;
    beforeTag = beforeDigest.slice(0, lastColon);
  }

  // Decide host vs no-host: the first segment is a host iff it
  // contains `.` or `:` (port) or is the literal `localhost`. Otherwise
  // the whole `beforeTag` is a (possibly multi-segment) repo on
  // docker.io.
  const firstSlash = beforeTag.indexOf('/');
  let registryHost: string;
  let repository: string;
  if (firstSlash === -1) {
    // Single segment — always interpret as docker.io/library/<name>.
    if (!REPO_SEGMENT_RE.test(beforeTag)) return null;
    registryHost = 'docker.io';
    repository = `library/${beforeTag}`;
  } else {
    const first = beforeTag.slice(0, firstSlash);
    const rest = beforeTag.slice(firstSlash + 1);
    const looksLikeHost = first.includes('.') || first.includes(':') || first === 'localhost';
    if (looksLikeHost) {
      registryHost = first;
      repository = rest;
    } else {
      // owner/app shape → docker.io/owner/app.
      registryHost = 'docker.io';
      repository = beforeTag;
    }
    // Validate every repo segment.
    for (const segment of repository.split('/')) {
      if (!REPO_SEGMENT_RE.test(segment)) return null;
    }
  }

  return { registryHost, repository, tag, digest };
}

/**
 * "Pinned" means a digest is set OR a tag is set AND the tag is not
 * `latest`. Unpinned references can have their content silently
 * replaced by the registry between pulls, which is what the
 * UNPINNED_TAG_ADVISORY warning surfaces.
 */
export function isPinnedReference(ref: ParsedImageReference): boolean {
  if (ref.digest) return true;
  if (!ref.tag) return false;
  if (ref.tag === 'latest') return false;
  return true;
}

/**
 * Reconstruct a stable reference string from a parsed form. Used by
 * the update-checker cache key so two callers writing the same image
 * in different ways share one cache row.
 */
export function formatImageReference(ref: ParsedImageReference): string {
  let base = `${ref.registryHost}/${ref.repository}`;
  if (ref.tag) base += `:${ref.tag}`;
  if (ref.digest) base += `@${ref.digest}`;
  return base;
}
