import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RedditAPI } from '../dist/services/reddit-api.js';
import {
  RedditTools,
  browseSubredditSchema,
  searchRedditSchema,
  findSubredditsSchema,
  getPostDetailsSchema,
  userAnalysisSchema,
} from '../dist/tools/index.js';
import { CacheManager } from '../dist/core/cache.js';
import { parseNsfwMode, resolveIncludeNsfw, NSFW_ENV } from '../dist/core/nsfw.js';
import { createMCPServer, createSharedServices } from '../dist/mcp-server.js';

const originalEnv = { ...process.env };
const testHome = mkdtempSync(join(tmpdir(), 'reddit-nsfw-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('REDDIT_')) delete process.env[name];
}

const originalFetch = globalThis.fetch;
const originalError = console.error;
const caches = [];
let requests = [];

function client(mode) {
  const cache = new CacheManager();
  caches.push(cache);
  const api = new RedditAPI({
    authManager: { isAuthenticated: () => true, getHeaders: async () => ({}) },
    rateLimiter: { canMakeRequest: () => true, recordRequest() {}, getErrorMessage: () => 'rate limited' },
    cacheManager: cache,
    loggedOutAccessEndsAt: Infinity,
  });
  return { api, cache, tools: mode === undefined ? new RedditTools(api) : new RedditTools(api, mode) };
}

const listing = children => ({ kind: 'Listing', data: { children, after: null, before: null } });
const t3 = (id, over_18, extra = {}) => ({
  kind: 't3',
  data: {
    id, title: `title ${id}`, author: 'someone', score: 5, upvote_ratio: 0.9, num_comments: 1,
    created_utc: 1700000000, url: `https://example.com/${id}`, permalink: `/r/sub/comments/${id}/t/`,
    subreddit: 'sub', is_video: false, is_self: true, selftext: 'text', over_18, stickied: false,
    link_flair_text: null, ...extra,
  },
});
const t1 = (id, over_18) => ({
  kind: 't1',
  data: {
    id, author: 'someone', body: `comment ${id}`, score: 2, created_utc: 1700000000, subreddit: 'sub',
    link_title: 'a post', permalink: `/r/sub/comments/p/t/${id}/`, over_18,
  },
});
const t5 = (display_name, over18) => ({
  kind: 't5',
  data: { display_name, title: display_name, public_description: '', subscribers: 5000, over18, subreddit_type: 'public' },
});

// Search answers the way Reddit does: NSFW posts only when include_over_18 is on.
const MIXED = [t3('a', false), t3('b', true), t3('c', false), t3('d', true)];
function mockReddit(routes = {}) {
  requests = [];
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    requests.push(u);
    const p = u.pathname;
    let answer;
    if (p === '/api/v1/access_token') {
      answer = { access_token: 'test-token', token_type: 'bearer', expires_in: 3600, scope: '*' };
    } else if (/\/search\.json$/.test(p) && !p.startsWith('/subreddits/')) {
      answer = routes.search ? routes.search(u)
        : listing(u.searchParams.get('include_over_18') === 'on' ? MIXED : MIXED.filter(c => !c.data.over_18));
    } else if (p === '/subreddits/search.json') {
      answer = routes.subSearch
        ?? listing(u.searchParams.get('include_over_18') === 'on' ? [t5('sfwsub', false), t5('nsfwsub', true)] : [t5('sfwsub', false)]);
    } else if (p === '/api/info.json') {
      if (routes.info instanceof Response) return routes.info;
      answer = routes.info ?? listing([t5('nsfwcandidate', true)]);
    } else if (/^\/r\/[^/]+\/about\.json$/.test(p)) {
      answer = routes.about ?? t5('sub', true);
    } else if (/\/comments\/[a-z0-9]+\.json$/.test(p)) {
      answer = [listing([routes.post ?? t3('p1', true)]), listing(routes.postComments ?? [])];
    } else if (/^\/user\/[^/]+\/about\.json$/.test(p)) {
      answer = { kind: 't2', data: { name: 'someone', link_karma: 10, comment_karma: 20, created_utc: 1600000000 } };
    } else if (/^\/user\/[^/]+\/submitted\.json$/.test(p)) {
      answer = listing(routes.submitted ?? [t3('u1', false), t3('u2', true)]);
    } else if (/^\/user\/[^/]+\/comments\.json$/.test(p)) {
      answer = listing(routes.comments ?? [t1('c1', true), t1('c2', false), t1('c3', true)]);
    } else if (/^\/r\/[^/]+\/(hot|new|top|rising|controversial)\.json$/.test(p)) {
      answer = listing(routes.browse ?? MIXED);
    } else {
      throw new Error(`unexpected request ${u}`);
    }
    return Response.json(answer);
  };
}

const browse = input => browseSubredditSchema.parse({ subreddit: 'sub', ...input });
const search = input => searchRedditSchema.parse({ query: 'q', ...input });
const find = input => findSubredditsSchema.parse({ query: 'q', ...input });
const ids = out => (out.posts ?? out.results).map(p => p.id);

try {
  // The setting: three values, any case; unset, empty and an unfilled placeholder mean ask.
  for (const unset of [undefined, '', '   ', '${user_config.nsfw_content}']) {
    assert.deepEqual(parseNsfwMode(unset), { mode: 'ask' }, JSON.stringify(unset));
  }
  assert.deepEqual(parseNsfwMode('ask'), { mode: 'ask' });
  assert.deepEqual(parseNsfwMode(' Never '), { mode: 'never' });
  assert.deepEqual(parseNsfwMode('ALWAYS'), { mode: 'always' });
  // A value that cannot be read hides NSFW and says why: a typo must not open a lock.
  for (const bad of ['true', 'false', 'on', 'off', 'allow', 'nevr', '0', 'ask never']) {
    const got = parseNsfwMode(bad);
    assert.equal(got.mode, 'never', bad);
    assert.ok(got.warning.includes(NSFW_ENV) && got.warning.includes('ask, never or always'), bad);
  }
  assert.equal(NSFW_ENV, 'REDDIT_BUDDY_NSFW');

  const matrix = [
    ['ask', undefined, false], ['ask', false, false], ['ask', true, true],
    ['never', undefined, false], ['never', false, false], ['never', true, false],
    ['always', undefined, true], ['always', false, false], ['always', true, true],
  ];
  for (const [mode, requested, expected] of matrix) {
    assert.equal(resolveIncludeNsfw(mode, requested), expected, `${mode} ${requested}`);
  }

  // The flag has no schema default, so "left unset" reaches the server setting.
  assert.equal(browse({}).include_nsfw, undefined);
  assert.equal(search({}).include_nsfw, undefined);
  assert.equal(find({}).include_nsfw, undefined);
  assert.equal(search({ include_nsfw: true }).include_nsfw, true);
  assert.equal(searchRedditSchema.safeParse({ query: 'q', include_nsfw: 'yes' }).success, false);

  // browse_subreddit, default setting: hidden and counted; shown when the call asks.
  mockReddit();
  let c = client();
  let out = await c.tools.browseSubreddit(browse({}));
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.equal(out.nsfw_hidden, 2);
  assert.match(out.note, /^2 NSFW posts were left out\. Set include_nsfw true only if the user asks/);
  out = await c.tools.browseSubreddit(browse({ include_nsfw: true }));
  assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
  assert.equal(out.nsfw_hidden, undefined);
  assert.equal(out.note, undefined);
  assert.equal(requests.length, 1, 'the listing is cached once and filtered per call');
  assert.equal(c.cache.get(CacheManager.createKey('subreddit', 'sub', 'hot', 25, undefined, undefined)).data.children.length, 4,
    'the cached listing keeps every post');

  mockReddit({ browse: [t3('a', false), t3('b', true)] });
  out = await client().tools.browseSubreddit(browse({}));
  assert.match(out.note, /^1 NSFW post was left out\./);

  // An NSFW subreddit browsed without the flag: empty, and the reason is given.
  mockReddit({ browse: [t3('x', true), t3('y', true)] });
  out = await client().tools.browseSubreddit(browse({}));
  assert.deepEqual(out.posts, []);
  assert.equal(out.nsfw_hidden, 2);

  // browse_subreddit, never: the call's flag is ignored and the note says so.
  mockReddit();
  out = await client('never').tools.browseSubreddit(browse({ include_nsfw: true }));
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.equal(out.nsfw_hidden, 2);
  assert.match(out.note, /never return NSFW content \(REDDIT_BUDDY_NSFW\)\. include_nsfw has no effect\.$/);
  assert.doesNotMatch(out.note, /Set include_nsfw true/);

  // browse_subreddit, always: shown unless the call says no.
  mockReddit();
  c = client('always');
  assert.deepEqual(ids(await c.tools.browseSubreddit(browse({}))), ['a', 'b', 'c', 'd']);
  out = await c.tools.browseSubreddit(browse({ include_nsfw: false }));
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.match(out.note, /Set include_nsfw true only if the user asks/);

  // search_reddit, default setting: Reddit is told to leave NSFW out, on every route.
  mockReddit();
  c = client();
  out = await c.tools.searchReddit(search({}));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/search.json');
  assert.equal(requests[0].searchParams.get('include_over_18'), 'off');
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.equal(out.nsfw_hidden, undefined);
  assert.equal(out.note, undefined);

  // Asking for NSFW is a different request and a different cache entry.
  out = await c.tools.searchReddit(search({ include_nsfw: true }));
  assert.equal(requests.length, 2, 'the NSFW search is not served from the hidden search cache entry');
  assert.equal(requests[1].searchParams.get('include_over_18'), 'on');
  assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.results.map(p => p.nsfw), [false, true, false, true]);
  out = await c.tools.searchReddit(search({}));
  assert.equal(requests.length, 2, 'both answers are cached');
  assert.deepEqual(ids(out), ['a', 'c'], 'the hidden search never gets the NSFW cache entry');

  mockReddit();
  await client().tools.searchReddit(search({ subreddits: ['one'], include_nsfw: true }));
  assert.equal(requests[0].pathname, '/r/one/search.json');
  assert.equal(requests[0].searchParams.get('include_over_18'), 'on');
  mockReddit();
  await client().tools.searchReddit(search({ subreddits: ['one', 'two'] }));
  assert.equal(requests.length, 2);
  for (const u of requests) assert.equal(u.searchParams.get('include_over_18'), 'off');

  // If Reddit sends NSFW posts anyway, they are still dropped and counted.
  mockReddit({ search: () => listing(MIXED) });
  out = await client().tools.searchReddit(search({}));
  assert.deepEqual(ids(out), ['a', 'c']);
  assert.equal(out.nsfw_hidden, 2);
  assert.match(out.note, /^2 NSFW posts were left out\. Set include_nsfw true/);

  // Nothing back with NSFW hidden: say that NSFW may be the reason. Not when NSFW was included.
  mockReddit({ search: () => listing([]) });
  c = client();
  out = await c.tools.searchReddit(search({ subreddits: ['nsfwsub'] }));
  assert.deepEqual(out.results, []);
  assert.match(out.note, /^No posts came back\. NSFW posts are left out of search.*Set include_nsfw true only if the user asks/);
  out = await c.tools.searchReddit(search({ subreddits: ['nsfwsub'], include_nsfw: true }));
  assert.equal(out.note, undefined);

  // The author filter still reports its own count, taken after NSFW posts are gone.
  mockReddit({ search: () => listing([t3('a', false, { author: 'x' }), t3('b', false, { author: 'y' }), t3('n', true, { author: 'x' })]) });
  out = await client().tools.searchReddit(search({ author: 'x' }));
  assert.deepEqual(ids(out), ['a']);
  assert.equal(out.nsfw_hidden, 1);
  assert.match(out.filter_note, /^2 posts matched the query; 1 remained/);

  // search_reddit, never: off whatever the call says. always: on unless the call says no.
  mockReddit();
  out = await client('never').tools.searchReddit(search({ include_nsfw: true }));
  assert.equal(requests[0].searchParams.get('include_over_18'), 'off');
  assert.deepEqual(ids(out), ['a', 'c']);
  mockReddit({ search: () => listing([]) });
  out = await client('never').tools.searchReddit(search({ include_nsfw: true }));
  assert.match(out.note, /never return NSFW content/);
  mockReddit();
  c = client('always');
  out = await c.tools.searchReddit(search({}));
  assert.equal(requests[0].searchParams.get('include_over_18'), 'on');
  assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
  out = await c.tools.searchReddit(search({ include_nsfw: false }));
  assert.equal(requests[1].searchParams.get('include_over_18'), 'off');
  assert.deepEqual(ids(out), ['a', 'c']);

  // find_subreddits follows the same setting.
  mockReddit();
  out = await client('never').tools.findSubreddits(find({ candidates: ['nsfwcandidate'], include_nsfw: true }));
  assert.equal(requests.find(u => u.pathname === '/subreddits/search.json').searchParams.get('include_over_18'), null);
  assert.deepEqual(out.results.map(r => r.name), ['sfwsub']);
  assert.deepEqual(out.nsfw_hidden_candidates, ['nsfwcandidate']);
  assert.match(out.note, /Subreddits that are NSFW or not marked either way are left out\. This server is set to never return NSFW content \(REDDIT_BUDDY_NSFW\)\. include_nsfw has no effect\.$/);
  mockReddit();
  out = await client('never').tools.findSubreddits(find({}));
  assert.equal(out.note, undefined, 'no notice when nothing was asked for and nothing was hidden');
  mockReddit();
  out = await client('always').tools.findSubreddits(find({ candidates: ['nsfwcandidate'] }));
  assert.equal(requests.find(u => u.pathname === '/subreddits/search.json').searchParams.get('include_over_18'), 'on');
  assert.deepEqual(out.results.map(r => r.name), ['nsfwcandidate', 'sfwsub', 'nsfwsub']);
  assert.equal(out.nsfw_hidden, 0);
  mockReddit();
  out = await client().tools.findSubreddits(find({ candidates: ['nsfwcandidate'] }));
  assert.deepEqual(out.results.map(r => r.name), ['sfwsub']);
  assert.equal(out.note, undefined);

  // On a server set to never, a missing NSFW mark counts as NSFW: the lock does not open because a flag is absent.
  // Elsewhere an unmarked item is shown, as before.
  const UNMARKED = [t3('a', false), t3('u', undefined), t3('n', null), t3('b', true)];
  mockReddit({ browse: UNMARKED });
  out = await client('never').tools.browseSubreddit(browse({ include_nsfw: true }));
  assert.deepEqual(ids(out), ['a']);
  assert.equal(out.nsfw_hidden, 3);
  assert.match(out.note, /^3 posts were left out as NSFW or not marked either way\. This server is set to never/);
  mockReddit({ browse: UNMARKED });
  assert.deepEqual(ids(await client().tools.browseSubreddit(browse({}))), ['a', 'u', 'n']);
  mockReddit({ browse: UNMARKED });
  assert.deepEqual(ids(await client('always').tools.browseSubreddit(browse({}))), ['a', 'u', 'n', 'b']);
  // A feed with no marks at all, which is what the logged-out RSS fallback gives.
  mockReddit({ browse: [t3('r1', undefined), t3('r2', undefined)] });
  out = await client('never').tools.browseSubreddit(browse({}));
  assert.deepEqual(out.posts, []);
  assert.equal(out.nsfw_hidden, 2);

  mockReddit({ search: () => listing(UNMARKED) });
  out = await client('never').tools.searchReddit(search({}));
  assert.deepEqual(ids(out), ['a']);
  assert.equal(out.nsfw_hidden, 3);
  assert.match(out.note, /^3 posts were left out as NSFW or not marked either way\./);
  mockReddit({ search: () => listing(UNMARKED) });
  assert.deepEqual(ids(await client().tools.searchReddit(search({}))), ['a', 'u', 'n']);

  mockReddit({ subSearch: listing([t5('sfwsub', false), t5('unmarkedsub', undefined)]), info: listing([t5('unmarkedcandidate', undefined)]) });
  out = await client('never').tools.findSubreddits(find({ candidates: ['unmarkedcandidate'] }));
  assert.deepEqual(out.results.map(r => r.name), ['sfwsub']);
  assert.equal(out.nsfw_hidden, 2);
  assert.deepEqual(out.nsfw_hidden_candidates, ['unmarkedcandidate']);
  mockReddit({ subSearch: listing([t5('sfwsub', false), t5('unmarkedsub', undefined)]), info: listing([t5('unmarkedcandidate', undefined)]) });
  out = await client().tools.findSubreddits(find({ candidates: ['unmarkedcandidate'] }));
  assert.deepEqual(out.results.map(r => r.name), ['unmarkedcandidate', 'sfwsub', 'unmarkedsub']);
  // A candidate the name check could not reach carries nothing from Reddit, so it is still listed as unchecked.
  mockReddit({ subSearch: listing([t5('sfwsub', false)]), info: new Response('', { status: 500 }) });
  out = await client('never').tools.findSubreddits(find({ candidates: ['maybe'] }));
  assert.deepEqual(out.results.map(r => [r.name, r.confirmed_exists]), [['maybe', false], ['sfwsub', true]]);
  assert.equal(out.nsfw_hidden, 0);

  // Subreddit info for an NSFW or unmarked subreddit is left out on never, with the reason; otherwise unchanged.
  for (const mark of [true, undefined]) {
    mockReddit({ browse: [t3('a', false)], about: t5('sub', mark) });
    out = await client('never').tools.browseSubreddit(browse({ include_subreddit_info: true }));
    assert.equal(out.subreddit_info, undefined, String(mark));
    assert.match(out.note, /^Subreddit info was left out: the subreddit is NSFW or not marked either way\. This server is set to never return NSFW content \(REDDIT_BUDDY_NSFW\)\.$/);
  }
  mockReddit({ browse: [t3('a', false), t3('b', true)], about: t5('sub', true) });
  out = await client('never').tools.browseSubreddit(browse({ include_subreddit_info: true }));
  assert.equal(out.subreddit_info, undefined);
  assert.equal(out.note, '1 post was left out as NSFW or not marked either way. This server is set to never return NSFW content (REDDIT_BUDDY_NSFW). include_nsfw has no effect. Subreddit info was left out for the same reason.');
  mockReddit({ browse: [t3('a', false)], about: t5('sub', false) });
  out = await client('never').tools.browseSubreddit(browse({ include_subreddit_info: true }));
  assert.equal(out.subreddit_info.name, 'sub');
  assert.equal(out.note, undefined);
  mockReddit({ browse: [t3('a', false)], about: t5('sub', true) });
  out = await client().tools.browseSubreddit(browse({ include_subreddit_info: true }));
  assert.equal(out.subreddit_info.nsfw, true, 'by default the caller still gets the info for the subreddit it named');

  // get_post_details: a named NSFW post opens, except on a server set to never.
  const details = input => getPostDetailsSchema.parse({ post_id: 'p1', subreddit: 'sub', ...input });
  for (const mode of [undefined, 'ask', 'always']) {
    mockReddit();
    out = await client(mode).tools.getPostDetails(details({}));
    assert.equal(out.post.id, 'p1', String(mode));
    assert.equal(out.post.nsfw, true);
  }
  mockReddit();
  await assert.rejects(client('never').tools.getPostDetails(details({})),
    /^Error: This post is marked NSFW\. This server is set to never return NSFW content \(REDDIT_BUDDY_NSFW\)\.$/);
  mockReddit({ post: t3('p2', false) });
  out = await client('never').tools.getPostDetails(details({ post_id: 'p2' }));
  assert.equal(out.post.id, 'p2');
  // Reddit puts no NSFW mark on the comments of a post page, so on never the post's mark decides for them.
  const pageComment = id => ({ kind: 't1', data: { id, author: 'x', body: `page comment ${id}`, score: 1, created_utc: 1700000000, permalink: `/r/sub/comments/p2/t/${id}/`, replies: '' } });
  mockReddit({ post: t3('p2', false), postComments: [pageComment('k1'), pageComment('k2')] });
  out = await client('never').tools.getPostDetails(details({ post_id: 'p2' }));
  assert.equal(out.total_comments, 2, 'comments of a post marked not NSFW are returned on never');
  mockReddit({ post: t3('p3', undefined) });
  await assert.rejects(client('never').tools.getPostDetails(details({ post_id: 'p3' })),
    /^Error: Reddit did not say whether this post is NSFW\. This server is set to never return NSFW content \(REDDIT_BUDDY_NSFW\)\.$/);
  mockReddit({ post: t3('p3', undefined) });
  assert.equal((await client().tools.getPostDetails(details({ post_id: 'p3' }))).post.id, 'p3');

  // user_analysis: untouched by default; on a server set to never, NSFW items are dropped and counted.
  const analysis = userAnalysisSchema.parse({ username: 'someone', time_range: 'all' });
  mockReddit();
  out = await client().tools.userAnalysis(analysis);
  assert.equal(out.nsfwHidden, undefined);
  assert.equal(out.nsfwNote, undefined);
  const openDump = JSON.stringify(out);
  assert.ok(openDump.includes('title u2') && openDump.includes('comment c1'));

  mockReddit();
  c = client('never');
  out = await c.tools.userAnalysis(analysis);
  const lockedDump = JSON.stringify(out);
  assert.ok(lockedDump.includes('title u1') && lockedDump.includes('comment c2'));
  for (const gone of ['title u2', 'comment c1', 'comment c3']) {
    assert.ok(!lockedDump.includes(gone), `${gone} must not appear on a server set to never`);
  }
  assert.equal(out.nsfwHidden, 3);
  assert.match(out.nsfwNote, /^3 items were left out of this user's posts and comments as NSFW or not marked either way\. This server is set to never return NSFW content \(REDDIT_BUDDY_NSFW\)\.$/);
  const cachedPosts = c.cache.get(CacheManager.createKey('user-posts', 'someone', 'submitted', 'new', 'all', 10));
  assert.equal(cachedPosts.data.children.length, 2, 'the cached listing keeps every post');

  // Comments only, all NSFW.
  mockReddit({ comments: [t1('c1', true)] });
  out = await client('never').tools.userAnalysis(userAnalysisSchema.parse({ username: 'someone', time_range: 'all', posts_limit: 0 }));
  assert.deepEqual(out.recentComments ?? [], []);
  assert.equal(out.nsfwHidden, 1);
  assert.match(out.nsfwNote, /^1 item was left out/);

  // Unmarked items are dropped too; a removed comment (no data) is not counted as hidden.
  mockReddit({ submitted: [t3('u1', false), t3('u3', undefined)], comments: [t1('c2', false), { kind: 't1', data: null }, t1('c4', undefined)] });
  out = await client('never').tools.userAnalysis(analysis);
  const unmarkedDump = JSON.stringify(out);
  assert.ok(unmarkedDump.includes('title u1') && unmarkedDump.includes('comment c2'));
  assert.ok(!unmarkedDump.includes('title u3') && !unmarkedDump.includes('comment c4'));
  assert.equal(out.nsfwHidden, 2);

  // Through the server: the environment variable sets the mode, and the model is told which one.
  const serverFor = async (value, calls = []) => {
    if (value === undefined) delete process.env.REDDIT_BUDDY_NSFW; else process.env.REDDIT_BUDDY_NSFW = value;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let shared;
    try {
      shared = await createSharedServices();
    } finally {
      console.error = originalError;
    }
    caches.push(shared.cacheManager);
    const { server } = await createMCPServer(shared);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: 'nsfw-test', version: '0.0.0' }, { capabilities: {} });
    await mcp.connect(ct);
    const instructions = mcp.getInstructions() ?? '';
    const { tools } = await mcp.listTools();
    const answers = [];
    for (const call of calls) answers.push(await mcp.callTool(call));
    await mcp.close();
    return { shared, logged: logged.join('\n'), instructions, tools, answers };
  };

  let srv = await serverFor(undefined);
  assert.equal(srv.shared.nsfwMode, 'ask');
  assert.match(srv.instructions, /NSFW: left out of browse_subreddit, search_reddit and find_subreddits unless the call sets include_nsfw true/);
  assert.doesNotMatch(srv.logged, /NSFW/);
  for (const name of ['browse_subreddit', 'search_reddit', 'find_subreddits']) {
    const prop = srv.tools.find(t => t.name === name).inputSchema.properties.include_nsfw;
    assert.equal(prop.type, 'boolean', name);
    assert.equal(prop.default, undefined, `${name}: no default, so unset follows the server setting`);
    assert.match(prop.description, /Leave unset to follow the server setting/);
    assert.ok(!(srv.tools.find(t => t.name === name).inputSchema.required ?? []).includes('include_nsfw'));
  }
  for (const name of ['get_post_details', 'user_analysis', 'reddit_explain']) {
    assert.equal(srv.tools.find(t => t.name === name).inputSchema.properties.include_nsfw, undefined, name);
  }

  // With credentials, real tool calls through the server follow the variable.
  process.env.REDDIT_CLIENT_ID = 'test-client-id';
  process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';
  mockReddit();
  srv = await serverFor('never', [
    { name: 'browse_subreddit', arguments: { subreddit: 'sub', include_nsfw: true } },
    { name: 'get_post_details', arguments: { post_id: 'p1', subreddit: 'sub' } },
  ]);
  const lockedBrowse = JSON.parse(srv.answers[0].content[0].text);
  assert.deepEqual(lockedBrowse.posts.map(post => post.id), ['a', 'c']);
  assert.equal(lockedBrowse.nsfw_hidden, 2);
  assert.equal(srv.answers[1].isError, true);
  assert.match(srv.answers[1].content[0].text, /^Error: This post is marked NSFW\. This server is set to never return NSFW content/);
  mockReddit();
  srv = await serverFor('always', [{ name: 'search_reddit', arguments: { query: 'q' } }]);
  assert.deepEqual(JSON.parse(srv.answers[0].content[0].text).results.map(post => post.id), ['a', 'b', 'c', 'd']);
  mockReddit();
  srv = await serverFor(undefined, [{ name: 'search_reddit', arguments: { query: 'q' } }]);
  assert.deepEqual(JSON.parse(srv.answers[0].content[0].text).results.map(post => post.id), ['a', 'c']);
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;

  srv = await serverFor('never');
  assert.equal(srv.shared.nsfwMode, 'never');
  assert.match(srv.instructions, /NSFW: this server never returns NSFW content/);
  assert.match(srv.logged, /NSFW content: never returned \(REDDIT_BUDDY_NSFW=never\)/);

  srv = await serverFor('Always');
  assert.equal(srv.shared.nsfwMode, 'always');
  assert.match(srv.instructions, /NSFW: included by default on this server/);
  assert.match(srv.logged, /NSFW content: included by default \(REDDIT_BUDDY_NSFW=always\)/);

  srv = await serverFor('yes please');
  assert.equal(srv.shared.nsfwMode, 'never', 'an unreadable value locks');
  assert.match(srv.logged, /REDDIT_BUDDY_NSFW must be ask, never or always, not "yes please"/);
  assert.match(srv.instructions, /NSFW: this server never returns NSFW content/);

  srv = await serverFor('${user_config.nsfw_content}');
  assert.equal(srv.shared.nsfwMode, 'ask', 'an unfilled extension setting is the default');

  // A server built from services with no setting (older callers) behaves as ask.
  const { server: bare } = await createMCPServer({ ...srv.shared, nsfwMode: undefined });
  const [bct, bst] = InMemoryTransport.createLinkedPair();
  await bare.connect(bst);
  const bareClient = new Client({ name: 'nsfw-test', version: '0.0.0' }, { capabilities: {} });
  await bareClient.connect(bct);
  assert.match(bareClient.getInstructions(), /NSFW: left out of browse_subreddit/);
  await bareClient.close();

  console.log('NSFW: pass');
} finally {
  console.error = originalError;
  globalThis.fetch = originalFetch;
  for (const c of caches) c.destroy();
  process.env = originalEnv;
  rmSync(testHome, { recursive: true, force: true });
}
