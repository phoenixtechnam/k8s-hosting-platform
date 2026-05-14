#!/usr/bin/env bash
set -euo pipefail

# ci-empty-cluster-issuer-check.sh — fail CI when a rendered overlay
# contains a cert-manager Certificate CR whose `issuerRef.name` is empty
# or carries an unresolved `${VAR}` placeholder.
#
# In the Traefik model, IngressRoutes do NOT carry the
# `cert-manager.io/cluster-issuer` annotation — the Ingress shim that
# read that annotation only sees `kind: Ingress`. Instead every
# IngressRoute that needs TLS is paired with an explicit `kind:
# Certificate` (cert-manager.io/v1) CR. This check is repurposed to
# audit those Certificate CRs.
#
# How a broken cert happens: an overlay leaves issuerRef.name as
# `${CLUSTER_ISSUER_NAME}` but the Flux postBuild substituteFrom
# ConfigMap doesn't define that key. Flux's envsubst silently emits
# the empty string. The ci-flux-envsubst-check.sh script catches
# MALFORMED `${...` patterns but not unresolved-variable patterns,
# since unresolved vars are valid envsubst input.
#
# Discovered empirically on 2026-05-07 (pre-Traefik) when
# webmail.staging ended up serving the controller's fake cert. The
# same gotcha applies to the Traefik default cert in v3.7 — if the
# Secret cert-manager would create never materialises, Traefik's
# TLSStore falls back to its hard-coded snake-oil cert.
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
    api = str(d.get("apiVersion") or "")
    if d.get("kind") != "Certificate" or not api.startswith("cert-manager.io/"):
        continue
    md = d.get("metadata") or {}
    name = md.get("name", "<unnamed>")
    ns = md.get("namespace", "<no-ns>")
    spec = d.get("spec") or {}
    issuer_ref = spec.get("issuerRef") or {}
    issuer_name = issuer_ref.get("name")
    secret_name = spec.get("secretName")
    issuer_str = "" if issuer_name is None else str(issuer_name)
    # Variables Flux postBuild substituteFrom is guaranteed to resolve
    # (bootstrap.sh seeds the platform-cluster-config ConfigMap with
    # these keys before Flux ever reconciles).
    KNOWN_VARS = {"DOMAIN", "ENV", "CLUSTER_ISSUER_NAME"}
    # Broken if: empty, OR an unresolved Flux postBuild placeholder
    # for a variable NOT in the known platform-cluster-config keys.
    # With no resolution Flux emits the empty string OR passes the
    # literal `${...}` through verbatim — both forms make cert-manager
    # refuse to issue.
    is_empty = issuer_str == ""
    has_unresolved_var = False
    if "${" in issuer_str:
        import re
        for var in re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", issuer_str):
            if var not in KNOWN_VARS:
                has_unresolved_var = True
                break
    if secret_name and (is_empty or has_unresolved_var):
        reason = "empty/missing" if is_empty else f"unresolved variable {issuer_str!r}"
        out.append(f"{overlay}: Certificate/{ns}/{name} targets secretName={secret_name!r} "
                   f"but issuerRef.name is {reason}. The Secret will never be "
                   f"created and Traefik will fall back to its built-in fake cert.")
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
  echo "ci-empty-cluster-issuer-check FAILED: $failures Certificate(s) with no resolvable issuerRef."
  echo "Fix: hardcode the issuer (e.g. \`letsencrypt-prod-http01\`) in the Certificate,"
  echo "     OR add the variable name (e.g. CLUSTER_ISSUER_NAME) to the platform-cluster-config"
  echo "     ConfigMap that Flux postBuild substituteFrom reads."
  exit 1
fi

echo "ci-empty-cluster-issuer-check PASSED — every Certificate CR has a non-empty issuerRef.name."
