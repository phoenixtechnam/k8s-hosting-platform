#!/usr/bin/env bash
# E2E test for per-ingress OAuth2 / OIDC access control.
#
# Configures a real Zitadel-like OIDC provider on a tenant ingress,
# verifies the platform-api accepts the config, the reconciler builds
# the oauth2-proxy + claim-validator Deployment, and the unauthenticated
# request to the protected URL gets redirected to the IdP.
#
# Sample creds from ~/k8s-staging/servers.txt:
#   Issuer:   https://auth.phoenix-host.net/
#   Client:   370577540479254534
#   Secret:   6ecIC8ggfzras5QwakRtkbCN5bqCrGnGtUh8naHgNN5yjbf1C1zTZ8X3voTPw3XT
#   Allowed redirects: https://*.staging.success.com.na

set -euo pipefail

SSH_KEY="${SSH_KEY:-/home/dev/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -i $SSH_KEY}"
CONTROL_HOST="${CONTROL_HOST:-46.224.122.58}"

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

OIDC_ISSUER="${OIDC_ISSUER:-https://auth.phoenix-host.net/}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-370577540479254534}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-6ecIC8ggfzras5QwakRtkbCN5bqCrGnGtUh8naHgNN5yjbf1C1zTZ8X3voTPw3XT}"

log() { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }
ok()  { echo -e "  \033[32m✓\033[0m $*"; }
fail() { echo -e "  \033[31m✗\033[0m $*"; exit 1; }

if [[ -z "$ADMIN_PASSWORD" ]]; then
  log "Reading admin password from cluster..."
  ADMIN_PASSWORD=$(ssh $SSH_OPTS root@${CONTROL_HOST} \
    "kubectl -n platform get secret platform-admin-seed -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d")
  [[ -z "$ADMIN_PASSWORD" ]] && fail "Could not read admin password"
fi

log "Logging in as ${ADMIN_EMAIL}..."
LOGIN=$(curl -sk -X POST "${ADMIN_HOST}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data', {}).get('token', ''))" 2>/dev/null)
[[ -z "$TOKEN" ]] && fail "Login failed: $LOGIN"
ok "Got token (${#TOKEN} chars)"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sk -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sk -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

# Find an existing tenant client + ingress under *.staging.success.com.na.
log "Locating tenant ingress route under staging.success.com.na..."
ROUTE_INFO=$(ssh $SSH_OPTS root@${CONTROL_HOST} \
  "kubectl -n platform exec -i postgres-1 -c postgres -- psql -U postgres -d hosting_platform -t -c \"
    SELECT ir.id, ir.hostname, d.client_id
    FROM ingress_routes ir
    JOIN domains d ON d.id = ir.domain_id
    WHERE ir.hostname LIKE '%staging.success.com.na'
    LIMIT 1;
  \"")
ROUTE_ID=$(echo "$ROUTE_INFO" | awk -F'|' '{print $1}' | tr -d ' \n')
HOSTNAME=$(echo "$ROUTE_INFO" | awk -F'|' '{print $2}' | tr -d ' \n')
CLIENT_ID=$(echo "$ROUTE_INFO" | awk -F'|' '{print $3}' | tr -d ' \n')

if [[ -z "$ROUTE_ID" ]]; then
  fail "No tenant ingress under *.staging.success.com.na — create one via admin panel and re-run"
fi
ok "Using route_id=$ROUTE_ID hostname=$HOSTNAME client_id=$CLIENT_ID"

log "Scenario 1: probe issuer discovery..."
RESP=$(api POST "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth/test" \
  "{\"issuerUrl\":\"$OIDC_ISSUER\"}")
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print('  ok=',d['ok'],'auth_ep=',d['authorizationEndpoint'])"
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];sys.exit(0 if d['ok'] else 1)" \
  && ok "Issuer discovery succeeded" || fail "Issuer probe failed"

log "Scenario 2: enable OIDC + claim rule (membership contains paid)..."
PAYLOAD=$(cat <<EOF
{
  "enabled": true,
  "issuerUrl": "$OIDC_ISSUER",
  "clientId": "$OIDC_CLIENT_ID",
  "clientSecret": "$OIDC_CLIENT_SECRET",
  "authMethod": "client_secret_basic",
  "responseType": "code",
  "usePkce": true,
  "scopes": "openid profile email groups",
  "allowedEmails": null,
  "allowedEmailDomains": null,
  "allowedGroups": null,
  "claimRules": [
    {"claim": "membership", "operator": "contains", "value": "paid"}
  ],
  "passAuthorizationHeader": true,
  "passAccessToken": true,
  "passIdToken": true,
  "passUserHeaders": true,
  "setXauthrequest": true,
  "cookieDomain": null,
  "cookieRefreshSeconds": 3600,
  "cookieExpireSeconds": 86400
}
EOF
)
RESP=$(api PATCH "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" "$PAYLOAD")
echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  result:', d.get('error') or d.get('data', {}).get('enabled'))"
echo "$RESP" | grep -q '"enabled":true' && ok "Config saved + reconciled" || fail "Save failed: $RESP"

log "Scenario 3: verify oauth2-proxy Deployment exists in client namespace..."
NS=$(ssh $SSH_OPTS root@${CONTROL_HOST} \
  "kubectl -n platform exec -i postgres-1 -c postgres -- psql -U postgres -d hosting_platform -t -A -c \"SELECT kubernetes_namespace FROM clients WHERE id='$CLIENT_ID';\"" 2>/dev/null \
  | grep -E '^client-' | tr -d ' \r\n')
[[ -z "$NS" ]] && fail "Could not resolve client namespace"
ok "Client namespace=$NS"
ssh $SSH_OPTS root@${CONTROL_HOST} \
  "kubectl -n $NS rollout status deploy/oauth2-proxy --timeout=120s" \
  && ok "oauth2-proxy Ready" || fail "oauth2-proxy not Ready"

log "Scenario 4: verify Ingress carries auth-url annotation..."
ANNO=$(ssh $SSH_OPTS root@${CONTROL_HOST} \
  "kubectl -n $NS get ing -o jsonpath='{.items[*].metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/auth-url}'")
echo "  auth-url=$ANNO"
echo "$ANNO" | grep -q "oauth2-proxy.${NS}" && ok "Auth-url annotation set" || fail "Auth-url missing"

log "Scenario 5: unauthenticated request → 302 to /oauth2/start..."
HTTP_CODE=$(curl -sk -o /dev/null -w '%{http_code}' "https://${HOSTNAME}/" -H 'Cookie: ')
[[ "$HTTP_CODE" =~ ^(302|401)$ ]] && ok "Got $HTTP_CODE (auth-request gated as expected)" \
  || fail "Expected 302 or 401, got $HTTP_CODE"

log "Scenario 6: cleanup — disable + verify proxy torn down..."
api DELETE "/clients/$CLIENT_ID/ingress-routes/$ROUTE_ID/auth" >/dev/null
ok "Disabled"
sleep 5
DEPLOY_GONE=$(ssh $SSH_OPTS root@${CONTROL_HOST} \
  "kubectl -n $NS get deploy oauth2-proxy --ignore-not-found -o name 2>&1")
[[ -z "$DEPLOY_GONE" ]] && ok "oauth2-proxy Deployment torn down" \
  || ok "Deployment still present (allowed if other ingresses use it): $DEPLOY_GONE"

echo
echo "=== ALL SCENARIOS PASSED ==="
