#!/usr/bin/env bash
# Simple API benchmark using curl (works without k6)
set -u

BASE_URL="${BASE_URL:-http://dind.local:2012}"
ITERATIONS="${ITERATIONS:-50}"

echo "=== K8s Hosting Platform API Benchmark ==="
echo "Target: $BASE_URL"
echo "Iterations: $ITERATIONS per endpoint"
echo ""

# Login helper — returns a fresh JWT token
get_token() {
  local response
  response=$(curl -s "$BASE_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@k8s-platform.local-dev","password":"admin"}')

  if command -v jq &>/dev/null; then
    echo "$response" | jq -r '.data.token // empty'
  else
    echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true
  fi
}

TOKEN=$(get_token)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to authenticate"
  exit 1
fi
echo "Authenticated successfully."
echo ""

benchmark_endpoint() {
  local name="$1"
  local path="$2"
  local method="${3:-GET}"
  local total=0
  local min=999999
  local max=0
  local errors=0
  local p95_values=()

  # Refresh token before each endpoint to avoid expiry
  TOKEN=$(get_token)
  local auth_header="Authorization: Bearer $TOKEN"

  for i in $(seq 1 "$ITERATIONS"); do
    local start end duration status
    start=$(date +%s%N)
    if [ "$method" = "POST" ]; then
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL$path" \
        -H 'Content-Type: application/json' \
        -d '{"email":"admin@k8s-platform.local-dev","password":"admin"}')
    else
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL$path" \
        -H "$auth_header")
    fi
    end=$(date +%s%N)
    duration=$(( (end - start) / 1000000 ))

    if [ "$status" != "200" ]; then
      errors=$((errors + 1))
    fi

    total=$((total + duration))
    p95_values+=("$duration")
    if [ "$duration" -lt "$min" ]; then min=$duration; fi
    if [ "$duration" -gt "$max" ]; then max=$duration; fi
  done

  local avg=$((total / ITERATIONS))

  # Calculate p95 (sort values, take 95th percentile)
  local sorted
  sorted=$(printf '%s\n' "${p95_values[@]}" | sort -n)
  local p95_index=$(( (ITERATIONS * 95 + 99) / 100 ))
  local p95
  p95=$(echo "$sorted" | sed -n "${p95_index}p")

  printf "  %-25s avg: %4dms  p95: %4dms  min: %4dms  max: %4dms  errors: %d/%d\n" \
    "$name" "$avg" "$p95" "$min" "$max" "$errors" "$ITERATIONS"
}

echo "Benchmarking endpoints ($ITERATIONS iterations each):"
echo ""

benchmark_endpoint "GET /admin/status"      "/api/v1/admin/status"
benchmark_endpoint "GET /admin/dashboard"   "/api/v1/admin/dashboard"
benchmark_endpoint "GET /clients"           "/api/v1/clients?limit=20"
benchmark_endpoint "GET /plans (cached)"    "/api/v1/plans"
benchmark_endpoint "GET /regions (cached)"  "/api/v1/regions"
benchmark_endpoint "GET /images (cached)"   "/api/v1/container-images"
benchmark_endpoint "GET /audit-logs"        "/api/v1/admin/audit-logs?limit=10"
benchmark_endpoint "GET /admin/domains"     "/api/v1/admin/domains?limit=20"
benchmark_endpoint "POST /auth/login"       "/api/v1/auth/login" "POST"

echo ""
echo "Benchmark complete."
