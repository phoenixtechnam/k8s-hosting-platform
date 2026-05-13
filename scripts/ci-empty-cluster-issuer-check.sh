#!/usr/bin/env bash
set -euo pipefail

# ci-empty-cluster-issuer-check.sh — fail CI when a rendered overlay
# contains an Ingress with `cert-manager.io/cluster-issuer: ""` AND a
# non-empty `tls:` block. That combination guarantees a broken host:
# nginx-ingress falls back to the built-in fake self-signed cert
# because the Secret cert-manager would have populated never gets
# created (no issuer to drive provisioning).
#
# How this happens: an overlay uses `${CLUSTER_ISSUER_NAME}` (or any
# other variable) in the issuer annotation but the Flux postBuild
# substituteFrom ConfigMap doesn't define that key. Flux's envsubst
# silently emits the empty string. The ci-flux-envsubst-check.sh
# script catches MALFORMED `${...` patterns but not unresolved-
# variable patterns, since unresolved vars are valid envsubst input.
#
# We discovered the gap empirically on 2026-05-07 when
# webmail.staging.phoenix-host.net ended up serving the
# nginx-ingress fake cert in production-equivalent staging because
# the staging overlay used `${CLUSTER_ISSUER_NAME}` without
# platform-cluster-config defining it. CI was green; humans had to
# spot the broken cert on the wire.
#
# Run locally:
#   ./scripts/ci-empty-cluster-issuer-check.sh
#
# Wired into .github/workflows/ci-infrastructure.yml.

OVERLAYS=(
  "k8s/overlays/dev"
  "k8s/overlays/staging"
  "k8s/overlays/production"
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v kubectl &>/dev/null && ! command -v kustomize &>/dev/null; then
  echo "ERROR: neither kubectl nor kustomize available; cannot render overlays." >&2
  exit 2
fi

render() {
  if command -v kubectl &>/dev/null; then
    kubectl kustomize "$1"
  else
    kustomize build "$1"
  fi
}

failures=0
for overlay in "${OVERLAYS[@]}"; do
  if [[ ! -d "$overlay" ]]; then
    continue
  fi
  rendered=$(render "$overlay") || {
    echo "ERROR: kustomize render failed for $overlay" >&2
    failures=$((failures + 1))
    continue
  }

  # Walk every Ingress doc, look for empty cluster-issuer + tls block.
  # We use python because awk's YAML-doc-aware parsing is painful and
  # the project already requires python3 for other scripts.
  #
  # NB: the python script body lives in a tempfile because mixing a
  # heredoc-supplied script with stdin-piped data on the same python
  # invocation conflicts on `<<'PY'` (heredoc redirects stdin → the
  # piped `rendered` content gets discarded). Tempfile avoids the
  # ambiguity.
  py_script=$(mktemp)
  trap 'rm -f "$py_script"' EXIT
  cat > "$py_script" <<'PY'
import sys, yaml
overlay = sys.argv[1]
docs = list(yaml.safe_load_all(sys.stdin))
out = []
for d in docs:
    if not isinstance(d, dict):
        continue
    if d.get("kind") != "Ingress":
        continue
    md = d.get("metadata") or {}
    name = md.get("name", "<unnamed>")
    ns = md.get("namespace", "<no-ns>")
    annotations = md.get("annotations") or {}
    issuer = annotations.get("cert-manager.io/cluster-issuer")
    spec = d.get("spec") or {}
    tls = spec.get("tls") or []
    has_tls = bool(tls) and any(
        (t.get("hosts") and t.get("secretName")) for t in tls
        if isinstance(t, dict)
    )
    issuer_str = "" if issuer is None else str(issuer)
    # An issuer is "broken" if it's:
    #   1. literally empty/missing, OR
    #   2. an unresolved Flux postBuild placeholder like
    #      `${CLUSTER_ISSUER_NAME}` (Flux's envsubst would render this
    #      to the empty string at apply time IF the variable isn't
    #      defined in the substituteFrom ConfigMap, OR pass it through
    #      verbatim — both forms make cert-manager refuse to issue).
    is_empty = issuer_str == ""
    has_unresolved_var = "${" in issuer_str
    if has_tls and (is_empty or has_unresolved_var):
        reason = "empty/missing" if is_empty else f"unresolved variable {issuer_str!r}"
        out.append(f"{overlay}: Ingress/{ns}/{name} has tls.secretName "
                   f"but cert-manager.io/cluster-issuer is {reason}. "
                   f"The Secret will never be created and nginx-ingress "
                   f"will serve its built-in fake cert.")
for line in out:
    print(line)
PY
  problems=$(printf '%s' "$rendered" | python3 "$py_script" "$overlay") || true
  rm -f "$py_script"

  if [[ -n "$problems" ]]; then
    echo "$problems"
    failures=$((failures + $(echo "$problems" | wc -l)))
  fi
done

if (( failures > 0 )); then
  echo
  echo "ci-empty-cluster-issuer-check FAILED: $failures Ingress(es) with TLS but no cluster-issuer."
  echo "Fix: hardcode the issuer (e.g. \`letsencrypt-prod-http01\`) in the overlay,"
  echo "     OR add the variable name (e.g. CLUSTER_ISSUER_NAME) to the platform-cluster-config"
  echo "     ConfigMap that Flux postBuild substituteFrom reads."
  exit 1
fi

echo "ci-empty-cluster-issuer-check PASSED — every TLS-enabled Ingress has a non-empty cluster-issuer."
