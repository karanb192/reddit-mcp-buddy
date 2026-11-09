import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedditAPI, LOGGED_OUT_ACCESS_ENDS_AT, LOGGED_OUT_ENDED_MESSAGE, LoggedOutAccessEndedError } from '../dist/services/reddit-api.js';
import { RedditTools } from '../dist/tools/index.js';
import { CacheManager } from '../dist/core/cache.js';
import { createMCPServer } from '../dist/mcp-server.js';

const originalEnv = { ...process.env };
const testHome = mkdtempSync(join(tmpdir(), 'reddit-rss-shutdown-'));
// Clearing env credentials alone still lets AuthManager load a developer's saved --auth config.
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('REDDIT_')) delete process.env[name];
}

const realNow = Date.now;
const originalFetch = globalThis.fetch;
const caches = [];
let fetchCalls = 0;

function client({ authenticated = false, endsAt } = {}) {
  const cache = new CacheManager();
  caches.push(cache);
  const api = new RedditAPI({
    authManager: { isAuthenticated: () => authenticated, getHeaders: async () => ({}) },
    rateLimiter: { canMakeRequest: () => true, recordRequest() {} },
    cacheManager: cache,
    ...(endsAt === undefined ? {} : { loggedOutAccessEndsAt: endsAt }),
  });
  return { api, cache };
}

const misleading = /does not exist|not found|private|quarantined|nsfw|inaccessible|rate.limit/i;
const isShutdown = error =>
  error.message === LOGGED_OUT_ENDED_MESSAGE && error.status === 403 && !misleading.test(error.message);

const feed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_abc</id><title>t</title></entry></feed>';
// Every way a retired feed might answer. None of them may change what a logged-out caller is told.
const retiredFeedAnswers = {
  'HTTP 404': () => new Response('', { status: 404 }),
  'HTTP 403': () => new Response('', { status: 403 }),
  'HTTP 410': () => new Response('', { status: 410 }),
  'HTML page': () => new Response('<html>gone</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  'redirect': () => new Response('', { status: 301, headers: { location: 'https://www.reddit.com/' } }),
  'empty feed': () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { headers: { 'content-type': 'application/atom+xml' } }),
  'working feed': () => new Response(feed, { headers: { 'content-type': 'application/atom+xml' } }),
  'network error': () => { throw new TypeError('fetch failed'); },
};

try {
  assert.equal(new Date(LOGGED_OUT_ACCESS_ENDS_AT).toISOString(), '2026-11-13T00:00:00.000Z');
  for (const fact of ['2026-11-13', '2026-10-31', 'existing approved Reddit API credentials', 'https://developers.reddit.com/app-registration', '2027-01-12']) {
    assert.ok(LOGGED_OUT_ENDED_MESSAGE.includes(fact), `shutdown message must state ${fact}`);
  }
  assert.ok(!misleading.test(LOGGED_OUT_ENDED_MESSAGE));
  assert.ok(!/apply|request access/i.test(LOGGED_OUT_ENDED_MESSAGE), 'new users cannot apply any more');

  // The real default: one millisecond before and at the cutoff.
  globalThis.fetch = async () => { fetchCalls++; return new Response(feed, { headers: { 'content-type': 'application/atom+xml' } }); };
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT - 1;
  const before = client().api;
  assert.equal(before.loggedOutAccessEnded(), false);
  const listing = await before.browseSubreddit('programming', 'hot', { limit: 1 });
  assert.equal(listing.data._source, 'rss');
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT;
  assert.equal(client().api.loggedOutAccessEnded(), true);

  // After the cutoff the answer is the same whatever Reddit sends, and Reddit is never contacted.
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT + 86400000;
  for (const [label, answer] of Object.entries(retiredFeedAnswers)) {
    fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; return answer(); };
    const { api } = client();
    await assert.rejects(api.browseSubreddit('programming', 'hot'), isShutdown, `browse after cutoff, ${label}`);
    await assert.rejects(api.browseSubreddit('all', 'rising'), isShutdown, `aggregate browse after cutoff, ${label}`);
    await assert.rejects(api.search('test'), isShutdown, `search after cutoff, ${label}`);
    await assert.rejects(api.getPost('abc123'), isShutdown, `post lookup after cutoff, ${label}`);
    await assert.rejects(api.getPost('https://www.reddit.com/r/programming/comments/abc123/t/'), isShutdown);
    await assert.rejects(api.getUser('spez'), isShutdown);
    await assert.rejects(api.getUserPosts('spez'), isShutdown);
    await assert.rejects(api.getSubreddit('programming'), isShutdown);
    await assert.rejects(api.getTrending(), isShutdown);
    await assert.rejects(api.getRSS('/r/programming/hot/.rss'), isShutdown);
    await assert.rejects(api.get('/r/programming/about.json'), isShutdown);
    assert.equal(fetchCalls, 0, `no request may reach Reddit after the cutoff (${label})`);
  }

  // A listing cached just before the cutoff is not served afterwards.
  const { api: cachedApi, cache } = client();
  cache.set(CacheManager.createKey('subreddit', 'programming', 'hot', 10, undefined, undefined), listing);
  cache.set(CacheManager.createKey('search', 'q', undefined, 'relevance', 'all', 10, undefined), listing);
  await assert.rejects(cachedApi.browseSubreddit('programming'), isShutdown);
  await assert.rejects(cachedApi.search('q'), isShutdown);

  // A call that starts before the cutoff and fails after it reports the shutdown, not the feed's answer.
  for (const [label, answer] of Object.entries(retiredFeedAnswers)) {
    if (label === 'working feed' || label === 'empty feed') continue;
    const endsAt = realNow() + 3600000;
    globalThis.fetch = async url => {
      Date.now = () => endsAt + 1;
      return String(url).includes('.rss') ? answer() : new Response('blocked', { status: 403 });
    };
    for (const latched of [false, true]) {
      Date.now = realNow;
      const crossing = client({ endsAt }).api;
      if (latched) crossing['anonJsonBlockedUntil'] = realNow() + 60000;
      await assert.rejects(crossing.browseSubreddit('programming'), isShutdown, `call crossing the cutoff, ${label}, latched=${latched}`);
    }
  }

  // JSON can fail before the cutoff while the RSS fallback finishes after it. The outer
  // fallback handler must not add the earlier JSON error back onto the shutdown message.
  for (const jsonStatus of [403, 404]) {
    for (const [label, answer] of Object.entries(retiredFeedAnswers)) {
      if (label === 'working feed' || label === 'empty feed') continue;
      const endsAt = realNow() + 3600000;
      Date.now = realNow;
      fetchCalls = 0;
      globalThis.fetch = async url => {
        fetchCalls++;
        if (!String(url).includes('.rss')) return new Response('', { status: jsonStatus });
        Date.now = () => endsAt + 1;
        return answer();
      };
      await assert.rejects(client({ endsAt }).api.browseSubreddit('programming'), isShutdown,
        `cutoff during RSS, JSON ${jsonStatus}, RSS ${label}`);
      assert.equal(fetchCalls, 2, 'the cutoff must be crossed during RSS, not the JSON probe');
    }
  }

  // Credentials are unaffected by the cutoff.
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT + 86400000;
  fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return Response.json({ kind: 'Listing', data: { children: [], after: null, before: null } }); };
  const authed = client({ authenticated: true }).api;
  assert.equal(authed.loggedOutAccessEnded(), false);
  assert.equal((await authed.browseSubreddit('programming')).data._source, 'api');
  await authed.search('test');
  assert.equal(fetchCalls, 2);
  const authedSearch = await new RedditTools(authed).searchReddit({
    query: 'test', subreddits: ['programming', 'javascript'], limit: 10,
  });
  assert.equal(authedSearch.total_results, 0);
  assert.equal(fetchCalls, 4, 'authenticated multi-subreddit searches remain available after the cutoff');

  // Keep ordinary per-subreddit failure tolerance, but never hide a global shutdown
  // behind a partial result from a search that completed just before the cutoff.
  for (const failure of [new Error('subreddit unavailable'), new LoggedOutAccessEndedError()]) {
    const partialTools = new RedditTools({
      search: async (_query, { subreddit }) => {
        if (subreddit === 'javascript') throw failure;
        return { kind: 'Listing', data: { children: [], after: null, before: null } };
      },
    });
    const search = partialTools.searchReddit({ query: 'test', subreddits: ['programming', 'javascript'], limit: 10 });
    if (failure instanceof LoggedOutAccessEndedError) {
      await assert.rejects(search, isShutdown, 'shutdown takes precedence over a partial result');
    } else {
      assert.equal((await search).total_results, 0, 'ordinary subreddit failures still allow partial results');
    }
  }

  // Through the tools layer: reddit_explain is offline and keeps working; the Reddit tools give the shutdown message.
  const tools = new RedditTools(client().api);
  const explained = await tools.redditExplain({ term: 'karma' });
  assert.ok(explained.definition);
  await assert.rejects(tools.browseSubreddit({ subreddit: 'programming', sort: 'hot', limit: 5, include_nsfw: false, include_subreddit_info: true }), isShutdown);

  // Through the MCP handler, as a client sees it, with the startup warning on stderr.
  fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Response('', { status: 404 }); };
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let mcp;
  try {
    mcp = await createMCPServer();
  } finally {
    console.error = originalError;
  }
  caches.push(mcp.cacheManager);
  assert.ok(logged.some(line => line.includes(LOGGED_OUT_ENDED_MESSAGE)), 'startup must say why logged-out use stopped');
  for (const [name, args] of [
    ['browse_subreddit', { subreddit: 'notreal999xyz' }],
    ['search_reddit', { query: 'test' }],
    ['search_reddit', { query: 'test', subreddits: ['programming'] }],
    ['search_reddit', { query: 'test', subreddits: ['programming', 'javascript'] }],
    ['get_post_details', { post_id: 'abc123' }],
    ['user_analysis', { username: 'spez' }],
  ]) {
    const response = await mcp.handlers['tools/call']({ name, arguments: args });
    assert.equal(response.isError, true, name);
    assert.equal(response.content[0].text, `Error: ${LOGGED_OUT_ENDED_MESSAGE}`, name);
  }
  const offline = await mcp.handlers['tools/call']({ name: 'reddit_explain', arguments: { term: 'karma' } });
  assert.ok(!offline.isError && offline.content[0].text.includes('definition'));
  assert.equal(fetchCalls, 0);

  // Before the cutoff, a logged-out RSS failure keeps its specific cause and also names the shutdown,
  // in case Reddit turns the feeds off early.
  Date.now = realNow;
  for (const [label, answer] of Object.entries(retiredFeedAnswers)) {
    if (label === 'working feed' || label === 'empty feed') continue;
    globalThis.fetch = async url => String(url).includes('.rss') ? answer() : new Response('blocked', { status: 403 });
    const early = client({ endsAt: Infinity }).api;
    early['anonJsonBlockedUntil'] = realNow() + 60000;
    await assert.rejects(early.browseSubreddit('programming'),
      error => error.message.includes('2026-11-13') && error.message.includes('existing approved Reddit API credentials'),
      `pre-cutoff RSS failure names the shutdown (${label})`);
  }
  globalThis.fetch = async url => String(url).includes('.rss')
    ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
    : new Response('blocked', { status: 403 });
  const throttled = client({ endsAt: Infinity }).api;
  throttled['anonJsonBlockedUntil'] = realNow() + 60000;
  await assert.rejects(throttled.browseSubreddit('programming'),
    error => error.status === 429 && !error.message.includes('2026-11-13'), 'throttling is not blamed on the shutdown');

  console.log('RSS-SHUTDOWN: pass');
} finally {
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  for (const c of caches) c.destroy();
  process.env = originalEnv;
  rmSync(testHome, { recursive: true, force: true });
}
