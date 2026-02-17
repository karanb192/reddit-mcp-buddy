#!/usr/bin/env bash
#
# Integration tests for reddit-mcp-buddy
# Tests HTTP server, live Reddit API (all 5 tools), edge cases, and stdio transport.
#
# WARNING: Hits live Reddit API. Anonymous mode = 10 req/min.
# Takes ~15 minutes due to rate limit pauses.
#
# Usage: ./tests/test-integration.sh
#

set -uo pipefail

# ── Globals ──────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0
TOTAL=0
FAILURES=()
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTTP_PORT=9876
SERVER_PID=""
API_CALLS=0
API_CALLS_SINCE_WAIT=0
MAX_API_CALLS_BEFORE_WAIT=3
WAIT_SECONDS=65

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'
# ── Helpers ──────────────────────────────────────────────────────────────────

log_section() {
  echo ""
  echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  $1${NC}"
  echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
}

log_subsection() {
  echo ""
  echo -e "${BOLD}── $1 ──${NC}"
}

assert() {
  local description="$1"
  local condition="$2"
  TOTAL=$((TOTAL + 1))

  if eval "$condition" > /dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✓${NC} $description"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$description")
    echo -e "  ${RED}✗${NC} $description"
  fi
}

assert_contains() {
  local description="$1"
  local haystack="$2"
  local needle="$3"
  TOTAL=$((TOTAL + 1))

  if echo "$haystack" | grep -q "$needle" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✓${NC} $description"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$description (expected to contain: '$needle')")
    echo -e "  ${RED}✗${NC} $description"
  fi
}

assert_not_contains() {
  local description="$1"
  local haystack="$2"
  local needle="$3"
  TOTAL=$((TOTAL + 1))

  if ! echo "$haystack" | grep -q "$needle" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✓${NC} $description"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$description (should NOT contain: '$needle')")
    echo -e "  ${RED}✗${NC} $description"
  fi
}

assert_json_field() {
  local description="$1"
  local json="$2"
  local field="$3"
  local expected="$4"
  TOTAL=$((TOTAL + 1))

  local actual
  actual=$(echo "$json" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const o=JSON.parse(d); const v=$field; process.stdout.write(String(v)); }
      catch(e) { process.stdout.write('__PARSE_ERROR__'); }
    });
  " 2>/dev/null)

  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}✓${NC} $description"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$description (expected '$expected', got '$actual')")
    echo -e "  ${RED}✗${NC} $description [expected '$expected', got '$actual']"
  fi
}

skip_test() {
  local description="$1"
  local reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  echo -e "  ${YELLOW}⊘${NC} $description (skipped: $reason)"
}

# Rate limit aware wait
rate_limit_guard() {
  API_CALLS=$((API_CALLS + 1))
  API_CALLS_SINCE_WAIT=$((API_CALLS_SINCE_WAIT + 1))

  if [ "$API_CALLS_SINCE_WAIT" -ge "$MAX_API_CALLS_BEFORE_WAIT" ]; then
    echo ""
    echo -e "  ${YELLOW}⏳ Rate limit guard: made $API_CALLS_SINCE_WAIT API calls, waiting ${WAIT_SECONDS}s for rate limit window to reset...${NC}"
    sleep "$WAIT_SECONDS"
    API_CALLS_SINCE_WAIT=0
    # Re-initialize MCP session after long wait (stateless mode may lose context)
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
      init_mcp_session 2>/dev/null || true
    fi
    echo -e "  ${GREEN}✓${NC} Rate limit window reset, continuing..."
  fi
}

# Count extra API calls for tools that make multiple internal requests
rate_limit_guard_double() {
  rate_limit_guard
  API_CALLS=$((API_CALLS + 1))
  API_CALLS_SINCE_WAIT=$((API_CALLS_SINCE_WAIT + 1))
}

# Send JSON-RPC request to HTTP server (handles SSE response format)
send_mcp_request() {
  local method="$1"
  local params="$2"
  local id="${3:-1}"

  local raw
  raw=$(curl -s -X POST "http://localhost:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":${id},\"method\":\"${method}\",\"params\":${params}}")

  # Extract JSON from SSE response. SSE multi-line data uses multiple "data:" lines
  # that should be concatenated. Strip "data: " prefix from all data lines, join them.
  local sse_data
  sse_data=$(echo "$raw" | sed -n 's/^data: \{0,1\}//p' | tr -d '\n')
  if [ -n "$sse_data" ]; then
    echo "$sse_data"
  else
    echo "$raw"
  fi
}

# Send JSON-RPC notification (no id, no response expected)
send_mcp_notification() {
  local method="$1"
  local params="${2:-{}}"

  curl -s -X POST "http://localhost:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":${params}}" > /dev/null 2>&1
}

# Initialize MCP session (required before tools/list or tools/call)
init_mcp_session() {
  send_mcp_request "initialize" '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-script","version":"1.0"}}' > /dev/null 2>&1
  send_mcp_notification "notifications/initialized"
}

# Call a tool and extract the text content from the MCP response
call_tool() {
  local tool_name="$1"
  local args="$2"

  local raw
  raw=$(send_mcp_request "tools/call" "{\"name\":\"${tool_name}\",\"arguments\":${args}}")

  # Extract the text field from content[0].text, then parse inner JSON if present
  echo "$raw" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const r=JSON.parse(d);
        if (r.error) { console.log(JSON.stringify({_error: r.error.message || JSON.stringify(r.error)})); return; }
        const text = r.result?.content?.[0]?.text || r.content?.[0]?.text || '';
        try { const inner=JSON.parse(text); console.log(JSON.stringify(inner)); }
        catch(e) { console.log(JSON.stringify({_raw: text})); }
      } catch(e) { console.log(JSON.stringify({_parse_error: e.message, _raw_data: d.substring(0,500)})); }
    });
  " 2>/dev/null
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT: Ensure build exists
# ═══════════════════════════════════════════════════════════════════════════════

cd "$PROJECT_DIR"

if [ ! -f dist/index.js ]; then
  echo -e "${RED}ERROR: dist/index.js not found. Run 'npm run build' first.${NC}"
  exit 1
fi

PKG_VERSION=$(node -p "require('./package.json').version")
echo -e "${BOLD}Testing reddit-mcp-buddy v${PKG_VERSION}${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: HTTP SERVER TESTS
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 3: HTTP Server Integration Tests"

log_subsection "3a. Server Startup"

# Check port availability
if lsof -i ":${HTTP_PORT}" > /dev/null 2>&1; then
  echo -e "  ${RED}ERROR: Port ${HTTP_PORT} is already in use. Cannot start test server.${NC}"
  echo -e "  ${RED}Run: lsof -ti:${HTTP_PORT} | xargs kill -9${NC}"
  exit 1
fi

# Start HTTP server in background
REDDIT_BUDDY_HTTP=true REDDIT_BUDDY_PORT=$HTTP_PORT node dist/index.js &
SERVER_PID=$!

# Wait for server to be ready
echo -e "  ${YELLOW}Starting HTTP server on port ${HTTP_PORT}...${NC}"
for i in $(seq 1 15); do
  if curl -s "http://localhost:${HTTP_PORT}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

HEALTH_RESPONSE=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null || echo '{}')
assert "Server starts and responds to /health" "echo '$HEALTH_RESPONSE' | grep -q 'ok'"

# Initialize MCP session (required by protocol before tools/list or tools/call)
init_mcp_session
assert_json_field "Health: server name" "$HEALTH_RESPONSE" "o.server" "reddit-mcp-buddy"
assert_json_field "Health: version matches" "$HEALTH_RESPONSE" "o.version" "$PKG_VERSION"
assert_json_field "Health: protocol is MCP" "$HEALTH_RESPONSE" "o.protocol" "MCP"
assert_json_field "Health: transport is streamable-http" "$HEALTH_RESPONSE" "o.transport" "streamable-http"

# --------------------------------------------------------------------------
# 3b. Root & 404 Endpoints
# --------------------------------------------------------------------------
log_subsection "3b. HTTP Endpoints"

ROOT_RESPONSE=$(curl -s "http://localhost:${HTTP_PORT}/" 2>/dev/null)
assert "Root / returns server info" "echo '$ROOT_RESPONSE' | grep -q 'Reddit MCP Buddy'"

NOT_FOUND_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HTTP_PORT}/nonexistent" 2>/dev/null)
assert "Unknown endpoint returns 404" "[ '$NOT_FOUND_CODE' = '404' ]"

# --------------------------------------------------------------------------
# 3c. CORS Headers (EXISTING)
# --------------------------------------------------------------------------
log_subsection "3c. CORS Headers"

CORS_HEADERS=$(curl -s -I -X OPTIONS "http://localhost:${HTTP_PORT}/mcp" 2>/dev/null)
assert_contains "CORS: Access-Control-Allow-Origin present" "$CORS_HEADERS" "Access-Control-Allow-Origin"
assert_contains "CORS: Allows POST method" "$CORS_HEADERS" "POST"
assert_contains "CORS: Exposes MCP-Session-Id" "$CORS_HEADERS" "MCP-Session-Id"

# --------------------------------------------------------------------------
# 3d. MCP Protocol: tools/list
# --------------------------------------------------------------------------
log_subsection "3d. MCP Protocol: tools/list"

TOOLS_LIST=$(send_mcp_request "tools/list" "{}")

# Check all 5 tools present
for TOOL_NAME in browse_subreddit search_reddit get_post_details user_analysis reddit_explain; do
  assert_contains "tools/list contains $TOOL_NAME" "$TOOLS_LIST" "$TOOL_NAME"
done

# Check readOnlyHint is set (NEW in v1.1.12)
READONLY_COUNT=$(echo "$TOOLS_LIST" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const tools=r.result?.tools||[];
    const count=tools.filter(t=>t.readOnlyHint===true).length;
    console.log(count);
  });
" 2>/dev/null)
assert "All 5 tools have readOnlyHint=true (NEW)" "[ '$READONLY_COUNT' = '5' ]"

# Check schemas have proper structure (NEW zodSchemaToMCPInputSchema)
SCHEMA_CHECK=$(echo "$TOOLS_LIST" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    const tools=r.result?.tools||[];
    const allHaveSchema = tools.every(t =>
      t.inputSchema &&
      t.inputSchema.type === 'object' &&
      t.inputSchema.properties
    );
    console.log(allHaveSchema ? 'pass' : 'fail');
  });
" 2>/dev/null)
assert "All tool schemas have type=object with properties (NEW conversion)" "[ '$SCHEMA_CHECK' = 'pass' ]"

# --------------------------------------------------------------------------
# 3e. Invalid JSON-RPC requests
# --------------------------------------------------------------------------
log_subsection "3e. Error Handling"

# Invalid JSON
INVALID_JSON_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:${HTTP_PORT}/mcp" \
  -H "Content-Type: application/json" -d "not json at all" 2>/dev/null)
assert "Invalid JSON returns 400" "[ '$INVALID_JSON_CODE' = '400' ]"

# Unknown tool
UNKNOWN_TOOL=$(call_tool "nonexistent_tool" '{}')
assert_contains "Unknown tool returns error" "$UNKNOWN_TOOL" "Unknown tool"

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: MCP TOOL INTEGRATION TESTS (Hits Reddit API)
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 4: MCP Tool Integration Tests (Live Reddit API)"
echo -e "  ${YELLOW}Note: Anonymous mode = 10 req/min. Script will pause between batches.${NC}"

# --------------------------------------------------------------------------
# 4a. browse_subreddit
# --------------------------------------------------------------------------
log_subsection "4a. browse_subreddit"

# Test 1: Default hot sort
rate_limit_guard
BROWSE_HOT=$(call_tool "browse_subreddit" '{"subreddit":"technology","limit":3}')
assert_contains "browse_subreddit: returns posts array" "$BROWSE_HOT" '"posts"'
assert_contains "browse_subreddit: posts have id field" "$BROWSE_HOT" '"id"'
assert_contains "browse_subreddit: posts have title field" "$BROWSE_HOT" '"title"'
assert_contains "browse_subreddit: posts have score field" "$BROWSE_HOT" '"score"'
assert_contains "browse_subreddit: posts have permalink field" "$BROWSE_HOT" '"permalink"'
assert_contains "browse_subreddit: posts have subreddit field" "$BROWSE_HOT" '"subreddit"'
assert_contains "browse_subreddit: total_posts field present" "$BROWSE_HOT" '"total_posts"'

# Test 2: Top with time range
rate_limit_guard
BROWSE_TOP=$(call_tool "browse_subreddit" '{"subreddit":"science","sort":"top","time":"month","limit":2}')
assert_contains "browse_subreddit top/month: returns posts" "$BROWSE_TOP" '"posts"'

# Test 3: Special subreddit "all" with rising
rate_limit_guard
BROWSE_ALL=$(call_tool "browse_subreddit" '{"subreddit":"all","sort":"rising","limit":2}')
assert_contains "browse_subreddit r/all rising: works" "$BROWSE_ALL" '"posts"'

# Test 4: NSFW filtering (default=false)
assert_not_contains "browse_subreddit: NSFW filtered out by default" "$BROWSE_HOT" '"nsfw":true'

# Test 5: Include subreddit info
rate_limit_guard_double  # subreddit_info makes 2 internal API calls
BROWSE_INFO=$(call_tool "browse_subreddit" '{"subreddit":"programming","limit":1,"include_subreddit_info":true}')
assert_contains "browse_subreddit: subreddit_info present" "$BROWSE_INFO" '"subreddit_info"'
assert_contains "browse_subreddit: subreddit_info has subscribers" "$BROWSE_INFO" '"subscribers"'

# Test 6: r/ prefix stripping
rate_limit_guard
BROWSE_PREFIX=$(call_tool "browse_subreddit" '{"subreddit":"r/AskReddit","limit":1}')
assert_contains "browse_subreddit: r/ prefix stripped correctly" "$BROWSE_PREFIX" '"posts"'

# Test 7: controversial sort
rate_limit_guard
BROWSE_CONTROVERSIAL=$(call_tool "browse_subreddit" '{"subreddit":"AskReddit","sort":"controversial","time":"week","limit":2}')
assert_contains "browse_subreddit controversial sort: returns posts" "$BROWSE_CONTROVERSIAL" '"posts"'

# Test 8: new sort
rate_limit_guard
BROWSE_NEW=$(call_tool "browse_subreddit" '{"subreddit":"technology","sort":"new","limit":2}')
assert_contains "browse_subreddit new sort: returns posts" "$BROWSE_NEW" '"posts"'

# Test 9: special subreddit "popular"
rate_limit_guard
BROWSE_POPULAR=$(call_tool "browse_subreddit" '{"subreddit":"popular","limit":2}')
assert_contains "browse_subreddit r/popular: works" "$BROWSE_POPULAR" '"posts"'

# --------------------------------------------------------------------------
# 4b. search_reddit
# --------------------------------------------------------------------------
log_subsection "4b. search_reddit"

rate_limit_guard
SEARCH_GLOBAL=$(call_tool "search_reddit" '{"query":"artificial intelligence","sort":"top","time":"week","limit":3}')
assert_contains "search_reddit global: returns results" "$SEARCH_GLOBAL" '"results"'
assert_contains "search_reddit global: has total_results" "$SEARCH_GLOBAL" '"total_results"'

# Multi-subreddit search with Promise.allSettled (NEW)
rate_limit_guard_double  # 2 parallel subreddit searches
SEARCH_MULTI=$(call_tool "search_reddit" '{"query":"python","subreddits":["programming","learnprogramming"],"limit":4}')
assert_contains "search_reddit multi-subreddit (NEW allSettled): returns results" "$SEARCH_MULTI" '"results"'

# Multi-subreddit with one invalid subreddit (NEW - failure tolerance)
rate_limit_guard_double  # 2 parallel subreddit searches (one will 404)
SEARCH_PARTIAL=$(call_tool "search_reddit" '{"query":"test","subreddits":["programming","thisdoesnotexist99999xyz"],"limit":4}')
assert_contains "search_reddit partial failure (NEW): still returns results" "$SEARCH_PARTIAL" '"results"'

# Single subreddit search
rate_limit_guard
SEARCH_SINGLE=$(call_tool "search_reddit" '{"query":"python tutorial","subreddits":["learnprogramming"],"sort":"new","limit":3}')
assert_contains "search_reddit single subreddit: returns results" "$SEARCH_SINGLE" '"results"'

# Sort by comments
rate_limit_guard
SEARCH_COMMENTS=$(call_tool "search_reddit" '{"query":"best programming language","sort":"comments","time":"month","limit":3}')
assert_contains "search_reddit sort=comments: returns results" "$SEARCH_COMMENTS" '"results"'

# Author filter (test with a known prolific user)
rate_limit_guard
SEARCH_AUTHOR=$(call_tool "search_reddit" '{"query":"reddit","author":"spez","sort":"new","limit":5}')
assert_contains "search_reddit author filter: returns results" "$SEARCH_AUTHOR" '"results"'
# Verify all returned results are by that author (if any results)
AUTHOR_CHECK=$(echo "$SEARCH_AUTHOR" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const o=JSON.parse(d);
    if (!o.results || o.results.length === 0) { console.log('pass'); return; }
    const allMatch = o.results.every(r => r.author.toLowerCase() === 'spez');
    console.log(allMatch ? 'pass' : 'fail');
  });
" 2>/dev/null)
assert "search_reddit author filter: all results match author" "[ '$AUTHOR_CHECK' = 'pass' ]"

# Flair filter (search in a subreddit known to use flairs)
rate_limit_guard
SEARCH_FLAIR=$(call_tool "search_reddit" '{"query":"help","subreddits":["technology"],"flair":"Privacy","sort":"top","time":"year","limit":5}')
assert_contains "search_reddit flair filter: returns results" "$SEARCH_FLAIR" '"results"'
# Verify flair filtering worked (all results should have matching flair or be empty)
FLAIR_CHECK=$(echo "$SEARCH_FLAIR" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const o=JSON.parse(d);
    if (!o.results || o.results.length === 0) { console.log('pass'); return; }
    const allMatch = o.results.every(r => r.link_flair_text && r.link_flair_text.toLowerCase().includes('privacy'));
    console.log(allMatch ? 'pass' : 'fail');
  });
" 2>/dev/null)
assert "search_reddit flair filter: results match flair" "[ '$FLAIR_CHECK' = 'pass' ]"

# --------------------------------------------------------------------------
# 4c. get_post_details
# --------------------------------------------------------------------------
log_subsection "4c. get_post_details"

# First grab a post ID from the browse results to use
POST_ID=$(echo "$BROWSE_HOT" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try { const o=JSON.parse(d); console.log(o.posts[0].id); }
    catch(e) { console.log(''); }
  });
" 2>/dev/null)
POST_SUB=$(echo "$BROWSE_HOT" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try { const o=JSON.parse(d); console.log(o.posts[0].subreddit); }
    catch(e) { console.log(''); }
  });
" 2>/dev/null)

if [ -n "$POST_ID" ] && [ -n "$POST_SUB" ]; then
  # Test with post_id + subreddit (efficient, 1 API call)
  rate_limit_guard
  POST_DETAILS=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_limit\":3,\"max_top_comments\":2}")
  assert_contains "get_post_details by ID+sub: has post field" "$POST_DETAILS" '"post"'
  assert_contains "get_post_details by ID+sub: has top_comments" "$POST_DETAILS" '"top_comments"'
  assert_contains "get_post_details by ID+sub: has total_comments" "$POST_DETAILS" '"total_comments"'

  # Test with URL format (NEW enhanced parser)
  POST_PERMALINK=$(echo "$BROWSE_HOT" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try { const o=JSON.parse(d); console.log(o.posts[0].permalink); }
      catch(e) { console.log(''); }
    });
  " 2>/dev/null)

  if [ -n "$POST_PERMALINK" ]; then
    rate_limit_guard
    POST_BY_URL=$(call_tool "get_post_details" "{\"url\":\"${POST_PERMALINK}\",\"comment_limit\":2,\"max_top_comments\":1}")
    assert_contains "get_post_details by URL: has post field" "$POST_BY_URL" '"post"'
  fi

  # Test comment sorting
  rate_limit_guard
  POST_TOP_SORT=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_sort\":\"top\",\"comment_limit\":3,\"max_top_comments\":2}")
  assert_contains "get_post_details comment_sort=top: works" "$POST_TOP_SORT" '"top_comments"'

  # Test link extraction (EXISTING)
  rate_limit_guard
  POST_LINKS=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"extract_links\":true,\"comment_limit\":5,\"max_top_comments\":2}")
  assert_contains "get_post_details extract_links: has field" "$POST_LINKS" '"extracted_links"'

  # Test comment_depth parameter
  rate_limit_guard
  POST_DEPTH=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_depth\":1,\"comment_limit\":5,\"max_top_comments\":3}")
  assert_contains "get_post_details comment_depth=1: works" "$POST_DEPTH" '"top_comments"'

  # Test comment_sort=new
  rate_limit_guard
  POST_NEW_SORT=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_sort\":\"new\",\"comment_limit\":3,\"max_top_comments\":2}")
  assert_contains "get_post_details comment_sort=new: works" "$POST_NEW_SORT" '"top_comments"'

  # Test comment_sort=controversial
  rate_limit_guard
  POST_CONTR_SORT=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_sort\":\"controversial\",\"comment_limit\":3,\"max_top_comments\":2}")
  assert_contains "get_post_details comment_sort=controversial: works" "$POST_CONTR_SORT" '"top_comments"'

  # Test comment_sort=qa
  rate_limit_guard
  POST_QA_SORT=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"subreddit\":\"${POST_SUB}\",\"comment_sort\":\"qa\",\"comment_limit\":3,\"max_top_comments\":2}")
  assert_contains "get_post_details comment_sort=qa: works" "$POST_QA_SORT" '"top_comments"'

  # Test post_id only (no subreddit — triggers /api/info lookup for subreddit discovery)
  rate_limit_guard_double  # 2 API calls: /api/info + /comments
  POST_ID_ONLY=$(call_tool "get_post_details" "{\"post_id\":\"${POST_ID}\",\"comment_limit\":2,\"max_top_comments\":1}")
  assert_contains "get_post_details post_id only (no subreddit): works" "$POST_ID_ONLY" '"post"'

  # Test _postid format (redd.it short URL output) — NEW: empty subreddit prefix
  rate_limit_guard_double  # /api/info + /comments
  POST_SHORT_ID="_${POST_ID}"
  POST_SHORT=$(call_tool "get_post_details" "{\"post_id\":\"${POST_SHORT_ID}\",\"comment_limit\":1,\"max_top_comments\":1}")
  assert_contains "get_post_details _postid format (redd.it path): works" "$POST_SHORT" '"post"'
else
  skip_test "get_post_details tests" "Could not extract post ID from browse results"
fi

# --------------------------------------------------------------------------
# 4d. user_analysis
# --------------------------------------------------------------------------
log_subsection "4d. user_analysis"

rate_limit_guard
USER_ANALYSIS=$(call_tool "user_analysis" '{"username":"spez","posts_limit":3,"comments_limit":3,"time_range":"year","top_subreddits_limit":5}')
assert_contains "user_analysis: has username" "$USER_ANALYSIS" '"username"'
assert_contains "user_analysis: has karma object" "$USER_ANALYSIS" '"karma"'
assert_contains "user_analysis: has accountAge" "$USER_ANALYSIS" '"accountAge"'
assert_contains "user_analysis: has recentPosts" "$USER_ANALYSIS" '"recentPosts"'
assert_contains "user_analysis: has recentComments" "$USER_ANALYSIS" '"recentComments"'
assert_contains "user_analysis: has topSubreddits" "$USER_ANALYSIS" '"topSubreddits"'

# Test with posts_limit=0 (only comments — verifies comments-only path)
rate_limit_guard
USER_COMMENTS_ONLY=$(call_tool "user_analysis" '{"username":"spez","posts_limit":0,"comments_limit":3,"time_range":"all"}')
assert_contains "user_analysis posts_limit=0: still returns data" "$USER_COMMENTS_ONLY" '"username"'
assert_contains "user_analysis posts_limit=0: has karma" "$USER_COMMENTS_ONLY" '"karma"'

# Test with comments_limit=0 (only posts)
rate_limit_guard
USER_POSTS_ONLY=$(call_tool "user_analysis" '{"username":"spez","posts_limit":5,"comments_limit":0,"time_range":"all"}')
assert_contains "user_analysis comments_limit=0: has recentPosts" "$USER_POSTS_ONLY" '"recentPosts"'

# Test time_range=day (likely triggers fallback to 'all' since spez may not post daily)
rate_limit_guard
USER_DAY=$(call_tool "user_analysis" '{"username":"spez","posts_limit":3,"comments_limit":0,"time_range":"day"}')
assert_contains "user_analysis time_range=day: returns data" "$USER_DAY" '"username"'
# Check if timeRangeNote appears (fallback behavior NEW in v1.1.12)
USER_DAY_HAS_NOTE=$(echo "$USER_DAY" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const o=JSON.parse(d);
    // Either posts found in time range OR fallback note present — both are valid
    const hasPosts = o.recentPosts && o.recentPosts.length > 0;
    const hasNote = !!o.timeRangeNote;
    console.log((hasPosts || hasNote) ? 'pass' : 'fail');
  });
" 2>/dev/null)
assert "user_analysis time_range=day: either has posts or fallback note" "[ '$USER_DAY_HAS_NOTE' = 'pass' ]"

# Test time_range=week
rate_limit_guard
USER_WEEK=$(call_tool "user_analysis" '{"username":"spez","posts_limit":3,"comments_limit":0,"time_range":"week"}')
assert_contains "user_analysis time_range=week: returns data" "$USER_WEEK" '"username"'

# --------------------------------------------------------------------------
# 4e. reddit_explain
# --------------------------------------------------------------------------
log_subsection "4e. reddit_explain"

# These don't hit the Reddit API, so no rate_limit_guard needed
EXPLAIN_KARMA=$(call_tool "reddit_explain" '{"term":"karma"}')
assert_contains "reddit_explain karma: has definition" "$EXPLAIN_KARMA" '"definition"'
assert_contains "reddit_explain karma: has origin" "$EXPLAIN_KARMA" '"origin"'
assert_contains "reddit_explain karma: has examples" "$EXPLAIN_KARMA" '"examples"'

EXPLAIN_AMA=$(call_tool "reddit_explain" '{"term":"ama"}')
assert_contains "reddit_explain ama: correct definition" "$EXPLAIN_AMA" "Ask Me Anything"

EXPLAIN_ELI5=$(call_tool "reddit_explain" '{"term":"ELI5"}')
assert_contains "reddit_explain ELI5: case insensitive match" "$EXPLAIN_ELI5" "Explain Like"

EXPLAIN_CAKE=$(call_tool "reddit_explain" '{"term":"cake day"}')
assert_contains "reddit_explain cake day: works" "$EXPLAIN_CAKE" "Anniversary"

EXPLAIN_TIL=$(call_tool "reddit_explain" '{"term":"til"}')
assert_contains "reddit_explain til: works" "$EXPLAIN_TIL" "Today I Learned"

EXPLAIN_OP=$(call_tool "reddit_explain" '{"term":"op"}')
assert_contains "reddit_explain op: works" "$EXPLAIN_OP" "Original Poster"

EXPLAIN_REPOST=$(call_tool "reddit_explain" '{"term":"repost"}')
assert_contains "reddit_explain repost: works" "$EXPLAIN_REPOST" "posted before"

EXPLAIN_SARCASM=$(call_tool "reddit_explain" '{"term":"/s"}')
assert_contains "reddit_explain /s: works" "$EXPLAIN_SARCASM" "Sarcasm"

EXPLAIN_BANANA=$(call_tool "reddit_explain" '{"term":"banana for scale"}')
assert_contains "reddit_explain banana for scale: works" "$EXPLAIN_BANANA" "banana"

EXPLAIN_BRIGADE=$(call_tool "reddit_explain" '{"term":"brigading"}')
assert_contains "reddit_explain brigading: works" "$EXPLAIN_BRIGADE" "manipulate"

# Unknown term
EXPLAIN_UNKNOWN=$(call_tool "reddit_explain" '{"term":"xyzzyfoobarbaz"}')
assert_contains "reddit_explain unknown term: graceful fallback" "$EXPLAIN_UNKNOWN" "not found"

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5: EDGE CASES & ERROR HANDLING
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 5: Edge Cases & Error Handling"

# --------------------------------------------------------------------------
# 5a. Tool Input Validation Errors
# --------------------------------------------------------------------------
log_subsection "5a. Input Validation Errors"

# Missing required fields
ERR_NO_SUB=$(call_tool "browse_subreddit" '{}')
assert_contains "browse_subreddit: missing subreddit → error" "$ERR_NO_SUB" "_error\|Error\|error\|Required"

ERR_NO_QUERY=$(call_tool "search_reddit" '{}')
assert_contains "search_reddit: missing query → error" "$ERR_NO_QUERY" "_error\|Error\|error\|Required"

ERR_NO_USER=$(call_tool "user_analysis" '{}')
assert_contains "user_analysis: missing username → error" "$ERR_NO_USER" "_error\|Error\|error\|Required"

ERR_NO_TERM=$(call_tool "reddit_explain" '{}')
assert_contains "reddit_explain: missing term → error" "$ERR_NO_TERM" "_error\|Error\|error\|Required"

# Limit out of range
ERR_LIMIT=$(call_tool "browse_subreddit" '{"subreddit":"test","limit":999}')
assert_contains "browse_subreddit: limit > 100 → error" "$ERR_LIMIT" "_error\|Error\|error"

# get_post_details: neither url nor post_id
ERR_NO_ID=$(call_tool "get_post_details" '{}')
assert_contains "get_post_details: no url/post_id → error" "$ERR_NO_ID" "_error\|Error\|error"

# --------------------------------------------------------------------------
# 5b. Nonexistent Resources
# --------------------------------------------------------------------------
log_subsection "5b. Nonexistent Resources"

rate_limit_guard
ERR_BAD_SUB=$(call_tool "browse_subreddit" '{"subreddit":"thisisnotarealsubreddit999xyz","limit":1}')
assert_contains "browse_subreddit nonexistent: returns error" "$ERR_BAD_SUB" "_error\|Error\|error\|not exist\|Not found\|inaccessible"

rate_limit_guard
ERR_BAD_USER=$(call_tool "user_analysis" '{"username":"thisisnotarealuser999xyzabc","posts_limit":1,"comments_limit":0}')
assert_contains "user_analysis nonexistent user: returns error" "$ERR_BAD_USER" "_error\|Error\|error\|not found\|Not found"

# Multi-subreddit search with nonexistent subreddits (Reddit search API returns empty, not 404)
rate_limit_guard_double  # 2 parallel searches
ERR_ALL_EMPTY=$(call_tool "search_reddit" '{"query":"test","subreddits":["nonexistent999aaa","nonexistent999bbb"],"limit":2}')
assert_contains "search_reddit nonexistent subs: returns empty results gracefully" "$ERR_ALL_EMPTY" '"results"'
EMPTY_COUNT=$(echo "$ERR_ALL_EMPTY" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const o=JSON.parse(d);
    console.log(o.total_results === 0 ? 'pass' : 'fail');
  });
" 2>/dev/null)
assert "search_reddit nonexistent subs: total_results is 0" "[ '$EMPTY_COUNT' = 'pass' ]"

# --------------------------------------------------------------------------
# 5c. Invalid URL Formats
# --------------------------------------------------------------------------
log_subsection "5c. Invalid URL Formats"

ERR_BAD_URL=$(call_tool "get_post_details" '{"url":"https://google.com/not-reddit"}')
assert_contains "get_post_details invalid URL: returns error" "$ERR_BAD_URL" "_error\|Error\|error\|Invalid"

ERR_BAD_URL2=$(call_tool "get_post_details" '{"url":"not even a url"}')
assert_contains "get_post_details garbage URL: returns error" "$ERR_BAD_URL2" "_error\|Error\|error\|Invalid"

# --------------------------------------------------------------------------
# 5d. HTTP Server Robustness (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "5d. HTTP Server Robustness — NEW"

# Malformed JSON-RPC
MALFORMED_RPC=$(curl -s -X POST "http://localhost:${HTTP_PORT}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1}' 2>/dev/null)
# Should not crash the server — verify it's still up
STILL_ALIVE=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null)
assert_contains "Server survives malformed JSON-RPC" "$STILL_ALIVE" "ok"

# Empty body
EMPTY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:${HTTP_PORT}/mcp" \
  -H "Content-Type: application/json" -d '' 2>/dev/null)
assert "Empty body returns error (400)" "[ '$EMPTY_CODE' = '400' ]"

# Verify server still alive after all abuse
FINAL_HEALTH=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null)
assert_contains "Server still healthy after error tests" "$FINAL_HEALTH" "ok"

# --------------------------------------------------------------------------
# 5e. HTTP Server Survives Validation Errors (Unhandled Rejection — NEW uncommitted)
# --------------------------------------------------------------------------
log_subsection "5e. HTTP Unhandled Rejection Resilience — NEW (uncommitted)"

# Send a request that triggers validation error inside tool handler
# This exercises the unhandledRejection → no-crash path in HTTP mode
call_tool "browse_subreddit" '{}' > /dev/null 2>&1
sleep 1
ALIVE_AFTER_ERR=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null)
assert_contains "HTTP server survives tool validation errors" "$ALIVE_AFTER_ERR" "ok"

# Fire several rapid bad requests to stress-test resilience
CURL_PIDS=()
for _i in $(seq 1 5); do
  curl -s -X POST "http://localhost:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browse_subreddit","arguments":{}}}' > /dev/null 2>&1 &
  CURL_PIDS+=($!)
done
for pid in "${CURL_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
sleep 1
ALIVE_AFTER_BURST=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null)
assert_contains "HTTP server survives burst of bad requests" "$ALIVE_AFTER_BURST" "ok"

# --------------------------------------------------------------------------
# 5f. Graceful SIGTERM Shutdown — NEW
# --------------------------------------------------------------------------
log_subsection "5f. Graceful SIGTERM Shutdown — NEW"

# Stop current server via SIGTERM and verify it exits cleanly
kill -TERM "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
SHUTDOWN_EXIT=$?
# SIGTERM typically gives exit code 143 (128 + 15) or 0 depending on signal handler
assert "Graceful SIGTERM shutdown exits cleanly (code 0 or 143)" "[ '$SHUTDOWN_EXIT' -eq 0 ] || [ '$SHUTDOWN_EXIT' -eq 143 ]"
SERVER_PID=""

# Start a fresh server to verify restart works after graceful shutdown
sleep 1
REDDIT_BUDDY_HTTP=true REDDIT_BUDDY_PORT=$HTTP_PORT node dist/index.js &
SERVER_PID=$!
for _i in $(seq 1 10); do
  if curl -s "http://localhost:${HTTP_PORT}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
RESTART_HEALTH=$(curl -s "http://localhost:${HTTP_PORT}/health" 2>/dev/null)
assert_contains "Server restarts cleanly after SIGTERM" "$RESTART_HEALTH" "ok"
# Re-initialize MCP session for the new server instance
init_mcp_session

# Stop the HTTP server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6: STDIO TRANSPORT TEST
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 6: Stdio Transport Test"

log_subsection "6a. Stdio: Initialize + tools/list"

# Send initialize and tools/list via stdin
# Use perl alarm for macOS compatibility (timeout command not available on stock macOS)
STDIO_RESULT=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | perl -e 'alarm 10; exec @ARGV' node dist/index.js 2>/dev/null || true)

assert_contains "Stdio: responds to initialize" "$STDIO_RESULT" '"serverInfo"'
assert_contains "Stdio: returns tool list" "$STDIO_RESULT" '"browse_subreddit"'
assert_contains "Stdio: returns all 5 tools" "$STDIO_RESULT" '"reddit_explain"'

# ═══════════════════════════════════════════════════════════════════════════════
# RESULTS
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${BLUE}  TEST RESULTS${NC}"
echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Total:   ${BOLD}${TOTAL}${NC}"
echo -e "  Passed:  ${GREEN}${BOLD}${PASS}${NC}"
echo -e "  Failed:  ${RED}${BOLD}${FAIL}${NC}"
echo -e "  Skipped: ${YELLOW}${BOLD}${SKIP}${NC}"
echo -e "  Reddit API calls made: ${API_CALLS}"
echo ""

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo -e "${RED}${BOLD}Failures:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}✗${NC} $f"
  done
  echo ""
fi

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ✅ ALL TESTS PASSED — ALL INTEGRATION TESTS PASSED!${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}  ❌ ${FAIL} TEST(S) FAILED — Fix before publishing!${NC}"
  echo ""
  exit 1
fi
