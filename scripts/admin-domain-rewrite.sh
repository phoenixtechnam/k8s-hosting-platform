#!/usr/bin/env bash
# admin-domain-rewrite.sh — rewrite system_settings to a new domain.
#
# Use after a DR pg_restore: the source dump carries the SOURCE
# cluster's `admin_panel_url`/`client_panel_url`/`ingress_base_domain`,
# but the operator's restored cluster has a DIFFERENT domain. Without
# this rewrite, platform-api's ingress-reconciler keeps reasserting
# the source domain on the Ingress (because system_settings is the
# source of truth for fieldManager=platform-api).
#
# Updates:
#   admin_panel_url       → https://admin.<NEW_DOMAIN>
#   client_panel_url      → https://client.<NEW_DOMAIN>
#   ingress_base_domain   → <NEW_DOMAIN>
#   webmail_url           → https://webmail.<NEW_DOMAIN>  (if non-NULL)
#   mail_hostname         → mail.<NEW_DOMAIN>            (if non-NULL)
#
# Also bumps the platform_settings KV row + invalidates the
# ingress-reconciler cache by rolling platform-api so the new values
# get applied to the live Ingress within ~30s.
#
# USAGE:
#   ./scripts/admin-domain-rewrite.sh --domain <new-apex>
#
# OPTIONS:
#   --domain <apex>     New apex domain (e.g. testing.phoenix-host.net)
#   --kubeconfig <p>    Override KUBECONFIG (default: /etc/rancher/k3s/k3s.yaml)
#   --namespace <ns>    Platform namespace (default: platform)
#
# EXAMPLES:
#   sudo ./scripts/admin-domain-rewrite.sh --domain testing.phoenix-host.net
set -uo pipefail

DOMAIN=""
KUBECONFIG_OVERRIDE=""
NAMESPACE="platform"

while (( $# > 0 )); do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --kubeconfig) KUBECONFIG_OVERRIDE="$2"; shift 2 ;;
    --namespace)  NAMESPACE="$2"; shift 2 ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$DOMAIN" ]] || { echo "ERROR: --domain required" >&2; exit 2; }
# DNS-label-ish sanity. Apex can have multiple parts (a.b.c) so we
# allow dots; but no shell metas, no whitespace.
if ! [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "ERROR: --domain must be a valid DNS apex (lowercase, dots/hyphens, no metachars): got '$DOMAIN'" >&2
  exit 2
fi
# Apex MUST contain at least one dot — a value like 'foo' or
# 'localhost' would produce nonsensical 'admin.foo' URLs that no
# DNS will resolve. Cheap typo guard.
if [[ "$DOMAIN" != *.* ]]; then
  echo "ERROR: --domain must contain at least one dot (got '$DOMAIN')" >&2
  exit 2
fi

if [[ -n "$KUBECONFIG_OVERRIDE" ]]; then
  export KUBECONFIG="$KUBECONFIG_OVERRIDE"
elif [[ -z "${KUBECONFIG:-}" ]]; then
  export KUBECONFIG="/etc/rancher/k3s/k3s.yaml"
fi

# Target the PRIMARY only — UPDATE on a replica fails with
# "cannot execute UPDATE in a read-only transaction" and the
# operator gets a confusing psql error. Same selector pattern the
# admin-password-reset.sh sister tool uses.
#
# Cluster name was renamed `postgres` → `system-db` in the 2026-05-07
# PG18 migration; try the canonical name first and fall back to the
# legacy name so this tool keeps working on pre-migration clusters.
POD=$(kubectl -n "$NAMESPACE" get pods -l cnpg.io/cluster=system-db,role=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [[ -z "$POD" ]]; then
  POD=$(kubectl -n "$NAMESPACE" get pods -l cnpg.io/cluster=postgres,role=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
fi
[[ -n "$POD" ]] || { echo "ERROR: no postgres primary pod found in namespace $NAMESPACE (looked for cnpg.io/cluster in [system-db, postgres] with role=primary)" >&2; exit 1; }

# UPDATE system_settings + platform_settings via a SINGLE psql session
# inside the postgres pod. Using cluster superuser ('postgres') so we
# don't need the platform user's password — same convention as
# admin-password-reset.sh.
ADMIN_URL="https://admin.${DOMAIN}"
CLIENT_URL="https://client.${DOMAIN}"
WEBMAIL_URL="https://webmail.${DOMAIN}"
MAIL_HOST="mail.${DOMAIN}"

kubectl -n "$NAMESPACE" exec -i "$POD" -c postgres -- psql -v ON_ERROR_STOP=1 hosting_platform <<SQL
BEGIN;
UPDATE system_settings
   SET admin_panel_url     = '${ADMIN_URL}',
       client_panel_url    = '${CLIENT_URL}',
       ingress_base_domain = '${DOMAIN}',
       webmail_url         = COALESCE(NULLIF(webmail_url, ''), '${WEBMAIL_URL}'),
       mail_hostname       = COALESCE(NULLIF(mail_hostname, ''), '${MAIL_HOST}');
UPDATE platform_settings SET setting_value = '${DOMAIN}', updated_at = NOW()
 WHERE setting_key = 'ingress_base_domain';
INSERT INTO platform_settings (setting_key, setting_value, updated_at)
SELECT 'ingress_base_domain', '${DOMAIN}', NOW()
 WHERE NOT EXISTS (SELECT 1 FROM platform_settings WHERE setting_key='ingress_base_domain');
COMMIT;
SQL

# Audit row (non-critical; runs in its own statement so a schema
# mismatch can't roll back the rewrite).
kubectl -n "$NAMESPACE" exec -i "$POD" -c postgres -- psql hosting_platform >/dev/null 2>&1 <<SQL || true
INSERT INTO audit_logs (id, action_type, resource_type, resource_id, actor_id, actor_type,
                        http_method, http_path, http_status, changes, created_at)
VALUES (gen_random_uuid()::text, 'admin_domain_rewrite_via_cli', 'system_settings', 'system',
        'cli', 'system', 'CLI', '/scripts/admin-domain-rewrite.sh', 200,
        json_build_object('newDomain', '${DOMAIN}'), NOW());
SQL

echo
echo "Domain rewritten: ${DOMAIN}"
echo "  admin_panel_url     = ${ADMIN_URL}"
echo "  client_panel_url    = ${CLIENT_URL}"
echo "  ingress_base_domain = ${DOMAIN}"
echo
echo "Rolling platform-api so the ingress-reconciler picks up new values..."
kubectl -n "$NAMESPACE" rollout restart deploy/platform-api >/dev/null
kubectl -n "$NAMESPACE" rollout status deploy/platform-api --timeout=180s | tail -2
echo
echo "Verify via:"
echo "  kubectl -n ${NAMESPACE} get ingress platform-ingress -o jsonpath='{.spec.rules[*].host}'"
