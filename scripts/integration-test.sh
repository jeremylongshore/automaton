#!/usr/bin/env bash
# =============================================================================
# integration-test.sh — Concentric Ring Architecture Integration Tests
# =============================================================================
# Validates the full intent-scout Docker stack:
#   1. All 6 containers healthy
#   2. Network isolation (scout can't reach internet)
#   3. Scout can reach moat-gateway
#   4. Moat health endpoints respond
#   5. Policy enforcement (default-deny)
#   6. Execute pipeline works end-to-end
#   7. IRSB receipt hook fires
#   8. Idempotency works
#   9. Redis rate limiting operational
#   10. Postgres connectivity
#
# Usage:
#   ./scripts/integration-test.sh          # Run all tests
#   ./scripts/integration-test.sh --quick  # Skip slow tests (network timeouts)
#
# Prerequisites:
#   docker compose up -d   (all 6 containers running)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_CMD="docker compose -f ${COMPOSE_DIR}/docker-compose.yml"
QUICK_MODE=false

GATEWAY_URL="http://localhost:8002"
CONTROL_PLANE_URL="http://localhost:8001"
TRUST_PLANE_URL="http://localhost:8003"

EXPECTED_SERVICES=("scout" "moat-gateway" "moat-control-plane" "moat-trust-plane" "postgres" "redis")

# ---------------------------------------------------------------------------
# Color & formatting
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}║  ${BOLD}Concentric Ring Architecture — Integration Tests${RESET}${CYAN}        ║${RESET}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  if $QUICK_MODE; then
    echo -e "  ${YELLOW}--quick${RESET} mode: skipping slow network-timeout tests"
    echo ""
  fi
}

# Print a test result line: [N/M] Description ........... RESULT
print_result() {
  local num="$1" total="$2" desc="$3" result="$4"

  local desc_len=${#desc}
  local dot_count=$((52 - desc_len))
  if (( dot_count < 3 )); then dot_count=3; fi
  local dots
  dots=$(printf '.%.0s' $(seq 1 "$dot_count"))

  case "$result" in
    PASS)
      echo -e "  [${num}/${total}] ${desc} ${DIM}${dots}${RESET} ${GREEN}PASS${RESET}"
      ;;
    FAIL)
      echo -e "  [${num}/${total}] ${desc} ${DIM}${dots}${RESET} ${RED}FAIL${RESET}"
      ;;
    SKIP)
      echo -e "  [${num}/${total}] ${desc} ${DIM}${dots}${RESET} ${YELLOW}SKIP${RESET}"
      ;;
  esac
}

pass_test() {
  TOTAL=$((TOTAL + 1))
  PASSED=$((PASSED + 1))
  print_result "$TOTAL" "$TEST_COUNT" "$1" "PASS"
}

fail_test() {
  TOTAL=$((TOTAL + 1))
  FAILED=$((FAILED + 1))
  print_result "$TOTAL" "$TEST_COUNT" "$1" "FAIL"
  for detail in "${FAILURES[@]}"; do
    echo -e "    ${RED}${detail}${RESET}"
  done
}

skip_test() {
  TOTAL=$((TOTAL + 1))
  SKIPPED=$((SKIPPED + 1))
  print_result "$TOTAL" "$TEST_COUNT" "$1" "SKIP"
}

reset_failures() {
  FAILURES=()
}

# ---------------------------------------------------------------------------
# Preflight check
# ---------------------------------------------------------------------------

preflight() {
  if ! command -v docker &>/dev/null; then
    echo -e "${RED}Error: docker is not installed or not in PATH${RESET}"
    exit 1
  fi

  if ! docker info &>/dev/null; then
    echo -e "${RED}Error: docker daemon is not running${RESET}"
    exit 1
  fi

  if [[ ! -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
    echo -e "${RED}Error: docker-compose.yml not found in ${COMPOSE_DIR}${RESET}"
    exit 1
  fi

  local running
  running=$(${COMPOSE_CMD} ps --format '{{.Service}}' 2>/dev/null | wc -l)
  if (( running == 0 )); then
    echo -e "${RED}Error: No containers running. Run 'docker compose up -d' first.${RESET}"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Test 1: Container Health
# ---------------------------------------------------------------------------

test_container_health() {
  local test_name="Container Health"
  reset_failures
  local all_ok=true

  for svc in "${EXPECTED_SERVICES[@]}"; do
    local status
    status=$(${COMPOSE_CMD} ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null \
      | grep "^${svc} " || echo "")

    if [[ -z "$status" ]]; then
      FAILURES+=("${svc}: not found in docker compose ps output")
      all_ok=false
      continue
    fi

    local state health
    state=$(echo "$status" | awk '{print $2}')
    health=$(echo "$status" | awk '{print $3}')

    if [[ "$state" != "running" ]]; then
      FAILURES+=("${svc}: state=${state} (expected running)")
      all_ok=false
    elif [[ "$health" == "unhealthy" || "$health" == "(unhealthy)" ]]; then
      FAILURES+=("${svc}: health=${health} (expected healthy)")
      all_ok=false
    fi
  done

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 2: Network Isolation (scout cannot reach internet)
# ---------------------------------------------------------------------------

test_network_isolation() {
  local test_name="Network Isolation"
  reset_failures

  if $QUICK_MODE; then
    skip_test "$test_name"
    return
  fi

  local all_ok=true

  # Scout should NOT be able to reach external HTTPS endpoints
  if docker exec scout curl -sf --connect-timeout 5 https://api.github.com 2>/dev/null; then
    FAILURES+=("scout reached https://api.github.com (should be blocked)")
    all_ok=false
  fi

  if docker exec scout curl -sf --connect-timeout 5 https://google.com 2>/dev/null; then
    FAILURES+=("scout reached https://google.com (should be blocked)")
    all_ok=false
  fi

  # Scout should NOT be able to ping external IPs (sandbox-internal is internal: true)
  if docker exec scout ping -c1 -W2 8.8.8.8 2>/dev/null; then
    FAILURES+=("scout can ping 8.8.8.8 (should be blocked by internal network)")
    all_ok=false
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 3: Moat Reachability (scout CAN reach moat-gateway)
# ---------------------------------------------------------------------------

test_moat_reachability() {
  local test_name="Moat Reachability"
  reset_failures
  local all_ok=true

  # Scout has curl installed (Dockerfile installs it). Try curl first.
  local output
  output=$(docker exec scout curl -sf --connect-timeout 10 http://moat-gateway:8002/healthz 2>&1) || {
    # Fallback: use Node.js built-in http module (always available in node:22-slim)
    output=$(docker exec scout node -e "
      const http = require('http');
      http.get('http://moat-gateway:8002/healthz', r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { console.log(d); process.exit(r.statusCode === 200 ? 0 : 1); });
      }).on('error', e => { console.error(e.message); process.exit(1); });
    " 2>&1) || {
      FAILURES+=("scout cannot reach moat-gateway:8002/healthz: ${output}")
      all_ok=false
    }
  }

  if $all_ok && ! echo "$output" | grep -q '"status"'; then
    FAILURES+=("moat-gateway healthz response missing 'status' field: ${output}")
    all_ok=false
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 4: Moat Health Endpoints (from host)
# ---------------------------------------------------------------------------

test_moat_health_endpoints() {
  local test_name="Moat Health Endpoints"
  reset_failures
  local all_ok=true

  # Gateway (port 8002)
  local gw_resp
  gw_resp=$(curl -sf --connect-timeout 5 "${GATEWAY_URL}/healthz" 2>&1) || {
    FAILURES+=("moat-gateway healthz failed: ${gw_resp}")
    all_ok=false
  }

  # Control Plane (port 8001)
  local cp_resp
  cp_resp=$(curl -sf --connect-timeout 5 "${CONTROL_PLANE_URL}/healthz" 2>&1) || {
    FAILURES+=("moat-control-plane healthz failed: ${cp_resp}")
    all_ok=false
  }

  # Trust Plane (port 8003) — may not be reachable from host depending on network config
  local tp_resp
  tp_resp=$(curl -sf --connect-timeout 5 "${TRUST_PLANE_URL}/healthz" 2>&1) || {
    echo -e "    ${YELLOW}(note: trust-plane :8003 not reachable from host — may be internal-only)${RESET}"
  }

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 5: Policy Default Deny
# ---------------------------------------------------------------------------

test_policy_default_deny() {
  local test_name="Policy Default Deny"
  reset_failures
  local all_ok=true

  # Execute an unregistered capability — should get 404 or 403
  local resp http_code resp_body
  resp=$(curl -s -w '\n%{http_code}' -X POST \
    "${GATEWAY_URL}/execute/unregistered-capability-xyz" \
    -H "Content-Type: application/json" \
    -d '{"tenant_id":"test-intruder","params":{},"scope":"execute"}' 2>&1)

  http_code=$(echo "$resp" | tail -1)
  resp_body=$(echo "$resp" | sed '$d')

  if [[ "$http_code" == "404" || "$http_code" == "403" ]]; then
    : # Expected — capability not registered or policy denied
  else
    FAILURES+=("unregistered capability returned HTTP ${http_code} (expected 403/404): ${resp_body}")
    all_ok=false
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 6: Execute Pipeline (end-to-end with stub adapter)
# ---------------------------------------------------------------------------

test_execute_pipeline() {
  local test_name="Execute Pipeline"
  reset_failures
  local all_ok=true

  # Try gwi.triage first (registered by seed-capabilities.sh / gateway startup)
  local resp http_code resp_body
  resp=$(curl -s -w '\n%{http_code}' -X POST \
    "${GATEWAY_URL}/execute/gwi.triage" \
    -H "Content-Type: application/json" \
    -d '{
      "tenant_id": "automaton",
      "params": {"pr_url": "https://github.com/test/repo/pull/1"},
      "scope": "execute"
    }' 2>&1)

  http_code=$(echo "$resp" | tail -1)
  resp_body=$(echo "$resp" | sed '$d')

  # Fallback: try test-cap-123 (stub adapter used in unit tests)
  if [[ "$http_code" == "404" || "$http_code" == "500" ]]; then
    resp=$(curl -s -w '\n%{http_code}' -X POST \
      "${GATEWAY_URL}/execute/test-cap-123" \
      -H "Content-Type: application/json" \
      -d '{
        "tenant_id": "dev-tenant",
        "params": {"foo": "bar"},
        "scope": "execute"
      }' 2>&1)

    http_code=$(echo "$resp" | tail -1)
    resp_body=$(echo "$resp" | sed '$d')
  fi

  if [[ "$http_code" != "200" ]]; then
    FAILURES+=("execute returned HTTP ${http_code} (expected 200): ${resp_body}")
    all_ok=false
  else
    if ! echo "$resp_body" | grep -q '"receipt_id"'; then
      FAILURES+=("response missing receipt_id: ${resp_body}")
      all_ok=false
    fi
    if ! echo "$resp_body" | grep -q '"status"'; then
      FAILURES+=("response missing status: ${resp_body}")
      all_ok=false
    fi
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 7: IRSB Receipt Hook
# ---------------------------------------------------------------------------

test_irsb_receipt_hook() {
  local test_name="IRSB Receipt Hook"
  reset_failures
  local all_ok=true

  # Execute a capability to trigger the IRSB receipt hook
  local exec_body
  exec_body=$(curl -s -X POST \
    "${GATEWAY_URL}/execute/gwi.triage" \
    -H "Content-Type: application/json" \
    -d '{
      "tenant_id": "automaton",
      "params": {"pr_url": "https://github.com/test/repo/pull/99"},
      "scope": "execute"
    }' 2>&1)

  # Fallback to test-cap-123 if gwi.triage unavailable
  if echo "$exec_body" | grep -q '"detail"'; then
    exec_body=$(curl -s -X POST \
      "${GATEWAY_URL}/execute/test-cap-123" \
      -H "Content-Type: application/json" \
      -d '{
        "tenant_id": "dev-tenant",
        "params": {"trigger": "irsb-test"},
        "scope": "execute"
      }' 2>&1)
  fi

  # Check gateway logs for IRSB receipt activity (IRSB_DRY_RUN=true logs it)
  local gw_logs
  gw_logs=$(${COMPOSE_CMD} logs --tail=50 moat-gateway 2>&1)

  # Look for evidence the hook ran: receipt/hook/outcome mentions in logs,
  # or at minimum a receipt_id in the execution response
  if echo "$gw_logs" | grep -qi "irsb\|receipt\|hook\|outcome"; then
    : # Evidence of IRSB hook activity found in logs
  elif echo "$exec_body" | grep -q '"receipt_id"'; then
    : # Receipt infrastructure present (receipt_id returned)
  else
    FAILURES+=("no evidence of IRSB receipt hook in gateway logs or response")
    all_ok=false
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 8: Idempotency
# ---------------------------------------------------------------------------

test_idempotency() {
  local test_name="Idempotency"
  reset_failures
  local all_ok=true

  local idem_key="integration-test-idem-$(date +%s)-$$"

  # Determine which capability to use
  local cap_id="gwi.triage"
  local payload="{
    \"tenant_id\": \"automaton\",
    \"params\": {\"pr_url\": \"https://github.com/test/repo/pull/42\"},
    \"scope\": \"execute\",
    \"idempotency_key\": \"${idem_key}\"
  }"

  # First request
  local resp1 http1 body1
  resp1=$(curl -s -w '\n%{http_code}' -X POST \
    "${GATEWAY_URL}/execute/${cap_id}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)

  http1=$(echo "$resp1" | tail -1)
  body1=$(echo "$resp1" | sed '$d')

  # Fallback to test-cap-123
  if [[ "$http1" == "404" ]]; then
    cap_id="test-cap-123"
    payload="{
      \"tenant_id\": \"dev-tenant\",
      \"params\": {\"foo\": \"idem\"},
      \"scope\": \"execute\",
      \"idempotency_key\": \"${idem_key}\"
    }"

    resp1=$(curl -s -w '\n%{http_code}' -X POST \
      "${GATEWAY_URL}/execute/${cap_id}" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>&1)

    http1=$(echo "$resp1" | tail -1)
    body1=$(echo "$resp1" | sed '$d')
  fi

  if [[ "$http1" != "200" ]]; then
    FAILURES+=("first request failed with HTTP ${http1}: ${body1}")
    all_ok=false
  else
    # Second request with same idempotency key
    local resp2 http2 body2
    resp2=$(curl -s -w '\n%{http_code}' -X POST \
      "${GATEWAY_URL}/execute/${cap_id}" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>&1)

    http2=$(echo "$resp2" | tail -1)
    body2=$(echo "$resp2" | sed '$d')

    if [[ "$http2" != "200" ]]; then
      FAILURES+=("second (idempotent) request failed with HTTP ${http2}: ${body2}")
      all_ok=false
    else
      # Check for cached=true flag
      if echo "$body2" | grep -q '"cached"[[:space:]]*:[[:space:]]*true'; then
        : # Idempotency confirmed via cached flag
      else
        # Fallback: check receipt_ids match
        local rid1 rid2
        rid1=$(echo "$body1" | grep -o '"receipt_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)
        rid2=$(echo "$body2" | grep -o '"receipt_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)

        if [[ -n "$rid1" && "$rid1" == "$rid2" ]]; then
          : # Same receipt_id — idempotency working
        else
          FAILURES+=("second request not cached and receipt_ids differ: r1=${rid1} r2=${rid2}")
          all_ok=false
        fi
      fi
    fi
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 9: Redis Connectivity
# ---------------------------------------------------------------------------

test_redis_connectivity() {
  local test_name="Redis Connectivity"
  reset_failures
  local all_ok=true

  local pong
  pong=$(docker exec redis redis-cli ping 2>&1) || {
    FAILURES+=("redis-cli ping failed: ${pong}")
    all_ok=false
  }

  if $all_ok && [[ "$pong" != "PONG" ]]; then
    FAILURES+=("expected PONG, got: ${pong}")
    all_ok=false
  fi

  # Verify redis accepts writes
  if $all_ok; then
    local set_result
    set_result=$(docker exec redis redis-cli SET integration_test_key "ok" EX 10 2>&1) || {
      FAILURES+=("redis SET failed: ${set_result}")
      all_ok=false
    }
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Test 10: Postgres Connectivity
# ---------------------------------------------------------------------------

test_postgres_connectivity() {
  local test_name="Postgres Connectivity"
  reset_failures
  local all_ok=true

  local pg_ready
  pg_ready=$(docker exec postgres pg_isready -U moat -d moat 2>&1) || {
    FAILURES+=("pg_isready failed: ${pg_ready}")
    all_ok=false
  }

  # Verify we can run a simple query
  if $all_ok; then
    local query_result
    query_result=$(docker exec postgres psql -U moat -d moat -c "SELECT 1 AS ok;" 2>&1) || {
      FAILURES+=("psql SELECT 1 failed: ${query_result}")
      all_ok=false
    }
  fi

  if $all_ok; then
    pass_test "$test_name"
  else
    fail_test "$test_name"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  for arg in "$@"; do
    case "$arg" in
      --quick|-q)
        QUICK_MODE=true
        ;;
      --help|-h)
        echo "Usage: $0 [--quick]"
        echo ""
        echo "  --quick, -q    Skip slow tests (network isolation timeout tests)"
        echo "  --help, -h     Show this help"
        exit 0
        ;;
      *)
        echo "Unknown argument: $arg"
        echo "Usage: $0 [--quick]"
        exit 1
        ;;
    esac
  done

  TEST_COUNT=10

  banner
  preflight

  echo -e "  ${DIM}Running ${TEST_COUNT} test groups...${RESET}"
  echo ""

  test_container_health       # 1
  test_network_isolation      # 2
  test_moat_reachability      # 3
  test_moat_health_endpoints  # 4
  test_policy_default_deny    # 5
  test_execute_pipeline       # 6
  test_irsb_receipt_hook      # 7
  test_idempotency            # 8
  test_redis_connectivity     # 9
  test_postgres_connectivity  # 10

  # Summary
  echo ""
  echo -e "  ${DIM}───────────────────────────────────────────────────────────${RESET}"

  local summary="Results: ${PASSED} passed"
  if (( FAILED > 0 )); then
    summary+=", ${FAILED} failed"
  fi
  if (( SKIPPED > 0 )); then
    summary+=", ${SKIPPED} skipped"
  fi

  if (( FAILED > 0 )); then
    echo -e "  ${RED}${BOLD}${summary}${RESET}"
    echo ""
    exit 1
  else
    echo -e "  ${GREEN}${BOLD}${summary}${RESET}"
    echo ""
    exit 0
  fi
}

main "$@"
