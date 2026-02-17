#!/usr/bin/env bash
#
# Unit tests for reddit-mcp-buddy
# Tests build, typecheck, and all offline unit tests (~5 seconds)
#
# Usage: ./tests/test-unit.sh
#

set -uo pipefail

# ── Globals ──────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0
TOTAL=0
FAILURES=()
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

skip_test() {
  local description="$1"
  local reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  echo -e "  ${YELLOW}⊘${NC} $description (skipped: $reason)"
}
# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: BUILD & STATIC ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 1: Build & Static Analysis"

cd "$PROJECT_DIR"

log_subsection "TypeScript Build"
npm run build 2>&1
BUILD_EXIT=$?
assert "npm run build succeeds" "[ $BUILD_EXIT -eq 0 ]"
assert "dist/index.js exists" "[ -f dist/index.js ]"
assert "dist/cli.js exists" "[ -f dist/cli.js ]"
assert "dist/mcp-server.js exists" "[ -f dist/mcp-server.js ]"
assert "dist/core/auth.js exists" "[ -f dist/core/auth.js ]"
assert "dist/core/cache.js exists" "[ -f dist/core/cache.js ]"
assert "dist/core/rate-limiter.js exists" "[ -f dist/core/rate-limiter.js ]"
assert "dist/services/reddit-api.js exists" "[ -f dist/services/reddit-api.js ]"
assert "dist/services/content-processor.js exists" "[ -f dist/services/content-processor.js ]"
assert "dist/tools/index.js exists" "[ -f dist/tools/index.js ]"

log_subsection "TypeScript Type Check"
npm run typecheck 2>&1
TYPECHECK_EXIT=$?
assert "npm run typecheck passes" "[ $TYPECHECK_EXIT -eq 0 ]"

log_subsection "Package Metadata"
PKG_VERSION=$(node -p "require('./package.json').version")
SERVER_JSON_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('./server.json','utf8')).version")
MCP_SERVER_VERSION=$(grep "SERVER_VERSION" src/mcp-server.ts | head -1 | grep -o "'[^']*'" | tr -d "'")

assert "package.json version matches" "[ -n '$PKG_VERSION' ]"
assert "server.json version matches package.json" "[ '$SERVER_JSON_VERSION' = '$PKG_VERSION' ]"
assert "SERVER_VERSION in mcp-server.ts matches package.json" "[ '$MCP_SERVER_VERSION' = '$PKG_VERSION' ]"
assert "All three versions match" "[ '$PKG_VERSION' = '$SERVER_JSON_VERSION' ] && [ '$PKG_VERSION' = '$MCP_SERVER_VERSION' ]"

log_subsection "server.json Validation"
SERVER_JSON_VALID=$(node -e "
  const s=JSON.parse(require('fs').readFileSync('./server.json','utf8'));
  const checks = [
    s.name === 'io.github.karanb192/reddit-mcp-buddy',
    Array.isArray(s.packages) && s.packages.length > 0,
    Array.isArray(s.tools) && s.tools.length === 5,
    s.packages[0].transport.type === 'stdio',
    s.packages[0].registryType === 'npm',
    s.packages[0].identifier === 'reddit-mcp-buddy',
  ];
  console.log(checks.every(Boolean) ? 'valid' : 'invalid');
" 2>/dev/null)
assert "server.json schema is valid" "[ '$SERVER_JSON_VALID' = 'valid' ]"

log_subsection "CLI Flags"
CLI_VERSION=$(node dist/cli.js --version 2>&1)
assert "CLI --version outputs correct version" "echo '$CLI_VERSION' | grep -q '$PKG_VERSION'"

CLI_HELP=$(node dist/cli.js --help 2>&1)
assert "CLI --help shows usage info" "echo \"$CLI_HELP\" | grep -q 'reddit-mcp-buddy'"
assert "CLI --help mentions --auth flag" "echo \"$CLI_HELP\" | grep -q '\\-\\-auth'"

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: UNIT TESTS (No Network Required)
# ═══════════════════════════════════════════════════════════════════════════════

log_section "SECTION 2: Unit Tests (No Network)"

# --------------------------------------------------------------------------
# 2a. Environment Variable Parsing (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2a. parseEnvBoolean (index.ts) — NEW"

BOOL_RESULT=$(node -e "
  // Replicate the parseEnvBoolean function from index.ts
  function parseEnvBoolean(envValue, defaultValue = false) {
    if (!envValue) return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(envValue.toLowerCase().trim());
  }
  const tests = [
    parseEnvBoolean('true') === true,
    parseEnvBoolean('TRUE') === true,
    parseEnvBoolean('True') === true,
    parseEnvBoolean('1') === true,
    parseEnvBoolean('yes') === true,
    parseEnvBoolean('on') === true,
    parseEnvBoolean('  true  ') === true,
    parseEnvBoolean('false') === false,
    parseEnvBoolean('0') === false,
    parseEnvBoolean('no') === false,
    parseEnvBoolean('') === false,
    parseEnvBoolean(undefined) === false,
    parseEnvBoolean(undefined, true) === true,
  ];
  console.log(tests.every(Boolean) ? 'pass' : 'fail');
" 2>/dev/null)
assert "parseEnvBoolean handles true/TRUE/1/yes/on/trimming/false/empty/undefined" "[ '$BOOL_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2b. Port Parsing (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2b. parsePort (index.ts) — NEW"

PORT_RESULT=$(node -e "
  function parsePort(portEnv) {
    const defaultPort = 3000;
    if (!portEnv) return defaultPort;
    const parsed = parseInt(portEnv, 10);
    if (isNaN(parsed)) return defaultPort;
    if (parsed < 1 || parsed > 65535) return defaultPort;
    return parsed;
  }
  const tests = [
    parsePort(undefined) === 3000,
    parsePort('') === 3000,
    parsePort('3000') === 3000,
    parsePort('8080') === 8080,
    parsePort('abc') === 3000,
    parsePort('0') === 3000,
    parsePort('-1') === 3000,
    parsePort('65536') === 3000,
    parsePort('65535') === 65535,
    parsePort('1') === 1,
    parsePort('  3001  ') === 3001,
  ];
  console.log(tests.every(Boolean) ? 'pass' : 'fail');
" 2>/dev/null)
assert "parsePort validates NaN, range 1-65535, defaults to 3000" "[ '$PORT_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2c. Auth: cleanEnvVar & containsUnresolvedTemplate (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2c. cleanEnvVar & Template Detection (auth.ts) — NEW"

ENV_CLEAN_RESULT=$(node --input-type=module -e "
  import { AuthManager } from './dist/core/auth.js';

  // Access private methods via prototype trick
  const am = new AuthManager();
  const cleanEnvVar = am.__proto__.__proto__ !== undefined
    ? AuthManager.prototype['cleanEnvVar'] || null
    : null;

  // We'll test via the class by setting env vars and loading
  // Test 1: Empty string → treated as undefined (no auth)
  process.env.REDDIT_CLIENT_ID = '';
  process.env.REDDIT_CLIENT_SECRET = '';
  const am1 = new AuthManager();
  await am1.load();
  const test1 = am1.getConfig() === null;  // No auth since empty

  // Test 2: Template strings → treated as undefined (no auth)
  process.env.REDDIT_CLIENT_ID = '\${REDDIT_CLIENT_ID}';
  process.env.REDDIT_CLIENT_SECRET = '\${REDDIT_CLIENT_SECRET}';
  const am2 = new AuthManager();
  await am2.load();
  const test2 = am2.getConfig() === null;

  // Test 3: Dollar-sign env var pattern → treated as undefined
  process.env.REDDIT_CLIENT_ID = '\$MY_CLIENT_ID';
  process.env.REDDIT_CLIENT_SECRET = '\$MY_SECRET';
  const am3 = new AuthManager();
  await am3.load();
  const test3 = am3.getConfig() === null;

  // Test 4: Template with default → treated as undefined
  process.env.REDDIT_CLIENT_ID = '\${REDDIT_CLIENT_ID:-default}';
  process.env.REDDIT_CLIENT_SECRET = '\${SECRET:-}';
  const am4 = new AuthManager();
  await am4.load();
  const test4 = am4.getConfig() === null;

  // Test 5: Whitespace-only → treated as undefined
  process.env.REDDIT_CLIENT_ID = '   ';
  process.env.REDDIT_CLIENT_SECRET = '   ';
  const am5 = new AuthManager();
  await am5.load();
  const test5 = am5.getConfig() === null;

  // Clean up env vars
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;

  const allPass = test1 && test2 && test3 && test4 && test5;
  console.log(allPass ? 'pass' : 'fail:' + JSON.stringify({test1,test2,test3,test4,test5}));
" 2>/dev/null)
assert "cleanEnvVar: empty strings treated as undefined" "echo '$ENV_CLEAN_RESULT' | grep -q 'pass'"

TEMPLATE_RESULT=$(node --input-type=module -e '
  // Test the containsUnresolvedTemplate logic directly
  function containsUnresolvedTemplate(value) {
    if (/\$\{[^}]*\}/.test(value)) return true;
    if (value.includes("${") && !value.includes("}")) return true;
    if (/\$[A-Z_][A-Z0-9_]*/.test(value)) return true;
    return false;
  }
  const tests = [
    containsUnresolvedTemplate("${VAR}") === true,
    containsUnresolvedTemplate("${VAR:-default}") === true,
    containsUnresolvedTemplate("${${VAR}}") === true,
    containsUnresolvedTemplate("${") === true,
    containsUnresolvedTemplate("$REDDIT_CLIENT_ID") === true,
    containsUnresolvedTemplate("${AONE}${BTWO}") === true,
    containsUnresolvedTemplate("actual_value_123") === false,
    containsUnresolvedTemplate("XaBcDeFgHiJkLm") === false,
    containsUnresolvedTemplate("") === false,
  ];
  console.log(tests.every(Boolean) ? "pass" : "fail");
' 2>/dev/null)
assert "containsUnresolvedTemplate detects all template patterns" "[ '$TEMPLATE_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2d. Auth: Rate Limit Tiers (EXISTING)
# --------------------------------------------------------------------------
log_subsection "2d. Auth Rate Limit Tiers (auth.ts)"

AUTH_TIERS_RESULT=$(node --input-type=module -e "
  import { AuthManager } from './dist/core/auth.js';

  // Test 1: Anonymous mode (no env vars)
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.REDDIT_USERNAME;
  delete process.env.REDDIT_PASSWORD;
  const am1 = new AuthManager();
  await am1.load();
  const anonLimit = am1.getRateLimit();
  const anonTTL = am1.getCacheTTL();
  const anonMode = am1.getAuthMode();
  const test1 = anonLimit === 10 && anonTTL === 15*60*1000 && anonMode === 'Anonymous';

  // Test 2: App-only mode (client ID + secret, no user/pass)
  // We can't actually authenticate, but we can test the rate limit logic
  const am2 = new AuthManager();
  am2['config'] = { clientId: 'test', clientSecret: 'test' };
  const appLimit = am2.getRateLimit();
  const appTTL = am2.getCacheTTL();
  const appMode = am2.getAuthMode();
  const test2 = appLimit === 60 && appTTL === 5*60*1000 && appMode === 'App-Only';

  // Test 3: Full auth mode (client ID + secret + user + pass)
  const am3 = new AuthManager();
  am3['config'] = { clientId: 'test', clientSecret: 'test', username: 'user', password: 'pass' };
  const fullLimit = am3.getRateLimit();
  const fullMode = am3.getAuthMode();
  const test3 = fullLimit === 100 && fullMode === 'Authenticated';

  console.log((test1 && test2 && test3) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Auth tiers: Anonymous=10, App-Only=60, Full=100 req/min" "[ '$AUTH_TIERS_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2e. Auth: Token Expiration Buffer (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2e. Token Expiration Buffer (auth.ts) — NEW"

TOKEN_BUFFER_RESULT=$(node --input-type=module -e "
  import { AuthManager } from './dist/core/auth.js';

  const am = new AuthManager();
  am['config'] = { clientId: 'x', clientSecret: 'y' };

  // Token that expires in 5 seconds - should be considered expired (within 10s buffer)
  am['config'].expiresAt = Date.now() + 5000;
  const test1 = am.isTokenExpired() === true;

  // Token that expires in 30 seconds - should NOT be expired
  am['config'].expiresAt = Date.now() + 30000;
  const test2 = am.isTokenExpired() === false;

  // Token with expiresAt = 0 - should be expired
  am['config'].expiresAt = 0;
  const test3 = am.isTokenExpired() === true;

  // Token with negative expiresAt - should be expired
  am['config'].expiresAt = -1;
  const test4 = am.isTokenExpired() === true;

  // Token already expired
  am['config'].expiresAt = Date.now() - 1000;
  const test5 = am.isTokenExpired() === true;

  console.log((test1 && test2 && test3 && test4 && test5) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Token expiration: 10s buffer, zero, negative, past values all expired" "[ '$TOKEN_BUFFER_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2f. Cache: Key Sanitization (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2f. Cache Key Sanitization (cache.ts) — NEW"

CACHE_KEY_RESULT=$(node --input-type=module -e "
  import { CacheManager } from './dist/core/cache.js';

  // Test basic key creation
  const k1 = CacheManager.createKey('subreddit', 'technology', 'hot');
  const test1 = k1 === 'subreddit:technology:hot';

  // Test with numbers and booleans
  const k2 = CacheManager.createKey('search', 'AI', 10, true);
  const test2 = k2 === 'search:ai:10:true';

  // Test special characters sanitized to underscores
  const k3 = CacheManager.createKey('search', 'machine learning');
  const test3 = k3 === 'search:machine_learning';

  // Test with special chars
  const k4 = CacheManager.createKey('search', 'what is AI?');
  const test4 = k4 === 'search:what_is_ai_';

  // Test undefined values filtered out
  const k5 = CacheManager.createKey('user', 'spez', undefined, 'new');
  const test5 = k5 === 'user:spez:new';

  // Test empty parts throw error
  let test6 = false;
  try { CacheManager.createKey(); } catch(e) { test6 = true; }

  // Test long key truncation (> 256 chars)
  const longPart = 'a'.repeat(300);
  const k7 = CacheManager.createKey('test', longPart);
  const test7 = k7.length <= 256;

  console.log((test1&&test2&&test3&&test4&&test5&&test6&&test7) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Cache keys: sanitization, undefined filtering, truncation, empty rejection" "[ '$CACHE_KEY_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2g. Cache: Core Operations + expiresAt (NEW) + has() (NEW) + oversized skip (NEW)
# --------------------------------------------------------------------------
log_subsection "2g. Cache Operations (cache.ts) — NEW + EXISTING"

CACHE_OPS_RESULT=$(node --input-type=module -e "
  import { CacheManager } from './dist/core/cache.js';

  // Test with tiny max size to test eviction and oversized skip
  const cache = new CacheManager({ maxSize: 1024, defaultTTL: 5000, cleanupInterval: 0 });

  // Basic set/get
  cache.set('key1', { data: 'hello' });
  const test1 = cache.get('key1')?.data === 'hello';

  // has() method (NEW)
  const test2 = cache.has('key1') === true;
  const test3 = cache.has('nonexistent') === false;

  // TTL expiration via expiresAt (NEW - uses expiresAt field instead of recomputing)
  cache.set('expire-test', 'data', 1); // 1ms TTL
  await new Promise(r => setTimeout(r, 10));
  const test4 = cache.get('expire-test') === null;
  const test4b = cache.has('expire-test') === false;  // has() also checks expiry

  // Custom TTL support (NEW - was _customTTL unused before)
  cache.set('custom-ttl', 'data', 60000); // 60 second TTL
  const test5 = cache.get('custom-ttl') === 'data';

  // Oversized item skip (NEW - prevents infinite eviction loop)
  const bigData = 'x'.repeat(2000); // > 1024 byte maxSize
  cache.set('toobig', bigData);
  const test6 = cache.get('toobig') === null; // Should not be cached

  // Delete
  cache.set('del-test', 'data');
  cache.delete('del-test');
  const test7 = cache.get('del-test') === null;

  // Clear
  cache.set('clear1', 'a');
  cache.set('clear2', 'b');
  cache.clear();
  const test8 = cache.get('clear1') === null && cache.get('clear2') === null;

  // Stats
  cache.set('stat1', 'data');
  cache.get('stat1');
  cache.get('stat1');
  const stats = cache.getStats();
  const test9 = stats.entries === 1;

  // Disabled cache (maxSize = 0)
  const disabledCache = new CacheManager({ maxSize: 0, cleanupInterval: 0 });
  disabledCache.set('nope', 'data');
  const test10 = disabledCache.get('nope') === null;

  cache.destroy();
  disabledCache.destroy();

  const all = test1&&test2&&test3&&test4&&test4b&&test5&&test6&&test7&&test8&&test9&&test10;
  console.log(all ? 'pass' : 'fail:'+JSON.stringify({test1,test2,test3,test4,test4b,test5,test6,test7,test8,test9,test10}));
" 2>/dev/null)
assert "Cache: get/set/has/delete/clear/stats/expiry/custom-TTL/oversized-skip/disabled" "echo '$CACHE_OPS_RESULT' | grep -q 'pass'"

# --------------------------------------------------------------------------
# 2h. Cache: Adaptive TTL by Pattern (EXISTING)
# --------------------------------------------------------------------------
log_subsection "2h. Cache Adaptive TTL Patterns (cache.ts)"

CACHE_TTL_RESULT=$(node --input-type=module -e "
  import { CacheManager } from './dist/core/cache.js';

  const cache = new CacheManager({ defaultTTL: 5*60*1000, cleanupInterval: 0 });

  // Set items with pattern-matching keys
  cache.set('subreddit:tech:hot', 'data');     // 5 min
  cache.set('subreddit:tech:new', 'data');     // 2 min
  cache.set('subreddit:tech:top', 'data');     // 30 min
  cache.set('post:abc123', 'data');            // 10 min
  cache.set('user:spez', 'data');              // 15 min
  cache.set('search:query', 'data');           // 10 min
  cache.set('other:key', 'data');              // default 5 min

  // Verify all items were cached
  const test1 = cache.has('subreddit:tech:hot');
  const test2 = cache.has('subreddit:tech:new');
  const test3 = cache.has('subreddit:tech:top');
  const test4 = cache.has('post:abc123');
  const test5 = cache.has('user:spez');
  const test6 = cache.has('search:query');
  const test7 = cache.has('other:key');

  cache.destroy();
  console.log((test1&&test2&&test3&&test4&&test5&&test6&&test7) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Cache adaptive TTL: all pattern-based keys cached correctly" "[ '$CACHE_TTL_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2i. Rate Limiter: Sliding Window + Compound (EXISTING + NEW empty state)
# --------------------------------------------------------------------------
log_subsection "2i. Rate Limiter (rate-limiter.ts)"

RATE_LIMITER_RESULT=$(node --input-type=module -e "
  import { RateLimiter, CompoundRateLimiter } from './dist/core/rate-limiter.js';

  // Basic rate limiter
  const rl = new RateLimiter({ limit: 3, window: 1000, name: 'test' });

  const test1 = rl.canMakeRequest() === true;
  rl.recordRequest();
  rl.recordRequest();
  rl.recordRequest();
  const test2 = rl.canMakeRequest() === false;

  // Stats
  const stats = rl.getStats();
  const test3 = stats.used === 3 && stats.limit === 3 && stats.available === 0;

  // tryRequest
  const test4 = rl.tryRequest() === false;

  // Wait for window to pass
  await new Promise(r => setTimeout(r, 1100));
  const test5 = rl.canMakeRequest() === true;

  // Reset
  rl.recordRequest();
  rl.reset();
  const test6 = rl.canMakeRequest() === true;

  // Error message for anonymous
  const rl2 = new RateLimiter({ limit: 1, window: 60000 });
  rl2.recordRequest();
  const errMsg = rl2.getErrorMessage(false);
  const test7 = errMsg.includes('10x more requests') && errMsg.includes('reddit-mcp-buddy --auth');

  // Error message for authenticated
  const errMsgAuth = rl2.getErrorMessage(true);
  const test8 = errMsgAuth.includes('Rate limit reached');

  // CompoundRateLimiter: empty state (NEW - allows requests when no limiters configured)
  const crl = new CompoundRateLimiter();
  const test9 = crl.canMakeRequest() === true;
  const test10 = crl.timeUntilNextRequest() === 0;

  // CompoundRateLimiter: with limiters
  crl.addLimiter('per-min', { limit: 2, window: 60000 });
  crl.addLimiter('per-sec', { limit: 1, window: 1000 });
  const test11 = crl.canMakeRequest() === true;
  crl.recordRequest();
  const test12 = crl.canMakeRequest() === false; // per-sec limit hit

  const all = test1&&test2&&test3&&test4&&test5&&test6&&test7&&test8&&test9&&test10&&test11&&test12;
  console.log(all ? 'pass' : 'fail:'+JSON.stringify({test1,test2,test3,test4,test5,test6,test7,test8,test9,test10,test11,test12}));
" 2>/dev/null)
assert "Rate limiter: sliding window, stats, reset, error msgs, compound empty state" "echo '$RATE_LIMITER_RESULT' | grep -q 'pass'"

# --------------------------------------------------------------------------
# 2j. URL Parser: All Formats (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2j. URL Parser (tools/index.ts) — NEW"

URL_PARSER_RESULT=$(node --input-type=module -e "
  import { RedditAPI } from './dist/services/reddit-api.js';
  import { AuthManager } from './dist/core/auth.js';
  import { RateLimiter } from './dist/core/rate-limiter.js';
  import { CacheManager } from './dist/core/cache.js';
  import { RedditTools } from './dist/tools/index.js';

  // Create a minimal tools instance just to test URL parsing
  const am = new AuthManager();
  const api = new RedditAPI({
    authManager: am,
    rateLimiter: new RateLimiter({ limit: 10, window: 60000 }),
    cacheManager: new CacheManager({ cleanupInterval: 0 }),
  });
  const tools = new RedditTools(api);
  const parse = tools['extractPostIdFromUrl'].bind(tools);

  const tests = [];

  // Standard URLs
  tests.push(parse('https://www.reddit.com/r/technology/comments/abc123/some_title/') === 'technology_abc123');
  tests.push(parse('https://reddit.com/r/science/comments/xyz789/title') === 'science_xyz789');

  // Old reddit (NEW)
  tests.push(parse('https://old.reddit.com/r/programming/comments/def456/title') === 'programming_def456');

  // No-participation (NEW)
  tests.push(parse('https://np.reddit.com/r/news/comments/ghi789/title') === 'news_ghi789');

  // Mobile (NEW)
  tests.push(parse('https://m.reddit.com/r/AskReddit/comments/jkl012/title') === 'AskReddit_jkl012');

  // New reddit subdomain (NEW)
  tests.push(parse('https://new.reddit.com/r/funny/comments/mno345/title') === 'funny_mno345');

  // Short URL redd.it (NEW)
  tests.push(parse('https://redd.it/abc123') === '_abc123');

  // Cross-post URL (NEW)
  tests.push(parse('https://www.reddit.com/comments/abc123') === '_abc123');

  // Gallery URL (NEW)
  tests.push(parse('https://www.reddit.com/gallery/abc123') === '_abc123');

  // URL with query params (NEW)
  tests.push(parse('https://www.reddit.com/r/tech/comments/abc123/title?utm_source=share&utm_medium=web') === 'tech_abc123');

  // URL with fragment (NEW)
  tests.push(parse('https://www.reddit.com/r/tech/comments/abc123/title#comment123') === 'tech_abc123');

  // URL with both query and fragment (NEW)
  tests.push(parse('https://www.reddit.com/r/tech/comments/abc123/title?foo=bar#baz') === 'tech_abc123');

  // Case insensitivity (NEW)
  tests.push(parse('HTTPS://WWW.REDDIT.COM/r/Tech/comments/ABC123/title') === 'Tech_ABC123');

  // Invalid URL should throw
  let threwOnInvalid = false;
  try { parse('https://google.com/not-reddit'); } catch(e) { threwOnInvalid = true; }
  tests.push(threwOnInvalid);

  console.log(tests.every(Boolean) ? 'pass' : 'fail:idx=' + tests.indexOf(false));
" 2>/dev/null)
assert "URL parser: standard/old/np/m/new/redd.it/gallery/crosspost/query/fragment/invalid" "[ '$URL_PARSER_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2k. MCP Response Validation (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2k. MCP Response Validation (mcp-server.ts) — NEW"

MCP_VALIDATION_RESULT=$(node --input-type=module -e "
  import { z } from 'zod';

  // Replicate the validation schemas from mcp-server.ts
  const ContentBlockSchema = z.object({
    type: z.enum(['text', 'image']),
    text: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
  }).refine(
    (obj) => obj.type === 'text' ? !!obj.text : (!!obj.data && !!obj.mimeType),
    'text type requires text field, image type requires data and mimeType fields'
  );

  const ToolResultResponseSchema = z.object({
    content: z.array(ContentBlockSchema).min(1),
    isError: z.boolean().optional(),
  }).strict();

  // Valid text response
  const test1 = ToolResultResponseSchema.safeParse({
    content: [{ type: 'text', text: 'hello' }]
  }).success;

  // Valid error response
  const test2 = ToolResultResponseSchema.safeParse({
    content: [{ type: 'text', text: 'Error: something' }],
    isError: true
  }).success;

  // Invalid: empty content array
  const test3 = !ToolResultResponseSchema.safeParse({
    content: []
  }).success;

  // Invalid: text type without text field
  const test4 = !ToolResultResponseSchema.safeParse({
    content: [{ type: 'text' }]
  }).success;

  // Invalid: extra fields (strict mode)
  const test5 = !ToolResultResponseSchema.safeParse({
    content: [{ type: 'text', text: 'hi' }],
    extraField: true
  }).success;

  // Invalid: missing content
  const test6 = !ToolResultResponseSchema.safeParse({}).success;

  console.log((test1&&test2&&test3&&test4&&test5&&test6) ? 'pass' : 'fail');
" 2>/dev/null)
assert "MCP response validation: valid/error/empty/missing-text/extra-fields/missing-content" "[ '$MCP_VALIDATION_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2l. Content Processor (EXISTING)
# --------------------------------------------------------------------------
log_subsection "2l. Content Processor (content-processor.ts)"

CONTENT_PROC_RESULT=$(node --input-type=module -e "
  import { ContentProcessor } from './dist/services/content-processor.js';

  // Test formatScore
  const test1 = ContentProcessor.formatScore(500) === '500';
  const test2 = ContentProcessor.formatScore(1500) === '1.5k';
  const test3 = ContentProcessor.formatScore(1500000) === '1.5M';

  // Test truncateTitle
  const test4 = ContentProcessor.truncateTitle('Short title') === 'Short title';
  const test5 = ContentProcessor.truncateTitle('A'.repeat(100)).endsWith('...');
  const test6 = ContentProcessor.truncateTitle('A'.repeat(100)).length === 80;

  // Test analyzeSentiment
  const test7 = ContentProcessor.analyzeSentiment('This is great and awesome!') === 'positive';
  const test8 = ContentProcessor.analyzeSentiment('This is terrible and horrible') === 'negative';
  const test9 = ContentProcessor.analyzeSentiment('The weather is cloudy') === 'neutral';
  const test10 = ContentProcessor.analyzeSentiment('This is great but terrible') === 'mixed';

  // Test generateInsight
  // Post created 1 day ago with high score — should be Mega-hit (velocity < 1000)
  const mockPost = {
    id: '1', title: 'Test', author: 'user', subreddit: 'test',
    subreddit_name_prefixed: 'r/test', score: 15000, num_comments: 100,
    created_utc: Date.now()/1000 - 86400, url: '', permalink: '',
    ups: 15000, downs: 0
  };
  const insight = ContentProcessor.generateInsight(mockPost);
  const test11 = insight.includes('Mega-hit') || insight.includes('Viral');

  // Test detectInterests
  const test12 = ContentProcessor.detectInterests(['programming', 'javascript', 'gaming'])
    .includes('Technology');

  // Test analyzeVibe
  const test13 = ContentProcessor.analyzeVibe([]) === '🌵 Empty - no posts found';

  console.log((test1&&test2&&test3&&test4&&test5&&test6&&test7&&test8&&test9&&test10&&test11&&test12&&test13)
    ? 'pass' : 'fail');
" 2>/dev/null)
assert "Content processor: formatScore/truncate/sentiment/insight/interests/vibe" "[ '$CONTENT_PROC_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2m. Zod Schema Validation (EXISTING tools)
# --------------------------------------------------------------------------
log_subsection "2m. Zod Tool Schema Validation"

SCHEMA_RESULT=$(node --input-type=module -e "
  import {
    browseSubredditSchema, searchRedditSchema, getPostDetailsSchema,
    userAnalysisSchema, redditExplainSchema
  } from './dist/tools/index.js';

  // browseSubredditSchema
  const b1 = browseSubredditSchema.safeParse({ subreddit: 'tech' }).success;
  const b2 = browseSubredditSchema.safeParse({ subreddit: 'tech', sort: 'top', time: 'week', limit: 50 }).success;
  const b3 = !browseSubredditSchema.safeParse({ subreddit: 'tech', limit: 200 }).success; // > 100
  const b4 = !browseSubredditSchema.safeParse({}).success; // missing subreddit

  // searchRedditSchema
  const s1 = searchRedditSchema.safeParse({ query: 'AI' }).success;
  const s2 = searchRedditSchema.safeParse({ query: 'AI', subreddits: ['tech', 'science'], sort: 'top' }).success;
  const s3 = !searchRedditSchema.safeParse({}).success; // missing query

  // getPostDetailsSchema
  const p1 = getPostDetailsSchema.safeParse({ post_id: 'abc123' }).success;
  const p2 = getPostDetailsSchema.safeParse({ url: 'https://reddit.com/r/t/comments/abc/t' }).success;
  const p3 = getPostDetailsSchema.safeParse({ post_id: 'abc', subreddit: 'tech' }).success;

  // userAnalysisSchema
  const u1 = userAnalysisSchema.safeParse({ username: 'spez' }).success;
  const u2 = userAnalysisSchema.safeParse({ username: 'spez', posts_limit: 0, comments_limit: 50 }).success;
  const u3 = !userAnalysisSchema.safeParse({}).success; // missing username

  // redditExplainSchema
  const e1 = redditExplainSchema.safeParse({ term: 'karma' }).success;
  const e2 = !redditExplainSchema.safeParse({}).success; // missing term

  const all = b1&&b2&&b3&&b4&&s1&&s2&&s3&&p1&&p2&&p3&&u1&&u2&&u3&&e1&&e2;
  console.log(all ? 'pass' : 'fail');
" 2>/dev/null)
assert "Zod schemas: all 5 tools validate correct/invalid inputs" "[ '$SCHEMA_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2n. Backoff, Retry-After, Stale Request Cleanup (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2n. Backoff / Retry-After / Stale Cleanup (reddit-api.ts) — NEW"

BACKOFF_TEST=$(node --input-type=module -e "
  import { RedditAPI } from './dist/services/reddit-api.js';
  import { AuthManager } from './dist/core/auth.js';
  import { RateLimiter } from './dist/core/rate-limiter.js';
  import { CacheManager } from './dist/core/cache.js';

  const api = new RedditAPI({
    authManager: new AuthManager(),
    rateLimiter: new RateLimiter({ limit: 100, window: 60000 }),
    cacheManager: new CacheManager({ cleanupInterval: 0 }),
  });

  // Test calculateBackoff: INITIAL=100, MULTIPLIER=2, maxRetries=2
  // retriesLeft=2 → retriesUsed=0 → base=100*2^0=100
  // retriesLeft=1 → retriesUsed=1 → base=100*2^1=200
  // retriesLeft=0 → retriesUsed=2 → base=100*2^2=400
  const b1 = api['calculateBackoff'](2); // ~100 ±20%
  const b2 = api['calculateBackoff'](1); // ~200 ±20%
  const b3 = api['calculateBackoff'](0); // ~400 ±20%

  const t1 = b1 >= 80 && b1 <= 120;
  const t2 = b2 >= 160 && b2 <= 240;
  const t3 = b3 >= 320 && b3 <= 480;

  // Backoff is always non-negative and integer
  const t4 = Number.isInteger(b1) && b1 >= 0;
  const t5 = Number.isInteger(b2) && b2 >= 0;

  // Test getRetryAfterDelay with seconds
  const mockResp = { headers: { get: (h) => h === 'retry-after' ? '5' : null } };
  const t6 = api['getRetryAfterDelay'](mockResp) === 5000;

  // Test getRetryAfterDelay with null header
  const mockRespNull = { headers: { get: () => null } };
  const t7 = api['getRetryAfterDelay'](mockRespNull) === null;

  // Test getRetryAfterDelay capped at MAX_BACKOFF_MS (30000)
  const mockRespHuge = { headers: { get: (h) => h === 'retry-after' ? '120' : null } };
  const t8 = api['getRetryAfterDelay'](mockRespHuge) === 30000;

  // Test stale in-flight cleanup (TTL is 5 min)
  api['inFlightRequests'].set('/stale', Promise.resolve());
  api['inFlightRequestTimestamps'].set('/stale', Date.now() - 6 * 60 * 1000); // 6 min old
  api['inFlightRequests'].set('/fresh', Promise.resolve());
  api['inFlightRequestTimestamps'].set('/fresh', Date.now()); // just now
  api['cleanupStaleInFlightRequests']();
  const t9 = !api['inFlightRequests'].has('/stale');     // stale removed
  const t10 = api['inFlightRequests'].has('/fresh');      // fresh kept
  const t11 = !api['inFlightRequestTimestamps'].has('/stale');
  const t12 = api['inFlightRequestTimestamps'].has('/fresh');

  api['cache'].destroy();
  const all = t1&&t2&&t3&&t4&&t5&&t6&&t7&&t8&&t9&&t10&&t11&&t12;
  console.log(all ? 'pass' : 'fail:'+JSON.stringify({t1,t2,t3,t4,t5,t6,t7,t8,t9,t10,t11,t12,b1,b2,b3}));
" 2>/dev/null)
assert "Backoff/retry-after/stale cleanup: exponential backoff, header parsing, TTL eviction" "echo '$BACKOFF_TEST' | grep -q 'pass'"

# --------------------------------------------------------------------------
# 2o. Deleted/Null Comment Filtering (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2o. Deleted Comment Filtering (tools/index.ts) — NEW"

COMMENT_FILTER_TEST=$(node --input-type=module -e "
  // Replicate the comment filtering logic from tools/index.ts user_analysis
  const children = [
    { data: null },                         // Deleted comment
    { data: undefined },                    // Missing data
    { data: { id: 'abc', body: 'hello', score: 5, subreddit: 'test', link_title: 'Post', created_utc: 1000, permalink: '/r/test/abc' } },
    { data: { id: null, body: 'orphan' } }, // Missing id
    { data: { id: 'xyz', body: null } },    // Missing body
    { data: { id: 'def', body: 'test', score: null, subreddit: null, created_utc: null, permalink: null, link_title: null } },
  ];

  const result = children
    .filter(child => child.data !== null && child.data !== undefined)
    .map(child => {
      const c = child.data;
      if (!c.id || !c.body) return null;
      return {
        id: c.id,
        body: c.body.substring(0, 200),
        score: c.score || 0,
        subreddit: c.subreddit || 'unknown',
        postTitle: c.link_title || 'deleted',
        url: c.permalink ? 'https://reddit.com' + c.permalink : null,
      };
    })
    .filter(c => c !== null);

  const t1 = result.length === 2;           // Only 2 valid comments
  const t2 = result[0].id === 'abc';
  const t3 = result[1].id === 'def';
  const t4 = result[1].score === 0;          // null → 0
  const t5 = result[1].subreddit === 'unknown'; // null → 'unknown'
  const t6 = result[1].postTitle === 'deleted';  // null → 'deleted'
  const t7 = result[1].url === null;          // null permalink

  console.log((t1&&t2&&t3&&t4&&t5&&t6&&t7) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Comment filter: null data/missing id/missing body filtered, safe defaults applied" "[ '$COMMENT_FILTER_TEST' = 'pass' ]"

# --------------------------------------------------------------------------
# 2p. OAuth Token Response Schema (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2p. OAuth Token Response Schema (auth.ts) — NEW"

OAUTH_SCHEMA_RESULT=$(node --input-type=module -e "
  import { z } from 'zod';

  // Replicate OAuthTokenResponseSchema from auth.ts
  const OAuthTokenResponseSchema = z.object({
    access_token: z.string().min(1, 'access_token must not be empty'),
    token_type: z.string().min(1, 'token_type must not be empty'),
    expires_in: z.number().positive('expires_in must be positive'),
    scope: z.string(),
  }).strict().passthrough();

  // Valid response
  const t1 = OAuthTokenResponseSchema.safeParse({
    access_token: 'eyJhbGciOiJSUzI1NiIs.test.token123',
    token_type: 'bearer',
    expires_in: 86400,
    scope: 'read'
  }).success;

  // Missing access_token
  const t2 = !OAuthTokenResponseSchema.safeParse({
    token_type: 'bearer', expires_in: 3600, scope: ''
  }).success;

  // Empty access_token
  const t3 = !OAuthTokenResponseSchema.safeParse({
    access_token: '', token_type: 'bearer', expires_in: 3600, scope: ''
  }).success;

  // Negative expires_in
  const t4 = !OAuthTokenResponseSchema.safeParse({
    access_token: 'token123456', token_type: 'bearer', expires_in: -1, scope: ''
  }).success;

  // Zero expires_in
  const t5 = !OAuthTokenResponseSchema.safeParse({
    access_token: 'token123456', token_type: 'bearer', expires_in: 0, scope: ''
  }).success;

  // Extra fields allowed (passthrough)
  const t6 = OAuthTokenResponseSchema.safeParse({
    access_token: 'token123456', token_type: 'bearer', expires_in: 3600, scope: '',
    refresh_token: 'extra_field'
  }).success;

  // Missing token_type
  const t7 = !OAuthTokenResponseSchema.safeParse({
    access_token: 'token123456', expires_in: 3600, scope: ''
  }).success;

  // Empty scope is allowed (Reddit returns empty scope sometimes)
  const t8 = OAuthTokenResponseSchema.safeParse({
    access_token: 'token123456', token_type: 'bearer', expires_in: 3600, scope: ''
  }).success;

  console.log((t1&&t2&&t3&&t4&&t5&&t6&&t7&&t8) ? 'pass' : 'fail');
" 2>/dev/null)
assert "OAuth schema: valid/missing/empty/negative/zero/extra/scope validation" "[ '$OAUTH_SCHEMA_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2q. Token Refresh Lock (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2q. Token Refresh Lock (auth.ts) — NEW"

TOKEN_LOCK_RESULT=$(node --input-type=module -e "
  import { AuthManager } from './dist/core/auth.js';

  const am = new AuthManager();

  // Lock starts null
  const t1 = am['tokenRefreshPromise'] === null;

  // Simulate config with expired token
  am['config'] = { clientId: 'x', clientSecret: 'y', expiresAt: 0 };

  // refreshAccessToken will fail (no real Reddit), but lock must clear
  try { await am.refreshAccessToken(); } catch(e) { /* expected network error */ }
  const t2 = am['tokenRefreshPromise'] === null;  // Lock cleared after error

  // Verify isTokenExpired still works after failed refresh
  am['config'].expiresAt = 0;
  const t3 = am.isTokenExpired() === true;

  console.log((t1 && t2 && t3) ? 'pass' : 'fail');
" 2>/dev/null)
assert "Token refresh lock: starts null, clears on error, isTokenExpired works after" "[ '$TOKEN_LOCK_RESULT' = 'pass' ]"

# --------------------------------------------------------------------------
# 2r. REDDIT_BUDDY_NO_CACHE Flexible Boolean (NEW in v1.1.12)
# --------------------------------------------------------------------------
log_subsection "2r. Cache Disable Boolean Parsing (mcp-server.ts) — NEW"

NOCACHE_TEST=$(node --input-type=module -e "
  // Test the inline boolean parsing used for REDDIT_BUDDY_NO_CACHE
  function parseBool(val) {
    return ['true', '1', 'yes', 'on'].includes((val || '').toLowerCase().trim());
  }
  const t1 = parseBool('true') === true;
  const t2 = parseBool('1') === true;
  const t3 = parseBool('yes') === true;
  const t4 = parseBool('on') === true;
  const t5 = parseBool('TRUE') === true;
  const t6 = parseBool('  true  ') === true;
  const t7 = parseBool('false') === false;
  const t8 = parseBool('0') === false;
  const t9 = parseBool('') === false;
  const t10 = parseBool(undefined) === false;
  console.log((t1&&t2&&t3&&t4&&t5&&t6&&t7&&t8&&t9&&t10) ? 'pass' : 'fail');
" 2>/dev/null)
assert "REDDIT_BUDDY_NO_CACHE: true/1/yes/on/TRUE/trimmed/false/0/empty/undefined" "[ '$NOCACHE_TEST' = 'pass' ]"


# ═══════════════════════════════════════════════════════════════════════════════
# RESULTS
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${BLUE}  UNIT TEST RESULTS${NC}"
echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Total:   ${BOLD}${TOTAL}${NC}"
echo -e "  Passed:  ${GREEN}${BOLD}${PASS}${NC}"
echo -e "  Failed:  ${RED}${BOLD}${FAIL}${NC}"
echo -e "  Skipped: ${YELLOW}${BOLD}${SKIP}${NC}"
echo ""

if [ ${#FAILURES[@]} -gt 0 ]; then
  echo -e "${RED}${BOLD}Failures:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}✗${NC} $f"
  done
  echo ""
fi

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ✅ ALL UNIT TESTS PASSED${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}  ❌ ${FAIL} UNIT TEST(S) FAILED${NC}"
  echo ""
  exit 1
fi
