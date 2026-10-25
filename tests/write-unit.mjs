/**
 * Offline coverage suite for the v1.2.0 write modules:
 *   dist/core/write-gate.js, dist/services/write-errors.js, dist/tools/write.js
 *
 * Run directly (node tests/write-unit.mjs) or under c8 (npm run test:coverage,
 * which enforces 100% lines/functions/branches/statements per file on the
 * three modules). tests/test-unit.sh runs this file too, so one command still
 * runs everything.
 *
 * Everything here is offline: globalThis.fetch is replaced with a fixture
 * router before any API object exists, time is injected into the WriteGate,
 * and the verify-after-submit delay is injected so no test ever sleeps 2 s.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A clean HOME before anything constructs an AuthManager: dev machines can
// have a real ~/.reddit-mcp-buddy/auth.json that would leak into tests.
process.env.HOME = mkdtempSync(join(tmpdir(), 'rmb-write-unit-'));
process.env.USERPROFILE = process.env.HOME;

// Deterministic env: fake full credentials, no write-related overrides.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('REDDIT_BUDDY_')) delete process.env[key];
}
process.env.REDDIT_CLIENT_ID = 'testclientid';
process.env.REDDIT_CLIENT_SECRET = 'testsecret';
process.env.REDDIT_USERNAME = 'testuser';
process.env.REDDIT_PASSWORD = 'testpass';
delete process.env.REDDIT_REFRESH_TOKEN;

// Capture stderr chatter (API error logs, WRITE audit lines) so asserts can
// inspect it and the suite output stays readable.
const errLog = [];
console.error = (...args) => { errLog.push(args.join(' ')); };

const root = new URL('..', import.meta.url);
const { WriteGate } = await import(new URL('dist/core/write-gate.js', root));
const { WriteError, mapWriteError, mapWriteHttpError, redactWriteError } =
  await import(new URL('dist/services/write-errors.js', root));
const {
  writeSubredditName, createPostSchema, addCommentSchema, subredditRulesSchema,
  inferPostKind, resolveCommentTarget, parseCommentUrl, safeRegexTest, RedditWriteTools,
} = await import(new URL('dist/tools/write.js', root));
const { AuthManager } = await import(new URL('dist/core/auth.js', root));
const { CacheManager } = await import(new URL('dist/core/cache.js', root));
const { RateLimiter } = await import(new URL('dist/core/rate-limiter.js', root));
const { RedditAPI } = await import(new URL('dist/services/reddit-api.js', root));

// ── Tiny harness ─────────────────────────────────────────────────────────────

let passCount = 0;
const failures = [];
function t(name, cond) {
  if (cond) { passCount++; } else { failures.push(name); }
}
async function throwsMsg(fn) {
  try { await fn(); return null; } catch (e) { return e.message; }
}

// ── Fixture-backed fetch mock ────────────────────────────────────────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const httpStatus = (status) => new Response('', { status });
const token = () => json({ access_token: 'tok_0123456789', token_type: 'bearer', expires_in: 3600, scope: '*' });

// Per-subreddit fixtures. aboutBody/rulesBody override the default wrapping
// when a test needs a malformed shape (missing data key, rules not an array).
const SUBS = {
  // Preflight matrix
  anysub:     { about: { submission_type: 'any', restrict_posting: false }, reqs: {} },
  selfonly:   { about: { submission_type: 'self' }, reqs: {} },
  linkonly:   { about: { submission_type: 'link' },
                reqs: { domain_blacklist: [123, '', 'badsite.com'], domain_whitelist: [] } },
  whitelist:  { about: { submission_type: 'any' },
                reqs: { domain_blacklist: [], domain_whitelist: ['ok.com', 7] } },
  restricted: { about: { submission_type: 'any', restrict_posting: true }, reqs: {} },
  titlerules: { about: { submission_type: 'any' },
                reqs: { title_text_min_length: 5, title_text_max_length: 20,
                        title_blacklisted_strings: [42, '', 'spam'],
                        title_required_strings: [99, '', 'Tag'],
                        title_regexes: ['[', '', '^\\['] } },
  bodyreq:    { about: { submission_type: 'any' }, reqs: { body_restriction_policy: 'required' } },
  nobody:     { about: { submission_type: 'any' }, reqs: { body_restriction_policy: 'notAllowed' } },
  // Hostile mod-authored title_regexes (ReDoS guard fixtures)
  redos:      { about: { submission_type: 'any' }, reqs: { title_regexes: ['^(a+)+$'] } },
  longregex:  { about: { submission_type: 'any' }, reqs: { title_regexes: ['a'.repeat(1001)] } },
  manyregex:  { about: { submission_type: 'any' }, reqs: { title_regexes: Array.from({ length: 12 }, () => 'Tag') } },
  flairreq:   { about: { submission_type: 'any' }, reqs: { is_flair_required: true },
                flairs: [{ id: 'f1', text: 'News', text_editable: false, mod_only: false },
                         { id: 'fmod', text: 'Mod', text_editable: false, mod_only: true }] },
  flairfail:  { about: { submission_type: 'any' }, reqs: { is_flair_required: true }, flairsStatus: 500 },
  u_someone:  { about: { submission_type: 'any' }, reqsStatus: 403 },
  reqfail:    { about: { submission_type: 'any' }, reqsStatus: 500 },
  aboutfail:  { aboutStatus: 500, reqs: {} },
  privsub:    { aboutStatus: 403 },
  gonesub:    { aboutStatus: 404 },

  // subreddit_rules fixtures
  r_full:     { about: { submission_type: 'any', allow_images: true, allow_videos: false,
                         allow_galleries: true, allow_polls: false, restrict_posting: false,
                         over18: false, submit_text: 'S'.repeat(600) },
                rules: [
                  { short_name: 'Be nice', kind: 'comment', description: 'D'.repeat(450) },
                  {},
                ],
                reqs: { title_text_min_length: 10, guidelines_text: null, body_blacklisted_strings: [],
                        title_text_max_length: '', body_restriction_policy: 'none', is_flair_required: true },
                flairs: Array.from({ length: 27 }, (_, i) => (
                  { id: `f${i}`, text: `Flair ${i}`, text_editable: i === 0, mod_only: i >= 25 })) },
  r_empty:    { about: { submission_type: 'any' }, rules: [], reqsStatus: 404, flairs: [] },
  u_prof2:    { about: { submission_type: 'any' }, rules: [], reqsStatus: 403, flairs: [] },
  r_badshape: { about: { submission_type: 'any', submit_text: '   ' }, rulesBody: {}, reqs: {},
                flairs: [{ id: 'a', text: 'A', text_editable: false, mod_only: false },
                         { id: 'b', text: 'B', text_editable: true, mod_only: false }] },
  r_fail:     { aboutStatus: 500, rulesStatus: 500, reqsStatus: 500, flairsStatus: 500 },
  r_nodata:   { aboutBody: {}, rules: [{ short_name: 'One', kind: 'all', description: 'short' }],
                reqs: {}, flairs: [] },
  privrules:  { aboutStatus: 403 },
};

let submitCalls = 0;
let lastSubmitBody = '';
let commentCalls = 0;
let commentMode = 'normal'; // normal | userperm | noperm | error
let commentErrors = null;
let infoMode = 'live'; // live | removed | gone | fail
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? 'GET' });
  if (u.includes('access_token')) return token();
  let m;
  if ((m = u.match(/\/r\/([^/]+)\/about\/rules\.json/))) {
    const f = SUBS[m[1]] ?? {};
    if (f.rulesStatus) return httpStatus(f.rulesStatus);
    return json(f.rulesBody ?? { rules: f.rules ?? [] });
  }
  if ((m = u.match(/\/r\/([^/]+)\/about\.json/))) {
    const f = SUBS[m[1]] ?? {};
    if (f.aboutStatus) return httpStatus(f.aboutStatus);
    return json(f.aboutBody ?? { data: f.about ?? { submission_type: 'any' } });
  }
  if ((m = u.match(/\/api\/v1\/([^/]+)\/post_requirements/))) {
    const f = SUBS[m[1]] ?? {};
    if (f.reqsStatus) return httpStatus(f.reqsStatus);
    return json(f.reqs ?? {});
  }
  if ((m = u.match(/\/r\/([^/]+)\/api\/link_flair_v2/))) {
    const f = SUBS[m[1]] ?? {};
    if (f.flairsStatus) return httpStatus(f.flairsStatus);
    return json(f.flairs ?? []);
  }
  if (u.endsWith('/api/submit')) {
    submitCalls++;
    lastSubmitBody = init.body;
    const sub = new URLSearchParams(init.body).get('sr');
    return json({ json: { errors: [], data: { id: 'p1', name: 't3_p1', url: `https://www.reddit.com/r/${sub}/comments/p1/t/` } } });
  }
  if (u.endsWith('/api/comment')) {
    commentCalls++;
    if (commentMode === 'error') return json({ json: { errors: commentErrors } });
    const data = commentMode === 'noperm'
      ? { id: 't1_c9' }
      : { id: 't1_c9', permalink: commentMode === 'userperm' ? '/user/testuser/comments/pp1/t/c9/' : '/r/anysub/comments/p1/t/c9/' };
    return json({ json: { errors: [], data: { things: [{ data }] } } });
  }
  if (u.includes('/api/info.json')) {
    if (infoMode === 'fail') return httpStatus(500);
    if (infoMode === 'gone') return json({ kind: 'Listing', data: { children: [] } });
    const removed = infoMode === 'removed' ? 'automod_filtered' : null;
    return json({ kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'p1', removed_by_category: removed } }] } });
  }
  throw new Error('unexpected fetch: ' + u);
};

// ── Shared write-tool plumbing ───────────────────────────────────────────────

const auth = new AuthManager();
await auth.load();
const cache = new CacheManager();
const api = new RedditAPI({
  authManager: auth,
  rateLimiter: new RateLimiter({ limit: 100000, window: 60000, name: 'test' }),
  cacheManager: cache,
  timeout: 2000,
});
let now = 1_700_000_000_000;
const clock = { now: () => now };
const tick = (ms = 20000) => { now += ms; };
const gate = new WriteGate(clock);
const tools = new RedditWriteTools({ api, gate, cache, actingUser: 'testuser', verifyDelayMs: 0, sleep: async () => {} });
const confirm = { elicit: async () => 'confirmed' };

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A: WriteGate
// ═════════════════════════════════════════════════════════════════════════════

{
  // Default construction: real clock, default options object, first write ok
  const g0 = new WriteGate();
  t('A1 default-clock gate allows a first write', g0.checkWrite('post').allowed === true);
  g0.recordWrite('post'); // bare call covers the default context parameter
  t('A2 bare recordWrite logs the audit line without sub/user', errLog.some(l => l.includes('WRITE: post (1/5 posts this hour)')));

  // Interval floor across kinds, waitSeconds surfaced
  let ts = 1_000_000;
  const g1 = new WriteGate({ now: () => ts });
  t('A3 fresh gate allows', g1.checkWrite('comment').allowed);
  g1.recordWrite('comment', { subreddit: 'x' }); // subreddit only
  t('A4 subreddit-only audit line', errLog.some(l => l.includes('WRITE: comment to r/x (1/30 comments this hour)')));
  const blocked = g1.checkWrite('post');
  t('A5 min interval blocks across kinds with waitSeconds', !blocked.allowed && blocked.waitSeconds === 15 && blocked.reason.includes('15s'));
  ts += 15000;
  t('A6 boundary: exactly 15s later is allowed', g1.checkWrite('post').allowed);
  g1.recordWrite('post', { actingUser: 'me' }); // actingUser only
  t('A7 actingUser-only audit line', errLog.some(l => l.includes('WRITE: post as u/me')));

  // Hourly caps per kind, oldest slot frees first
  ts = 1_000_000;
  const g2 = new WriteGate({ now: () => ts });
  for (let i = 0; i < 5; i++) { g2.recordWrite('post', { subreddit: 's', actingUser: 'u' }); ts += 16000; }
  const capped = g2.checkWrite('post');
  t('A8 post cap 5/hour blocks with wait', !capped.allowed && capped.reason.includes('5 posts per hour') && capped.waitSeconds > 0);
  t('A9 comment cap independent of post cap', g2.checkWrite('comment').allowed);
  ts += 3600_000;
  t('A10 slots free when the window slides', g2.checkWrite('post').allowed);
  for (let i = 0; i < 30; i++) { g2.recordWrite('comment'); ts += 16000; }
  t('A11 comment cap 30/hour blocks', !g2.checkWrite('comment').allowed && g2.checkWrite('post').allowed);

  // Env vars only tighten: caps use min(), interval uses max()
  process.env.REDDIT_BUDDY_MAX_POSTS_PER_HOUR = '2';
  process.env.REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR = '3';
  process.env.REDDIT_BUDDY_MIN_WRITE_INTERVAL_S = '60';
  ts = 1_000_000;
  const g3 = new WriteGate({ now: () => ts });
  g3.recordWrite('post'); ts += 61000;
  g3.recordWrite('post'); ts += 61000;
  t('A12 tighter env post cap honored', !g3.checkWrite('post').allowed);
  g3.recordWrite('comment'); ts += 20000;
  t('A13 tighter env interval honored past the 15s floor', !g3.checkWrite('comment').allowed);
  ts += 41000;
  g3.recordWrite('comment'); ts += 61000;
  g3.recordWrite('comment'); ts += 61000;
  t('A14 tighter env comment cap honored', !g3.checkWrite('comment').allowed);

  process.env.REDDIT_BUDDY_MAX_POSTS_PER_HOUR = '100';
  process.env.REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR = '500';
  process.env.REDDIT_BUDDY_MIN_WRITE_INTERVAL_S = '1';
  ts = 1_000_000;
  const g4 = new WriteGate({ now: () => ts });
  for (let i = 0; i < 5; i++) { g4.recordWrite('post'); ts += 16000; }
  t('A15 looser env post cap ignored (still 5)', !g4.checkWrite('post').allowed);
  for (let i = 0; i < 30; i++) { g4.recordWrite('comment'); ts += 16000; }
  t('A16 looser env comment cap ignored (still 30)', !g4.checkWrite('comment').allowed);
  g4.recordWrite('post'); ts += 2000; // hmm: post cap reached; recordWrite is unconditional by design
  t('A17 looser env interval ignored (still 15s)', !g4.checkWrite('comment').allowed);

  // Invalid env values mean "not set", never a crash or a zero cap
  process.env.REDDIT_BUDDY_MAX_POSTS_PER_HOUR = 'abc';
  process.env.REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR = '0';
  process.env.REDDIT_BUDDY_MIN_WRITE_INTERVAL_S = '-4';
  ts = 1_000_000;
  const g5 = new WriteGate({ now: () => ts });
  t('A18 invalid env values fall back to defaults', g5.checkWrite('post').allowed && g5.checkWrite('comment').allowed);
  g5.recordWrite('post'); ts += 15500;
  t('A19 default 15s interval with invalid env override', g5.checkWrite('post').allowed);
  delete process.env.REDDIT_BUDDY_MAX_POSTS_PER_HOUR;
  delete process.env.REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR;
  delete process.env.REDDIT_BUDDY_MIN_WRITE_INTERVAL_S;

  // Idempotency keys: normalization and windowed expiry
  ts = 1_000_000;
  const g6 = new WriteGate({ now: () => ts });
  const k1 = g6.makePostKey('Sub', 'self', 'Hello  World', 'the  body');
  const k2 = g6.makePostKey('/r/sub', 'SELF ', 'Hello World', 'the body');
  const kCase = g6.makePostKey('sub', 'self', 'hello world', 'the body');
  t('A20 post key normalizes sub, kind, whitespace but preserves case', k1 === k2 && kCase !== k1);
  t('A21 length-prefixed hashing separates ambiguous joins', g6.makePostKey('s', 'self', 'ab', 'c') !== g6.makePostKey('s', 'self', 'a', 'bc'));
  t('A22 miss before record', g6.findRecentSubmit(k1) === null);
  g6.recordSubmit(k1, { post_id: 'abc', url: 'https://r/x' });
  t('A23 hit inside the window', g6.findRecentSubmit(k2)?.post_id === 'abc');
  ts += 15 * 60 * 1000 + 1;
  t('A24 expiry after 15 minutes', g6.findRecentSubmit(k1) === null);

  const ck1 = g6.makeCommentKey('T3_abc ', 'nice  one');
  const ck2 = g6.makeCommentKey('t3_abc', 'nice one');
  g6.recordSubmit(ck1, { comment_id: 'c1', permalink: '/r/x/comments/a/b/c1/' });
  t('A25 comment key normalizes thing id case and whitespace', ck1 === ck2 && g6.findRecentSubmit(ck2)?.comment_id === 'c1');

  // Same-sub duplicate content guard
  ts = 1_000_000;
  const g7 = new WriteGate({ now: () => ts });
  t('A26 content miss before record', g7.findDuplicateContent('sub', 'T', 'B') === null);
  g7.recordContent('sub', 'My Title', 'My body', { post_id: 'xyz', url: 'u' });
  t('A27 same-sub duplicate found (case-insensitive sub)', g7.findDuplicateContent('SUB', 'My  Title', 'My body')?.post_id === 'xyz');
  t('A28 different sub is not a duplicate', g7.findDuplicateContent('other', 'My Title', 'My body') === null);
  ts += 15 * 60 * 1000 + 1;
  t('A29 content guard expires with the window', g7.findDuplicateContent('sub', 'My Title', 'My body') === null);

  // Validate-pass tracking
  ts = 1_000_000;
  const g8 = new WriteGate({ now: () => ts });
  const vk = g8.makePostKey('sub', 'self', 'title', 'body');
  t('A30 no validate pass before record', g8.hasRecentValidatePass(vk) === false);
  g8.recordValidatePass(vk);
  ts += 60000;
  g8.recordValidatePass(g8.makePostKey('sub', 'self', 'other', 'body')); // prune keeps the fresh one
  t('A31 validate pass inside window', g8.hasRecentValidatePass(vk) === true);
  ts += 15 * 60 * 1000 + 1;
  t('A32 validate pass expires', g8.hasRecentValidatePass(vk) === false);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B: write-errors
// ═════════════════════════════════════════════════════════════════════════════

{
  // RATELIMIT wait-time parsing
  const rl = mapWriteError([['RATELIMIT', 'you are doing that too much. try again in 9 minutes.', 'ratelimit']]);
  t('B1 RATELIMIT minutes parsed into waitMinutes and guidance', rl.code === 'RATELIMIT' && rl.waitMinutes === 9 && rl.retryable && rl.guidance.includes('9 minutes'));
  t('B2 singular minute has no plural s', mapWriteError([['RATELIMIT', 'try again in 1 minute.', null]]).guidance.includes('1 minute before'));
  t('B3 seconds round UP to at least a minute', mapWriteError([['RATELIMIT', 'take a break for 30 seconds', null]]).waitMinutes === 1);
  t('B4 90 seconds round to 2 minutes', mapWriteError([['RATELIMIT', 'wait 90 seconds please', null]]).waitMinutes === 2);
  const rlNone = mapWriteError([['RATELIMIT', 'you are doing that too much', null]]);
  t('B5 unparseable wait keeps default guidance, no waitMinutes', rlNone.waitMinutes === undefined && rlNone.guidance.includes('indicated time'));
  t('B6 zero minutes treated as unparseable', mapWriteError([['RATELIMIT', 'try again in 0 minutes', null]]).waitMinutes === undefined);
  t('B7 absurd huge wait treated as unparseable (parseInt overflow)', mapWriteError([['RATELIMIT', `try again in ${'9'.repeat(400)} minutes`, null]]).waitMinutes === undefined);
  t('B8 null RATELIMIT message tolerated', mapWriteError([['RATELIMIT', null, null]]).code === 'RATELIMIT');

  // The rest of the known table, with the plan's retryability semantics
  const as = mapWriteError([['ALREADY_SUB', 'already submitted', 'url']]);
  t('B9 ALREADY_SUB suggests resubmit: true', as.suggestResubmit === true && as.retryable && as.guidance.includes('resubmit'));
  const table = [
    ['SUBMIT_VALIDATION_FLAIR_REQUIRED', true, 'flair'],
    ['SUBREDDIT_NOTALLOWED', false, 'permitted'],
    ['NO_URL', true, 'URL'],
    ['BAD_URL', true, 'URL'],
    ['THREAD_LOCKED', false, 'locked'],
    ['TOO_OLD', false, 'archived'],
    ['DELETED_LINK', false, 'deleted'],
    ['DELETED_COMMENT', false, 'deleted'],
  ];
  t('B10 every plan-table triple maps with correct retryability and wording',
    table.every(([code, retryable, word]) => {
      const m = mapWriteError([[code, 'raw reddit text', 'field']]);
      return m.code === code && m.retryable === retryable && (m.message + m.guidance).includes(word) && !m.message.includes('raw reddit text');
    }));

  // Unknown-triple formatter: names type and field, never echoes message text
  const unk = mapWriteError([['WEIRD_FAILURE', 'internal secrets here', 'field_x']]);
  t('B11 unknown triple names type and field, withholds message', unk.code === 'WEIRD_FAILURE' && unk.message.includes('field_x') && !JSON.stringify(unk).includes('secrets') && unk.retryable === false);
  t('B12 empty triple list falls back to UNKNOWN', mapWriteError([]).code === 'UNKNOWN');
  t('B13 null type falls back to UNKNOWN', mapWriteError([[null, 'msg', null]]).code === 'UNKNOWN');
  t('B14 empty-string type falls back to UNKNOWN, null field omitted', !mapWriteError([['', 'msg', null]]).message.includes('field'));
  const second = mapWriteError([['NOT_IN_TABLE', 'x', null], ['TOO_OLD', 'archived', null]]);
  t('B15 known triple in second position wins over an unknown first', second.code === 'TOO_OLD');

  // WriteError carries the mapped object; empty guidance drops the suffix
  const we = new WriteError({ code: 'X', message: 'the message.', guidance: 'the guidance.', retryable: false });
  t('B16 WriteError message concatenates message and guidance', we.message === 'the message. the guidance.' && we.name === 'WriteError' && we.write.code === 'X');
  t('B17 WriteError with empty guidance is just the message', new WriteError({ code: 'X', message: 'only.', guidance: '', retryable: false }).message === 'only.');

  // HTTP mapping on write paths
  const h403 = mapWriteHttpError(403, 'secretsub');
  t('B18 403 names the sub, private/quarantined/banned, no read-path advice',
    h403 instanceof WriteError && h403.write.code === 'HTTP_403'
    && h403.message.includes('Cannot post to r/secretsub') && h403.message.includes('private, quarantined, or banned')
    && !h403.message.includes('r/programming'));
  t('B19 404 without a sub says "this subreddit"', mapWriteHttpError(404).message.includes('this subreddit'));
  t('B20 429 is retryable with wait guidance', mapWriteHttpError(429, 's').write.retryable === true);
  const h500 = mapWriteHttpError(500, 's');
  t('B21 5xx admits the write may have landed and forbids auto-retry', h500.write.code === 'HTTP_500' && h500.message.includes('may or may not') && h500.message.includes('not retried automatically'));
  t('B22 other statuses get the generic withheld-body message', mapWriteHttpError(418, 's').message.includes('withheld'));

  // Redaction: the known write-path leak shapes
  const dirty = [
    'x-amz-signature=deadbeef0123',
    '"policy":"eyJjb25kaXRpb25zIjpbXX0abcdefgh"',
    'websocket wss://k8s-ws.wss.redditmedia.com/link/abc?m=TOKENVALUE',
    '"websocket_url":"wss://ws.example/thing?m=OTHERTOKEN"',
    'Authorization: Bearer secret.bearer-token_value',
    '"access_token":"another-secret-token"',
  ].join(' ');
  const clean = redactWriteError(dirty);
  t('B23 amz signature scrubbed, label kept', !clean.includes('deadbeef0123') && clean.includes('x-amz-signature'));
  t('B24 policy blob scrubbed', !clean.includes('eyJjb25kaXRpb25z'));
  t('B25 websocket URLs scrubbed in both forms', !clean.includes('TOKENVALUE') && !clean.includes('OTHERTOKEN'));
  t('B26 bearer and access_token scrubbed', !clean.includes('secret.bearer-token_value') && !clean.includes('another-secret-token'));
  t('B27 redaction marks what it scrubbed', clean.includes('[REDACTED]'));
  t('B28 clean text passes through unchanged', redactWriteError('nothing secret here') === 'nothing secret here');

  // Unknown type/field are response text: only a short token shape is echoed
  const hostile = mapWriteError([['X'.repeat(120) + ' wss://ws.example/x?m=SNEAKYTOKEN', 'msg', 'bad field!']]);
  t('B29 oversized or non-token unknown type degrades to UNKNOWN', hostile.code === 'UNKNOWN' && !JSON.stringify(hostile).includes('SNEAKYTOKEN'));
  t('B30 non-token unknown field is omitted from the message', !hostile.message.includes('field'));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C: strict write validator, kind inference, schemas, URL parsing
// ═════════════════════════════════════════════════════════════════════════════

{
  const sub = writeSubredditName('test');
  const ok = (v) => sub.safeParse(v).success;
  const msg = (v) => { const r = sub.safeParse(v); return r.success ? '' : r.error.errors[0].message; };

  t('C1 real subreddits and u_ profiles accepted', ok('test') && ok('MachineLearning') && ok('ab') && ok('a'.repeat(21)) && ok('u_some-user') && ok('u_' + 'n'.repeat(20)));
  t('C2 r/ prefix and whitespace normalized away', sub.parse(' r/Test ') === 'Test' && sub.parse('/r/other') === 'other');
  t('C3 all and popular rejected with actionable message', !ok('all') && !ok('POPULAR') && msg('all').includes('browse aggregates'));
  t('C4 multireddits rejected', !ok('a+b') && msg('pics+aww').includes('Multireddits'));
  t('C5 over-length names rejected', !ok('a'.repeat(22)) && !ok('u_' + 'n'.repeat(21)) && !ok('a'));
  t('C6 traversal and injection strings rejected',
    !ok('../../etc/passwd') && !ok('test/extra') && !ok('test?raw_json=1') && !ok('test&x=1') && !ok('test%20x') && !ok('sub reddit') && !ok('sub;rm') && !ok(''));

  // Kind inference: every row of the plan 2.1 table
  const kindOf = (p) => { try { return inferPostKind(p); } catch (e) { return 'err:' + e.message; } };
  t('C7 body only is self', kindOf({ body_markdown: 'b' }) === 'self');
  t('C8 neither body nor link is self (empty self post)', kindOf({}) === 'self');
  t('C9 link only is link', kindOf({ link_url: 'https://x.com' }) === 'link');
  t('C10 link plus body is a named error', kindOf({ link_url: 'https://x.com', body_markdown: 'b' }).includes('link posts carry no body'));
  t('C11 media is a v1.3.0 rejection', kindOf({ media: [] }).includes('v1.3.0'));
  t('C12 media wins over combo errors (version error first)', kindOf({ media: [{}], link_url: 'https://x.com', body_markdown: 'b' }).includes('v1.3.0'));
  t('C13 poster_path is a v1.3.0 rejection', kindOf({ poster_path: '/x.png' }).includes('v1.3.0') && kindOf({ poster_path: '/x.png', body_markdown: 'b' }).includes('v1.3.0'));

  // create_post schema bounds and defaults
  const base = { subreddit: 'test', title: 't' };
  t('C14 title bounds 1..300', createPostSchema.safeParse({ subreddit: 'test', title: 'x'.repeat(300) }).success
    && !createPostSchema.safeParse({ subreddit: 'test', title: 'x'.repeat(301) }).success
    && !createPostSchema.safeParse({ subreddit: 'test', title: '   ' }).success);
  t('C15 link_url must be full http(s)', createPostSchema.safeParse({ ...base, link_url: 'http://x.com/a' }).success
    && createPostSchema.safeParse({ ...base, link_url: 'https://x.com/a' }).success
    && !createPostSchema.safeParse({ ...base, link_url: 'ftp://x.com/a' }).success
    && !createPostSchema.safeParse({ ...base, link_url: 'not a url' }).success);
  const parsed = createPostSchema.parse(base);
  t('C16 defaults: resubmit false, send_replies true, validate_only false', parsed.resubmit === false && parsed.send_replies === true && parsed.validate_only === false);
  t('C17 media passes the schema (rejected later by kind inference, not silently stripped)', createPostSchema.safeParse({ ...base, media: [{ name: 'x', path: '/x' }] }).success);
  t('C18 subreddit_rules uses the strict validator', !subredditRulesSchema.safeParse({ subreddit: 'all' }).success && subredditRulesSchema.safeParse({ subreddit: 'test' }).success);
  t('C19 add_comment text must be non-empty', !addCommentSchema.safeParse({ post_id: 'abc12', text: ' ' }).success && addCommentSchema.safeParse({ post_id: 'abc12', text: 'hi' }).success);
  t('C19b add_comment text is NOT trimmed (indented code blocks stay intact)',
    addCommentSchema.parse({ post_id: 'abc12', text: '    indented code\nsecond line' }).text === '    indented code\nsecond line');

  // Comment target resolution
  const res = (p) => { try { return resolveCommentTarget(p); } catch (e) { return 'err:' + e.message; } };
  t('C20 post_id resolves to t3_ with prefix stripped case-insensitively',
    res({ post_id: '1abc2' }).thingId === 't3_1abc2' && res({ post_id: 'T3_1abc2' }).thingId === 't3_1abc2' && res({ post_id: '1abc2' }).postId === '1abc2');
  t('C21 comment_id resolves to t1_', res({ comment_id: 'def45' }).thingId === 't1_def45' && res({ comment_id: 't1_def45' }).thingId === 't1_def45');
  t('C22 zero targets is a clear error', String(res({})).includes('exactly one'));
  t('C23 two targets is a clear error naming both', String(res({ post_id: 'a1', comment_id: 'b2' })).includes('post_id and comment_id'));
  t('C24 three targets rejected too', String(res({ post_id: 'a1', comment_id: 'b2', url: 'https://reddit.com/comments/c3' })).includes('exactly ONE'));
  t('C25 invalid ids rejected with the offending value', String(res({ post_id: '!!' })).includes('Invalid post_id') && String(res({ comment_id: 'x'.repeat(14) })).includes('Invalid comment_id'));

  // URL parsing: post id AND optional trailing comment id
  const u1 = parseCommentUrl('https://www.reddit.com/r/test/comments/1abc2/some_slug/xyz78/?context=3#top');
  t('C26 comment URL captures post, comment, and sub', u1.thingId === 't1_xyz78' && u1.postId === '1abc2' && u1.subreddit === 'test');
  const u2 = parseCommentUrl('https://old.reddit.com/r/test/comments/1abc2/some_slug/');
  t('C27 post URL without comment id targets the post', u2.thingId === 't3_1abc2' && u2.postId === '1abc2');
  const u3 = parseCommentUrl('reddit.com/comments/1abc2');
  t('C28 bare comments URL works, subreddit unknown', u3.thingId === 't3_1abc2' && u3.subreddit === undefined);
  const u4 = parseCommentUrl('https://www.reddit.com/user/some-user/comments/1abc2/title/');
  t('C29 profile-post URL maps to the u_ subreddit', u4.thingId === 't3_1abc2' && u4.subreddit === 'u_some-user');
  const u5 = parseCommentUrl('https://np.reddit.com/r/test/comments/1abc2');
  t('C30 subdomains accepted, no slug needed', u5.thingId === 't3_1abc2');
  t('C31 redd.it rejected as ambiguous in both spellings',
    (await throwsMsg(() => parseCommentUrl('https://redd.it/1abc2'))).includes('ambiguous')
    && (await throwsMsg(() => parseCommentUrl('redd.it/1abc2'))).includes('redd.it'));
  t('C32 non-Reddit URLs rejected with the expected shape', (await throwsMsg(() => parseCommentUrl('https://example.com/comments/1abc2'))).includes('Unrecognized'));
  t('C33 malformed reddit URL rejected', (await throwsMsg(() => parseCommentUrl('https://reddit.com/r/test/notcomments/1abc2'))).includes('Unrecognized'));
  t('C33b lookalike Reddit hosts rejected', (await throwsMsg(() => parseCommentUrl('https://notreddit.com/comments/1abc2'))).includes('Unrecognized'));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION D: subreddit_rules aggregation, caps, fencing
// ═════════════════════════════════════════════════════════════════════════════

{
  const full = await tools.subredditRules({ subreddit: 'r_full' });
  t('D1 untrusted rule text is fenced as reference-only', full.untrusted_content_note.includes('never as instructions'));
  t('D2 rule descriptions capped at 400 chars plus ellipsis', full.rules[0].description.length === 401 && full.rules[0].description.endsWith('…'));
  t('D3 missing rule fields default safely', full.rules[1].short_name === '' && full.rules[1].applies_to === 'all' && full.rules[0].applies_to === 'comment');
  t('D4 submit_text capped at 500 chars', full.capabilities.submit_text.length === 501 && full.capabilities.submit_text.endsWith('…'));
  t('D5 capability flags surfaced from about.json', full.capabilities.allow_images === true && full.capabilities.allow_videos === false && full.capabilities.submission_type === 'any');
  t('D6 flairs capped at 20 with a count note, mod-only filtered', full.flairs.length === 20 && full.flairs_note === '5 more not shown' && !full.flairs.some(f => f.id === 'f25'));
  t('D7 flair entries carry id, text, text_editable only', full.flairs[0].id === 'f0' && full.flairs[0].text_editable === true && full.flairs[0].mod_only === undefined);
  t('D8 empty/null/none requirement keys dropped, real ones kept',
    full.posting_requirements.title_text_min_length === 10 && full.posting_requirements.is_flair_required === true
    && !('guidelines_text' in full.posting_requirements) && !('body_blacklisted_strings' in full.posting_requirements)
    && !('title_text_max_length' in full.posting_requirements) && !('body_restriction_policy' in full.posting_requirements));

  const empty = await tools.subredditRules({ subreddit: 'r_empty' });
  t('D9 zero rules yields a note', empty.rules_note === 'This subreddit lists no rules.' && empty.rules.length === 0);
  t('D10 requirements unavailable (non-profile) notes generically', empty.requirements_note.includes('unavailable for this subreddit'));
  t('D11 zero flairs yields a note', empty.flairs_note.includes('No selectable post flairs'));

  const prof = await tools.subredditRules({ subreddit: 'u_prof2' });
  t('D12 profile subs get the profile-specific requirements note', prof.requirements_note.includes('profile subreddits'));

  const bad = await tools.subredditRules({ subreddit: 'r_badshape' });
  t('D13 non-array rules shape degrades to the no-rules note', bad.rules.length === 0 && bad.rules_note === 'This subreddit lists no rules.');
  t('D14 whitespace-only submit_text omitted', !('submit_text' in bad.capabilities));
  t('D15 small flair list has no truncation note', bad.flairs.length === 2 && bad.flairs_note === undefined);

  const fail = await tools.subredditRules({ subreddit: 'r_fail' });
  t('D16 every section degrades independently on read failure',
    fail.rules_note.includes('unavailable') && fail.requirements_note.includes('read failed')
    && fail.capabilities_note.includes('about read failed') && fail.flairs_note.includes('flair read failed'));

  const nodata = await tools.subredditRules({ subreddit: 'r_nodata' });
  t('D17 about body without data yields neither capabilities nor a note', nodata.capabilities === undefined && nodata.capabilities_note === undefined && nodata.rules.length === 1);

  const denied = await throwsMsg(() => tools.subredditRules({ subreddit: 'privrules' }));
  t('D18 total inaccessibility throws the private/quarantined/banned error', denied.includes('Cannot access r/privrules'));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E: create_post preflight (validate_only, zero write calls)
// ═════════════════════════════════════════════════════════════════════════════

{
  const dryFails = async (params) => throwsMsg(() => tools.createPost(params));

  // Kind vs submission_type, both directions
  t('E1 self-only sub rejects link posts', (await dryFails({ subreddit: 'selfonly', title: 'title', link_url: 'https://x.com/a', validate_only: true })).includes('only allows self'));
  t('E2 link-only sub rejects self posts', (await dryFails({ subreddit: 'linkonly', title: 'title', body_markdown: 'b', validate_only: true })).includes('only allows link'));

  // Title checks from post_requirements
  t('E3 title below min length rejected', (await dryFails({ subreddit: 'titlerules', title: 'abcd', validate_only: true })).includes('at least 5'));
  t('E4 title above sub max rejected', (await dryFails({ subreddit: 'titlerules', title: '[' + 'x'.repeat(25), validate_only: true })).includes('caps titles at 20'));
  t('E5 banned title string rejected', (await dryFails({ subreddit: 'titlerules', title: '[Tag] SPAM here', validate_only: true })).includes('bans "spam"'));
  t('E6 required title strings enforced as one-of', (await dryFails({ subreddit: 'titlerules', title: '[plain title]', validate_only: true })).includes('include one of'));
  t('E7 title regex enforced, uncompilable sub regex skipped', (await dryFails({ subreddit: 'titlerules', title: 'has Tag inside', validate_only: true })).includes('match: ^\\['));
  const okTitle = await tools.createPost({ subreddit: 'titlerules', title: '[Tag] fine', validate_only: true });
  t('E8 compliant title passes all title checks', okTitle.valid === true && okTitle.checked.some(c => c.includes('title')));

  // Body policy
  t('E9 body required but empty rejected', (await dryFails({ subreddit: 'bodyreq', title: 'title', validate_only: true })).includes('requires a post body'));
  t('E10 body not allowed but present rejected', (await dryFails({ subreddit: 'nobody', title: 'title', body_markdown: 'b', validate_only: true })).includes('does not allow body text'));
  t('E11 title-only post passes a notAllowed body policy', (await tools.createPost({ subreddit: 'nobody', title: 'title', validate_only: true })).valid === true);

  // Domain lists (suffix matching, non-string entries ignored)
  t('E12 blacklisted domain rejected including subdomains', (await dryFails({ subreddit: 'linkonly', title: 'title', link_url: 'https://cdn.badsite.com/x', validate_only: true })).includes('badsite.com'));
  t('E13 whitelist miss rejected, listing allowed domains', (await dryFails({ subreddit: 'whitelist', title: 'title', link_url: 'https://elsewhere.com/x', validate_only: true })).includes('only allows links to: ok.com'));
  t('E14 whitelist hit passes (exact host and subdomain)',
    (await tools.createPost({ subreddit: 'whitelist', title: 'title', link_url: 'https://ok.com/x', validate_only: true })).valid === true
    && (await tools.createPost({ subreddit: 'whitelist', title: 'title', link_url: 'https://a.ok.com/x', validate_only: true })).valid === true);
  t('E15 unparseable link_url (schema bypassed) still fails safe', (await dryFails({ subreddit: 'whitelist', title: 'title', link_url: 'notaurl', validate_only: true })).includes('not a parseable URL'));

  // Flair requirement embeds the choices
  const flairErr = await dryFails({ subreddit: 'flairreq', title: 'title', body_markdown: 'b', validate_only: true });
  t('E16 flair-required error embeds selectable choices, not mod flairs', flairErr.includes('requires a post flair') && flairErr.includes('f1 ("News")') && !flairErr.includes('fmod'));
  t('E17 flair choices unavailable falls back to naming subreddit_rules', (await dryFails({ subreddit: 'flairfail', title: 'title', body_markdown: 'b', validate_only: true })).includes('Call subreddit_rules'));
  t('E18 flair_id satisfies the requirement', (await tools.createPost({ subreddit: 'flairreq', title: 'title', body_markdown: 'b', flair_id: 'f1', validate_only: true })).valid === true);

  // Unavailable data lands in not_checked, never a false pass or false fail
  const profDry = await tools.createPost({ subreddit: 'u_someone', title: 'title', body_markdown: 'b', validate_only: true });
  t('E19 profile sub: requirements unavailable is not_checked', profDry.valid === true && profDry.not_checked.some(s => s.includes('posting requirements')));
  const aboutFailDry = await tools.createPost({ subreddit: 'aboutfail', title: 'title', body_markdown: 'b', validate_only: true });
  t('E20 about read failure lands in not_checked', aboutFailDry.valid === true && aboutFailDry.not_checked.some(s => s.includes('capability flags')));
  const reqFailDry = await tools.createPost({ subreddit: 'reqfail', title: 'title', body_markdown: 'b', validate_only: true });
  t('E20b requirements read failure degrades to not_checked, never a false fail', reqFailDry.valid === true && reqFailDry.not_checked.some(s => s.includes('posting requirements')));
  t('E21 subjective rules always in not_checked', profDry.not_checked.some(s => s.includes('subjective')));

  // Write-path 403/404 on the sub
  t('E22 private sub gets the write-path error, not read advice', (await dryFails({ subreddit: 'privsub', title: 'title', validate_only: true })).includes('Cannot post to r/privsub'));
  t('E23 missing sub 404 same treatment', (await dryFails({ subreddit: 'gonesub', title: 'title', validate_only: true })).includes('Cannot post to r/gonesub'));

  // Restricted posting warns (cannot be verified for this account)
  const restrictedDry = await tools.createPost({ subreddit: 'restricted', title: 'title', body_markdown: 'b', validate_only: true });
  t('E24 restrict_posting surfaces a warning in the dry run', restrictedDry.warnings.some(w => w.includes('approved users only')));

  // Bounded title-regex evaluation: mod-authored patterns can be hostile, so
  // none may hang the event loop; unsafe ones degrade to warnings.
  const redosStart = Date.now();
  const redosDry = await tools.createPost({ subreddit: 'redos', title: 'a'.repeat(40) + 'b', body_markdown: 'b', validate_only: true });
  t('E28 catastrophic title regex times out into a warning, never a hang',
    Date.now() - redosStart < 5000 && redosDry.valid === true && redosDry.warnings.some(w => w.includes('timed out')));
  const longDry = await tools.createPost({ subreddit: 'longregex', title: 'a plain title', body_markdown: 'b', validate_only: true });
  t('E29 overlong title regex is skipped with a warning', longDry.valid === true && longDry.warnings.some(w => w.includes('too long to evaluate safely')));
  const manyDry = await tools.createPost({ subreddit: 'manyregex', title: 'Tag title', body_markdown: 'b', validate_only: true });
  t('E30 only the first 10 title regexes are evaluated', manyDry.valid === true && manyDry.warnings.some(w => w.includes('only the first 10')));
  t('E31 safeRegexTest: match, no-match, and deadline results',
    safeRegexTest(/^tag/i, 'Tag title') === true
    && safeRegexTest(/^\[Tag\]/i, 'nope') === false
    && safeRegexTest(/^(a+)+$/i, 'a'.repeat(40) + 'b') === null);

  // validate_only mechanics
  t('E25 validate_only made ZERO write-path calls', submitCalls === 0 && commentCalls === 0);
  t('E26 dry-run response lists checked and not_checked and says nothing was posted', okTitle.note.includes('Nothing was posted') && okTitle.checked.length > 0);
  const vkey = gate.makeConfirmationKey(JSON.stringify({ subreddit: 'titlerules', kind: 'self', title: '[Tag] fine' }));
  t('E27 validate_only recorded a validate pass (arms the fallback confirm)', gate.hasRecentValidatePass(vkey) === true);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION F: create_post submit flow (confirmation, verify, dedupe, invalidation)
// ═════════════════════════════════════════════════════════════════════════════

{
  // Declined elicitation sends nothing
  const declined = await throwsMsg(() => tools.createPost({ subreddit: 'anysub', title: 'Declined', body_markdown: 'b' }, { elicit: async () => 'declined' }));
  t('F1 declined confirmation aborts with nothing sent', declined.includes('declined') && submitCalls === 0);

  // Confirmed submit: form contents, response shape, cache invalidation
  cache.set(CacheManager.createKey('subreddit', 'anysub', 'hot', 25), { stale: true });
  cache.set(CacheManager.createKey('user-posts', 'testuser', 'submitted', 'new'), { stale: true });
  cache.set(CacheManager.createKey('user-posts', 'testuser', 'comments', 'new'), { keep: true });
  const rulesKey = CacheManager.createKey('rules', 'anysub', 'about');
  let elicitMsg = '';
  const live = await tools.createPost(
    { subreddit: 'anysub', title: 'Hello World', body_markdown: 'S3CR3T-BODY '.repeat(30), nsfw: true, spoiler: false, send_replies: true, resubmit: false },
    { elicit: async (m) => { elicitMsg = m; return 'confirmed'; } }
  );
  const form = new URLSearchParams(lastSubmitBody);
  t('F2 confirmed submit posts once with api_type=json and full form', submitCalls === 1
    && form.get('api_type') === 'json' && form.get('sr') === 'anysub' && form.get('kind') === 'self'
    && form.get('title') === 'Hello World' && form.get('nsfw') === 'true' && form.get('spoiler') === 'false'
    && form.get('sendreplies') === 'true' && form.get('resubmit') === 'false');
  t('F3 elicit message names sub, acting user, title, and previews the body', elicitMsg.includes('r/anysub') && elicitMsg.includes('u/testuser') && elicitMsg.includes('Hello World') && elicitMsg.includes('S3CR3T-BODY') && elicitMsg.includes('…'));
  t('F4 live response shape: id, url, kind, acting_user, status', live.post_id === 'p1' && live.url.includes('/comments/p1/') && live.kind === 'self' && live.acting_user === 'testuser' && live.status === 'live');
  t('F5 clean live post carries no warnings field', live.warnings === undefined);
  t('F6 response never echoes the body', !JSON.stringify(live).includes('S3CR3T-BODY'));
  t('F7 subreddit and own-submissions caches invalidated, others kept',
    cache.get(CacheManager.createKey('subreddit', 'anysub', 'hot', 25)) === null
    && cache.get(CacheManager.createKey('user-posts', 'testuser', 'submitted', 'new')) === null
    && cache.get(CacheManager.createKey('user-posts', 'testuser', 'comments', 'new')) !== null
    && cache.get(rulesKey) !== null);
  t('F8 the write hit the stderr audit log', errLog.some(l => l.includes('WRITE: post to r/anysub as u/testuser')));

  // Idempotent replay of the identical call (no confirmation, no submit)
  const replay = await tools.createPost({ subreddit: 'anysub', title: 'Hello  World', body_markdown: 'S3CR3T-BODY '.repeat(30) });
  t('F9 identical retry replays the stored result without posting', replay.post_id === 'p1' && replay.status === 'unverified' && replay.warnings[0].includes('already posted') && submitCalls === 1);

  // Same-sub duplicate content via a DIFFERENT idempotency key: a self post
  // whose body is a URL, retried as a link post with that URL, is the same
  // content even though kind (and thus the idempotency key) changed.
  tick();
  await tools.createPost({ subreddit: 'anysub', title: 'Same Link', body_markdown: 'https://dup.example/x' }, confirm);
  const submitsAfterSelf = submitCalls;
  const dupLink = await tools.createPost({ subreddit: 'anysub', title: 'Same Link', link_url: 'https://dup.example/x' }, confirm);
  t('F10 same-sub duplicate content returns the stored post instead of re-posting', dupLink.post_id === 'p1' && submitCalls === submitsAfterSelf && dupLink.warnings[0].includes('already posted'));

  // Rate floor through the tool: min interval, then the hourly cap
  const tooFast = await throwsMsg(() => tools.createPost({ subreddit: 'anysub', title: 'Too fast', body_markdown: 'b' }, confirm));
  t('F11 min interval blocks an immediate second post', tooFast.includes('interval') && tooFast.includes('Wait about'));
  {
    const capGate = new WriteGate({ now: () => now });
    const capTools = new RedditWriteTools({ api, gate: capGate, cache, actingUser: 'testuser', verifyDelayMs: 0, sleep: async () => {} });
    for (let i = 0; i < 5; i++) { tick(); await capTools.createPost({ subreddit: 'anysub', title: `Cap post ${i}`, body_markdown: 'b' }, confirm); }
    tick();
    const capped = await throwsMsg(() => capTools.createPost({ subreddit: 'anysub', title: 'Cap post 6', body_markdown: 'b' }, confirm));
    t('F12 hourly post cap enforced through the tool', capped.includes('5 posts per hour'));
  }

  // Link post: form shape, elicit label, live status
  tick();
  let linkMsg = '';
  const linkRes = await tools.createPost({ subreddit: 'whitelist', title: 'A link', link_url: 'https://ok.com/page' }, { elicit: async (m) => { linkMsg = m; return 'confirmed'; } });
  const linkForm = new URLSearchParams(lastSubmitBody);
  t('F13 link submit sends url and kind=link, no text field', linkForm.get('kind') === 'link' && linkForm.get('url') === 'https://ok.com/page' && linkForm.get('text') === null);
  t('F14 elicit message labels the URL as Link', linkMsg.includes('Link: https://ok.com/page') && linkRes.kind === 'link');

  // Empty self post: '(empty)' preview branch, absent optional form fields
  tick();
  let emptyMsg = '';
  await tools.createPost({ subreddit: 'anysub', title: 'Just a title' }, { elicit: async (m) => { emptyMsg = m; return 'confirmed'; } });
  const emptyForm = new URLSearchParams(lastSubmitBody);
  t('F15 empty body previews as (empty), optional fields left off the form', emptyMsg.includes('(empty)') && emptyForm.get('text') === null && emptyForm.get('nsfw') === null && emptyForm.get('flair_id') === null);

  // Verify-after-submit: filtered, vanished, unverified, and live-with-warnings
  // (jump an hour first so the 5-posts cap window from the posts above resets)
  tick(3600_000); infoMode = 'removed';
  const removed = await tools.createPost({ subreddit: 'anysub', title: 'Filtered post', body_markdown: 'b' }, confirm);
  t('F16 removed_by_category yields status filtered plus warning', removed.status === 'filtered' && removed.warnings.some(w => w.includes('automod_filtered')));
  tick(); infoMode = 'gone';
  const gone = await tools.createPost({ subreddit: 'anysub', title: 'Vanished post', body_markdown: 'b' }, confirm);
  t('F17 post invisible on verify yields status filtered', gone.status === 'filtered' && gone.warnings.some(w => w.includes('not visible')));
  tick(); infoMode = 'fail';
  const unverified = await tools.createPost({ subreddit: 'anysub', title: 'Unverified post', body_markdown: 'b' }, confirm);
  t('F18 verify read failure yields status unverified plus warning', unverified.status === 'unverified' && unverified.warnings.some(w => w.includes('verification read failed')));
  infoMode = 'live';
  tick();
  const warnedLive = await tools.createPost({ subreddit: 'restricted', title: 'Warned live', body_markdown: 'b' }, confirm);
  t('F19 preflight warnings survive onto a live response', warnedLive.status === 'live' && warnedLive.warnings.some(w => w.includes('approved users only')));

  // Enforced dry-run fallback for clients without elicitation
  // (fresh hourly window again: the verify tests above used four post slots)
  tick(3600_000);
  const before = submitCalls;
  const first = await tools.createPost({ subreddit: 'anysub', title: 'Fallback post', body_markdown: 'fallback body' });
  const afterFirst = submitCalls;
  const second = await tools.createPost({ subreddit: 'anysub', title: 'Fallback post', body_markdown: 'fallback body' });
  t('F20 first no-elicit call returns confirmation_required and sends nothing',
    first.status === 'confirmation_required' && afterFirst === before
    && first.would_post.subreddit === 'anysub' && first.would_post.title === 'Fallback post' && first.note.includes('re-issue'));
  t('F21 identical second call proceeds (exactly one submit)', second.post_id === 'p1' && submitCalls === before + 1);
  tick();
  await tools.createPost({ subreddit: 'anysub', title: 'Prevalidated', body_markdown: 'pv', validate_only: true });
  const afterValidate = await tools.createPost({ subreddit: 'anysub', title: 'Prevalidated', body_markdown: 'pv' });
  t('F22 a validate_only pass arms the no-elicit submit directly', afterValidate.post_id === 'p1');

  tick(3600_000);
  const pending = { subreddit: 'anysub', title: 'Complete payload', body_markdown: 'first\nsecond', nsfw: false, spoiler: false, flair_id: 'f1', flair_text: 'old', resubmit: false, send_replies: true };
  await tools.createPost({ ...pending, validate_only: true });
  const writesBeforeChanges = submitCalls;
  for (const change of [{ nsfw: true }, { spoiler: true }, { flair_id: 'f2' }, { flair_text: 'new' }, { resubmit: true }, { send_replies: false }, { body_markdown: 'first second' }]) {
    const changed = await tools.createPost({ ...pending, ...change });
    t(`F25 changed payload needs another preview: ${Object.keys(change)[0]}`, changed.status === 'confirmation_required' && submitCalls === writesBeforeChanges);
  }
  const shown = await tools.createPost({ ...pending, title: 'Options preview' });
  t('F26 fallback preview exposes every option', shown.would_post.options.nsfw === false && shown.would_post.options.spoiler === false && shown.would_post.options.flair_id === 'f1' && shown.would_post.options.flair_text === 'old' && shown.would_post.options.resubmit === false && shown.would_post.options.send_replies === true);
  const identical = await tools.createPost(pending);
  t('F27 unchanged validated payload submits once', identical.post_id === 'p1' && submitCalls === writesBeforeChanges + 1);
  t('F28 elicitation includes options and full length', elicitMsg.includes('"nsfw":true') && elicitMsg.includes('"spoiler":false') && elicitMsg.includes('Full content length:'));

  // Default sleep and default verify delay: a real (1 ms) timer-based verify
  {
    let ts2 = now + 10 * 60_000;
    const g = new WriteGate({ now: () => ts2 });
    const defSleepTools = new RedditWriteTools({ api, gate: g, cache, actingUser: 'testuser', verifyDelayMs: 1 });
    const res = await defSleepTools.createPost({ subreddit: 'anysub', title: 'Default sleep', body_markdown: 'b' }, confirm);
    t('F23 default timer-based sleep verifies without an injected clock', res.status === 'live');
    const defaults = new RedditWriteTools({ api, gate: g, cache, actingUser: 'testuser' });
    t('F24 default verify delay is 2000 ms (never used in tests)', defaults.verifyDelayMs === 2000);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION G: add_comment flow
// ═════════════════════════════════════════════════════════════════════════════

{
  // Declined elicitation sends nothing (tick first: the rate floor is checked
  // before the confirmation gate, and section F just wrote)
  tick();
  const commentsBefore = commentCalls;
  const declined = await throwsMsg(() => tools.addComment({ post_id: 'p1', text: 'nope' }, { elicit: async () => 'declined' }));
  t('G1 declined comment confirmation sends nothing', declined.includes('declined') && commentCalls === commentsBefore);

  // Top-level comment by post id: permalink-derived cache invalidation
  tick();
  cache.set(CacheManager.createKey('post', 'anysub', 'p1', 'best'), { stale: true });
  cache.set(CacheManager.createKey('user-posts', 'testuser', 'comments', 'new'), { stale: true });
  let commentElicitMsg = '';
  const top = await tools.addComment({ post_id: 'p1', text: 'nice take' }, { elicit: async (m) => { commentElicitMsg = m; return 'confirmed'; } });
  t('G2 top-level comment posts and returns permalink + acting_user', top.comment_id === 'c9' && top.permalink === 'https://reddit.com/r/anysub/comments/p1/t/c9/' && top.acting_user === 'testuser');
  t('G3 elicit message labels a top-level comment on the post', commentElicitMsg.includes('comment on post t3_p1') && commentElicitMsg.includes('u/testuser'));
  t('G4 parent post and own-comments caches invalidated via the returned permalink',
    cache.get(CacheManager.createKey('post', 'anysub', 'p1', 'best')) === null
    && cache.get(CacheManager.createKey('user-posts', 'testuser', 'comments', 'new')) === null);
  t('G5 comment audit line logged', errLog.some(l => l.includes('WRITE: comment')));

  // Idempotent replay
  const replay = await tools.addComment({ post_id: 'p1', text: 'nice  take' });
  t('G6 identical comment replays without posting again', replay.comment_id === 'c9' && replay.permalink.includes('/c9/') && replay.warnings[0].includes('already submitted') && commentCalls === commentsBefore + 1);

  // Reply to a comment: t1_ target and the reply label
  tick();
  let replyMsg = '';
  const reply = await tools.addComment({ comment_id: 'c9', text: 'replying' }, { elicit: async (m) => { replyMsg = m; return 'confirmed'; } });
  t('G7 reply targets t1_ and says so in the confirmation', reply.comment_id === 'c9' && replyMsg.includes('reply to comment t1_c9'));

  // URL target carrying the subreddit: invalidation uses the URL context
  tick();
  cache.set(CacheManager.createKey('post', 'anysub', 'p1', 'top'), { stale: true });
  const viaUrl = await tools.addComment({ url: 'https://www.reddit.com/r/anysub/comments/p1/slug/' , text: 'via url' }, confirm);
  t('G8 URL-targeted comment invalidates the named post cache', viaUrl.comment_id === 'c9' && cache.get(CacheManager.createKey('post', 'anysub', 'p1', 'top')) === null);

  // Profile-post permalink (no /r/ shape): warns that invalidation was skipped
  tick(); commentMode = 'userperm';
  const prof = await tools.addComment({ post_id: 'pp1', text: 'profile comment' }, confirm);
  t('G9 unparseable permalink warns about stale post cache', prof.warnings.some(w => w.includes('cache invalidation')));

  // Missing permalink: stored replay has no permalink to offer
  tick(); commentMode = 'noperm';
  await tools.addComment({ post_id: 'p1', text: 'no permalink' }, confirm);
  const noPermReplay = await tools.addComment({ post_id: 'p1', text: 'no permalink' });
  t('G10 replay without a stored permalink omits it', noPermReplay.comment_id === 'c9' && noPermReplay.permalink === undefined);
  commentMode = 'normal';

  // Mapped write errors from the comment endpoint
  tick(); commentMode = 'error'; commentErrors = [['THREAD_LOCKED', 'locked', 'parent']];
  t('G11 locked thread surfaces the mapped stop guidance', (await throwsMsg(() => tools.addComment({ post_id: 'p1', text: 'hi' }, confirm))).includes('locked'));
  commentMode = 'normal'; commentErrors = null;

  // Rate floor: min interval between comments through the tool
  tick();
  await tools.addComment({ post_id: 'p1', text: 'first of two' }, confirm);
  const tooFast = await throwsMsg(() => tools.addComment({ post_id: 'p1', text: 'second too soon' }, confirm));
  t('G12 min interval applies to comments too', tooFast.includes('interval'));

  tick();
  const beforeWhitespace = commentCalls;
  await tools.addComment({ post_id: 'p1', text: 'code\n    indented' });
  const changedWhitespace = await tools.addComment({ post_id: 'p1', text: 'code indented' });
  t('G12b markdown whitespace changes require another preview', changedWhitespace.status === 'confirmation_required' && commentCalls === beforeWhitespace);

  // Two-call confirm fallback for comments (no validate_only exists for them)
  tick();
  const cBefore = commentCalls;
  const first = await tools.addComment({ post_id: 'p1', text: 'fallback comment' });
  const afterFirst = commentCalls;
  const second = await tools.addComment({ post_id: 'p1', text: 'fallback comment' });
  t('G13 comment fallback: preview first, nothing sent', first.status === 'confirmation_required' && first.would_comment.target === 't3_p1' && afterFirst === cBefore);
  t('G14 identical second comment call proceeds once', second.comment_id === 'c9' && commentCalls === cBefore + 1);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION H: cross-sub duplicate warning + gate atomicity under concurrency
// ═════════════════════════════════════════════════════════════════════════════

{
  // Cross-sub content guard, directly on the gate
  let ts = 1_000_000;
  const g9 = new WriteGate({ now: () => ts });
  t('H1 cross-sub miss before record', g9.findCrossSubDuplicate('other', 'T', 'B') === null);
  g9.recordContent('SubA', 'My Title', 'My body', { post_id: 'xyz', url: 'https://r/suba/x' });
  const hit = g9.findCrossSubDuplicate('other', 'My  Title', 'My body');
  t('H2 same content in another sub is found with its origin', hit !== null && hit.subreddit === 'suba' && hit.result.post_id === 'xyz');
  t('H3 same sub is NOT a cross-sub hit (the blocking guard owns it)', g9.findCrossSubDuplicate('SUBA', 'My Title', 'My body') === null);
  ts += 15 * 60 * 1000 + 1;
  t('H4 cross-sub record expires with the window', g9.findCrossSubDuplicate('other', 'My Title', 'My body') === null);

  // Through the tool: cross-posted content proceeds with the RBP warning
  tick(3600_000);
  const xGate = new WriteGate({ now: () => now });
  const xTools = new RedditWriteTools({ api, gate: xGate, cache, actingUser: 'testuser', verifyDelayMs: 0, sleep: async () => {} });
  await xTools.createPost({ subreddit: 'anysub', title: 'Cross Sub Content', body_markdown: 'xbody' }, confirm);
  tick();
  const sBefore = submitCalls;
  const crossed = await xTools.createPost({ subreddit: 'whitelist', title: 'Cross Sub Content', body_markdown: 'xbody' }, confirm);
  t('H5 cross-sub duplicate still posts (deliberate cross-posting is legitimate)', crossed.post_id === 'p1' && submitCalls === sBefore + 1);
  t('H6 and carries the RBP warning naming the earlier post', crossed.warnings.some(w => w.includes('r/anysub') && w.includes('Responsible Builder Policy') && w.includes('/comments/p1/')));

  // Concurrency: the gate checks and their records must be atomic under
  // parallel tool calls, or the floor and the dedupe guards are bypassable
  tick();
  const cGate = new WriteGate({ now: () => now });
  const cTools = new RedditWriteTools({ api, gate: cGate, cache, actingUser: 'testuser', verifyDelayMs: 0, sleep: async () => {} });
  const pBefore = submitCalls;
  const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    cTools.createPost({ subreddit: 'anysub', title: `Concurrent ${i}`, body_markdown: 'b' }, confirm)));
  t('H7 8 concurrent distinct posts submit exactly once', submitCalls === pBefore + 1 && burst.filter(r => r.status === 'fulfilled').length === 1);
  t('H8 the other 7 are blocked by the write floor', burst.filter(r => r.status === 'rejected').length === 7
    && burst.filter(r => r.status === 'rejected').every(r => r.reason.message.includes('interval')));

  tick();
  let raceElicits = 0;
  const raceConfirm = { elicit: async () => { raceElicits++; return 'confirmed'; } };
  const rBefore = submitCalls;
  const [ra, rb] = await Promise.all([
    cTools.createPost({ subreddit: 'anysub', title: 'Race post', body_markdown: 'rb' }, raceConfirm),
    cTools.createPost({ subreddit: 'anysub', title: 'Race post', body_markdown: 'rb' }, raceConfirm),
  ]);
  t('H9 concurrent identical posts submit once, confirm once, share the result',
    submitCalls === rBefore + 1 && ra.post_id === 'p1' && rb.post_id === 'p1' && raceElicits === 1);

  tick();
  const ccBefore = commentCalls;
  const pair = await Promise.allSettled([
    cTools.addComment({ post_id: 'p1', text: 'concurrent comment one' }, confirm),
    cTools.addComment({ post_id: 'p1', text: 'concurrent comment two' }, confirm),
  ]);
  t('H10 concurrent distinct comments: one lands, one is floored', commentCalls === ccBefore + 1
    && pair[0].status === 'fulfilled' && pair[1].status === 'rejected' && pair[1].reason.message.includes('interval'));
}

// ═════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════════════════

const total = passCount + failures.length;
if (failures.length === 0) {
  console.log(`WRITE-UNIT: pass (${passCount}/${total} asserts)`);
  process.exit(0);
} else {
  console.log(`WRITE-UNIT: FAIL (${passCount}/${total} asserts passed)`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  console.log('--- captured stderr tail ---');
  for (const line of errLog.slice(-20)) console.log('  ' + line);
  process.exit(1);
}
