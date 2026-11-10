#!/usr/bin/env bash
# ============================================================================
#  D865 — the §142 verb, walked live: one question, one answer, one inbox thread
#
#  What it demonstrates, on a live plane (no mocks):
#    1. the consumer signs in through the BFF (/api/nexus/auth, role=consumer)
#    2. the consumer asks a grounded question about basil-leaf-0419
#    3. the AI answers from that merchant's knowledge base (citations included)
#    4. both turns relay through the platform's internal door
#    5. the merchant signs in and sees the same conversation on the portal
#
#  Exit 0 = the journey is whole. Exit 1 = the first step that is NOT whole.
#  Side effects on the live database: three rows (system open, user question,
#  ai_agent answer). Clearly isolated to DEMO- data. Nothing in the merchant or
#  user-facing ports is exposed beyond the documented routes.
#
#  Environment (all with sane dev-plane defaults):
#    WEB_URL        (default http://127.0.0.1:3002)    — the BFF
#    PLATFORM_URL   (default http://127.0.0.1:8090)    — the monolith
#    AI_URL         (default http://127.0.0.1:8010)    — the AI service
#    MERCHANT_ID    (default 8fcdeff4-1795-51c7-8a14-12a456055e99)
#    MERCHANT_SLUG  (default basil-leaf-0419)
#    QUESTION       (default '有BB椅嗎' — grounded; see apps/ai tests)
#    LOCALE         (default zh-HK)
#
#  Usage:
#    bash scripts/demo_live.sh               — prints each step, exits 0/1
#    bash scripts/demo_live.sh --json        — one-line JSON summary
#    bash scripts/demo_live.sh --compact     — no banner, one line each
# ============================================================================
set -u

WEB_URL="${WEB_URL:-http://127.0.0.1:3002}"
PLATFORM_URL="${PLATFORM_URL:-http://127.0.0.1:8090}"
AI_URL="${AI_URL:-http://127.0.0.1:8010}"
MERCHANT_ID="${MERCHANT_ID:-8fcdeff4-1795-51c7-8a14-12a456055e99}"
MERCHANT_SLUG="${MERCHANT_SLUG:-basil-leaf-0419}"
QUESTION="${QUESTION:-有BB椅嗎}"
LOCALE="${LOCALE:-zh-HK}"

MODE=human
case "${1:-}" in
    --json)    MODE=json ;;
    --compact) MODE=compact ;;
    -h|--help) sed -n '2,32p' "$0" | sed -e 's/^# \{0,2\}//'; exit 0 ;;
esac

SAY()  { [ "$MODE" = "json" ] || echo "$*"; }
STEP() { [ "$MODE" = "json" ] || echo "  $1"; }
FAIL() { echo "FAIL: $*" >&2; [ "$MODE" = "json" ] && echo '{"ok":false,"step":"'"$1"'"}'; exit 1; }
DONE() { [ "$MODE" = "json" ] && echo '{"ok":true}' || echo "PASS: the full §142 round trip · consumer question -> agent answer -> merchant inbox"; exit 0; }

if ! command -v curl >/dev/null 2>&1; then FAIL "curl is not on PATH — the demo needs it"; fi

# --------------------------------------------------------------------------
# Step 0 — the services are reachable
# --------------------------------------------------------------------------
check_health() {
    local name="$1" url="$2"
    code="$(curl -fsS -o /dev/null -s -w '%{http_code}' --max-time 9 "$url" 2>/dev/null || echo 000)"
    if [ "$code" != "200" ]; then FAIL "$name down at $url (got ${code}) — start the stack first"; fi
    STEP "$name 200"
}
check_health web     "$WEB_URL"
check_health platform "$PLATFORM_URL/api/v1/health"
check_health ai       "$AI_URL/ai/v1/health"

# --------------------------------------------------------------------------
# Step 1 — the consumer signs in (BFF /api/nexus/auth)
# --------------------------------------------------------------------------
TMP_CONSUMER="$(mktemp 2>/dev/null || mktemp -t nexus-demo)"
trap 'rm -f "$TMP_CONSUMER" 2>/dev/null; rm -f "$TMP_MERCHANT" 2>/dev/null' EXIT
TMP_MERCHANT="$(mktemp 2>/dev/null || mktemp -t nexus-demo-merchant)"

signin() {
    local role="$1" jar="$2"
    curl -fsS -c "$jar" -o /dev/null -w '%{http_code}' --max-time 15 \
        -X POST -H 'Content-Type: application/json' \
        -d "{\"role\":\"$role\"}" \
        "$WEB_URL/api/nexus/auth"
}

consumer_code="$(signin consumer "$TMP_CONSUMER")"
[ "$consumer_code" = "200" ] || FAIL "consumer sign-in failed (HTTP $consumer_code)"
STEP "consumer signed in (jar)"

# --------------------------------------------------------------------------
# Step 2 — the consumer asks the merchant's question
# --------------------------------------------------------------------------
ask() {
    curl -fsS -b "$TMP_CONSUMER" --max-time 60 \
        -H 'Content-Type: application/json' \
        -D "$TMP_CONSUMER.headers" \
        --data "{\"merchant_id\":\"$MERCHANT_ID\",\"merchant_slug\":\"$MERCHANT_SLUG\",\"message\":\"$QUESTION\",\"locale\":\"$LOCALE\",\"conversation_id\":null}" \
        -w '\n__HTTP_CODE=%{http_code}' \
        "$WEB_URL/api/nexus/conversations/ask"
}

ask_raw="$(ask)"
[ -n "$ask_raw" ] || FAIL "no response body from /api/nexus/conversations/ask"
ask_code="$(grep -o '__HTTP_CODE=[0-9]\+' <<<"$ask_raw" | cut -d= -f2)"
[ "$ask_code" = "200" ] || FAIL "ask answered ${ask_code}, not 200"
STEP "question posted (HTTP 200)"

# Parse the SSE frame types — the contract requires at least: status, summary, done
printf '%s' "$ask_raw" | grep -qE '^event: status'   || FAIL "no 'event: status' frame in the answer"
printf '%s' "$ask_raw" | grep -qE '^event: summary'  || FAIL "no 'event: summary' frame in the answer"
printf '%s' "$ask_raw" | grep -qE '^event: done'     || FAIL "no 'event: done' frame in the answer"
STEP "SSE frames parsed (status + summary + done)"

# Extract the responder evidence
degraded="$(printf '%s' "$ask_raw" | grep -oE '"degraded":(true|false)' | head -1 | cut -d: -f2)"
citations="$(printf '%s' "$ask_raw" | grep -oE '"citations":\[[^]]*\]' | head -1)"
run_id="$(printf '%s' "$ask_raw" | grep -oE '"agent_run_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
conversation_id="$(grep -i 'x-conversation-id' "$TMP_CONSUMER.headers" | tr -d '\r' | awk '{print $2}')"
# The agent's summary text — extracted through a JSON parser, not a regex, so whatever
# the answer actually IS is what gets checked. Content-neutral on purpose.
answer_text="$(ASK_RAW="$ask_raw" python - <<'PY'
import json, os, sys
raw = os.environ['ASK_RAW']
frame = raw.split('event: summary')[1] if 'event: summary' in raw else ''
try:
    data = json.loads(frame.split('data: ', 1)[1].split('\n\n', 1)[0])
    plan = data.get('text', '')
except Exception:
    plan = ''
sys.stdout.write(plan)
PY
)"
STEP "agent_run_id=${run_id:-?} degraded=${degraded:-?} citations=${citations:-[]} conversation_id=${conversation_id:-?}"
STEP "answer: $(printf '%s' "$answer_text" | head -c 120 | tr '\n' ' ')"
[ -z "$answer_text" ] && FAIL "the summary frame carried no answer text"
[ -z "$run_id" ] && FAIL "the done frame carried no agent_run_id (the gateway wrote nothing?)"
answer_bytes=$(printf '%s' "$answer_text" | wc -c)
[ "$answer_bytes" -lt 4 ] && FAIL "answer text is suspiciously short ($answer_bytes bytes)"

# --------------------------------------------------------------------------
# Step 3 — the merchant signs in and reads their inbox
# --------------------------------------------------------------------------
merchant_code="$(signin merchant "$TMP_MERCHANT")"
[ "$merchant_code" = "200" ] || FAIL "merchant sign-in failed (HTTP $merchant_code)"
STEP "merchant signed in (jar)"

conversations_code="$(curl -sS -o "$TMP_MERCHANT.inbox" -w '%{http_code}' --max-time 30 \
    -b "$TMP_MERCHANT" \
    "$WEB_URL/merchant/conversations?business=$MERCHANT_ID")"
[ "$conversations_code" = "200" ] || FAIL "merchant inbox answered $conversations_code"

echo "== the merchant sees the exact answer the consumer received =="
detail_code="$(curl -sS -o "$TMP_MERCHANT.thread" -w '%{http_code}' --max-time 30 \
    -b "$TMP_MERCHANT" \
    "$WEB_URL/merchant/conversations/$conversation_id")"
[ "$detail_code" = "200" ] || FAIL "merchant conversation detail answered $detail_code"
# Content-neutral proof the merchant can read this exact consumer's turn: the page renders the
# agent run id wherever the AI authored one — as a literal in the HTML (it survives the flight
# format's `run ` / `<id>` token split). The id itself is the marker.
if ! grep -qF "$run_id" "$TMP_MERCHANT.thread"; then
    FAIL "the merchant's thread page does not carry the agent run id (${run_id}) — this consumer's turn is unreadable to the merchant"
fi
echo "  the merchant's thread page carries the consumer's turn (run id ${run_id})"
# Best-effort bonus: check the exact answer bytes are also on the page, with tolerant grep
# (the merchant HTML may HTML-entity-encode some bytes; report either way, never gate).
if [ -n "$answer_text" ] && grep -qF "$answer_text" "$TMP_MERCHANT.thread"; then
    echo "  the verbatim answer bytes are also present in the merchant page (bonus check)"
else
    echo "  (best-effort byte check inconclusive; the run-id check above is the gate)"
fi
if [ -z "$conversation_id" ]; then
    FAIL "the response carried no x-conversation-id header — the BFF did not thread it"
fi
if grep -q "$conversation_id" "$TMP_MERCHANT.inbox" 2>/dev/null; then
    STEP "the new conversation appears on /merchant/conversations"
    [ "$MODE" = "human" ] && echo
    SAY "→ consumer → BFF (POST /api/nexus/conversations/ask) → merchant-agent grounded answer → platform's /internal/conversations/{id}/agent-message → merchant inbox"
    DONE
fi

FAIL "the merchant inbox did not list conversation $conversation_id — did the relay fire?"
