import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RedditAPI,
  LOGGED_OUT_ACCESS_ENDS_AT,
  LOGGED_OUT_ENDED_MESSAGE,
  CREDENTIALS_REQUIRED_MESSAGE,
  CredentialsRequiredError,
} from '../dist/services/reddit-api.js';
import { RedditTools, findSubredditsSchema } from '../dist/tools/index.js';
import { CacheManager } from '../dist/core/cache.js';
import { createMCPServer } from '../dist/mcp-server.js';

const originalEnv = { ...process.env };
const testHome = mkdtempSync(join(tmpdir(), 'reddit-find-subreddits-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('REDDIT_')) delete process.env[name];
}

const realNow = Date.now;
const originalFetch = globalThis.fetch;
const caches = [];
let requests = [];

function client({ authenticated = true, endsAt = Infinity } = {}) {
  const cache = new CacheManager();
  caches.push(cache);
  const api = new RedditAPI({
    authManager: { isAuthenticated: () => authenticated, getHeaders: async () => ({}) },
    rateLimiter: { canMakeRequest: () => true, recordRequest() {}, getErrorMessage: () => 'rate limited' },
    cacheManager: cache,
    loggedOutAccessEndsAt: endsAt,
  });
  return { api, cache, tools: new RedditTools(api) };
}

const t5 = (display_name, extra = {}) => ({
  kind: 't5',
  data: {
    display_name,
    title: `${display_name} title`,
    public_description: `About ${display_name}`,
    subscribers: 1000,
    over18: false,
    subreddit_type: 'public',
    ...extra,
  },
});
const listing = children => ({ kind: 'Listing', data: { children, after: null, before: null } });

// Routes the two endpoints this tool uses; anything else is a test failure.
function mockReddit({ search, info }) {
  requests = [];
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    requests.push(u);
    const routes = { '/subreddits/search.json': search, '/api/info.json': info };
    if (!(u.pathname in routes)) throw new Error(`unexpected request ${u}`);
    const route = routes[u.pathname];
    const answer = typeof route === 'function' ? route(u) : route;
    return answer instanceof Response ? answer : Response.json(answer);
  };
}

const parse = input => findSubredditsSchema.parse(input);
const misleading = /does not exist|not found|private|quarantined|banned|nsfw|inaccessible/i;

try {
  // Schema: names are cleaned, bounds hold, and only single subreddit names are accepted.
  const parsed = parse({ query: '  mechanical keyboards  ', candidates: ['r/MechanicalKeyboards', '/r/keyboards', ' typing '] });
  assert.equal(parsed.query, 'mechanical keyboards');
  assert.equal(parsed.min_subscribers, 1000);
  assert.deepEqual(parsed.candidates, ['MechanicalKeyboards', 'keyboards', 'typing']);
  assert.equal(parsed.include_nsfw, false);
  assert.equal(parsed.limit, 10);
  for (const bad of [
    {},
    { query: '' },
    { query: '   ' },
    { query: 'x'.repeat(513) },
    { query: 'x', candidates: Array.from({ length: 11 }, (_, i) => `sub${i}`) },
    { query: 'x', candidates: ['x'.repeat(101)] },
    { query: 'x', candidates: [5] },
    { query: 'x', limit: 0 },
    { query: 'x', limit: 51 },
    { query: 'x', limit: 2.5 },
    { query: 'x', min_subscribers: -1 },
    { need: 'x' },
  ]) {
    assert.equal(findSubredditsSchema.safeParse(bad).success, false, `schema must refuse ${JSON.stringify(bad)}`);
  }

  // Exactly two requests: the subreddit search and one batched name lookup, both on the OAuth host.
  mockReddit({
    search: listing([t5('MechanicalKeyboards', { subscribers: 1500000 }), t5('keyboards'), t5('ErgoMechKeyboards')]),
    info: listing([t5('MechanicalKeyboards', { subscribers: 1500001 }), t5('Typing')]),
  });
  Date.now = () => Date.UTC(2026, 10, 20, 12, 0, 0);
  const fresh = client();
  const out = await fresh.tools.findSubreddits(parse({
    query: 'mechanical keyboards & typing?',
    candidates: ['MechanicalKeyboards', 'typing', 'notarealsub999', 'mechanicalkeyboards'],
  }));
  assert.equal(requests.length, 2);
  for (const u of requests) assert.equal(u.origin, 'https://oauth.reddit.com');
  const searchReq = requests.find(u => u.pathname === '/subreddits/search.json');
  assert.equal(searchReq.searchParams.get('q'), 'mechanical keyboards & typing?');
  assert.equal(searchReq.searchParams.get('limit'), '30', 'asks for three times the limit, since small and NSFW suggestions are dropped before the cut');
  assert.equal(searchReq.searchParams.get('include_over_18'), null);
  const infoReq = requests.find(u => u.pathname === '/api/info.json');
  assert.equal(infoReq.searchParams.get('sr_name'), 'MechanicalKeyboards,typing,notarealsub999', 'duplicates are removed before the lookup');

  assert.deepEqual(out.results.map(r => [r.name, r.source, r.confirmed_exists]), [
    ['MechanicalKeyboards', 'assistant', true],
    ['Typing', 'assistant', true],
    ['keyboards', 'reddit_search', true],
    ['ErgoMechKeyboards', 'reddit_search', true],
  ]);
  assert.equal(out.results[0].subscribers, 1500001, 'a candidate uses the name lookup, not the search copy');
  assert.equal(out.results[0].subscribers_as_of, '2026-11-20T12:00:00.000Z');
  assert.equal(out.results[0].url, 'https://www.reddit.com/r/MechanicalKeyboards/');
  assert.equal(out.results[0].title, 'MechanicalKeyboards title');
  assert.equal(out.results[0].description, 'About MechanicalKeyboards');
  assert.equal(out.results[0].nsfw, false);
  assert.equal(out.results[0].type, 'public');
  assert.deepEqual(out.not_found, ['notarealsub999']);
  assert.equal(out.total_results, 4);
  assert.equal(out.nsfw_hidden, 0);
  assert.equal(out.small_hidden, 0);
  assert.deepEqual(out.unavailable, []);
  assert.ok(out.note.includes('not_found'));
  assert.equal(out.nsfw_hidden_candidates, undefined);

  // A repeat call is served from the cache with the original as-of time, and the cached
  // Reddit listings are not changed by shaping or filtering.
  const searchKey = CacheManager.createKey('subreddit-search', 'mechanical keyboards & typing?', 30, 'sfw');
  const namesKey = CacheManager.createKey('subreddit-names', 'mechanicalkeyboards', 'notarealsub999', 'typing');
  const before = JSON.stringify([fresh.cache.get(searchKey), fresh.cache.get(namesKey)]);
  assert.notEqual(before, '[null,null]');
  Date.now = () => Date.UTC(2026, 10, 20, 12, 3, 0);
  requests = [];
  const again = await fresh.tools.findSubreddits(parse({
    query: 'mechanical keyboards & typing?',
    candidates: ['notarealsub999', 'Typing', 'MechanicalKeyboards'],
  }));
  assert.equal(requests.length, 0, 'same query and same names in another order and case hit the cache');
  assert.equal(again.results[0].subscribers_as_of, '2026-11-20T12:00:00.000Z');
  assert.equal(JSON.stringify([fresh.cache.get(searchKey), fresh.cache.get(namesKey)]), before);
  Date.now = realNow;

  // No candidates: one request only.
  mockReddit({ search: listing([t5('python')]), info: listing([]) });
  const solo = await client().tools.findSubreddits(parse({ query: 'python help', limit: 3 }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('limit'), '9');
  assert.deepEqual(solo.not_found, []);
  assert.equal(solo.note, undefined);

  // NSFW: left out by default and counted, kept with include_nsfw, and the cache serves both.
  mockReddit({
    search: listing([t5('sfwsub'), t5('nsfwsub', { over18: true }), t5('unknownflag', { over18: undefined })]),
    info: listing([t5('nsfwcandidate', { over18: true })]),
  });
  const nsfw = client();
  const hidden = await nsfw.tools.findSubreddits(parse({ query: 'q', candidates: ['nsfwcandidate'] }));
  assert.deepEqual(hidden.results.map(r => r.name), ['sfwsub', 'unknownflag']);
  assert.equal(hidden.results[1].nsfw, null, 'a missing flag is reported as unknown, not as false');
  assert.equal(hidden.nsfw_hidden, 2);
  assert.deepEqual(hidden.nsfw_hidden_candidates, ['nsfwcandidate']);
  assert.deepEqual(hidden.not_found, [], 'an NSFW candidate exists, so it is not reported as not found');
  requests = [];
  const shown = await nsfw.tools.findSubreddits(parse({ query: 'q', candidates: ['nsfwcandidate'], include_nsfw: true }));
  assert.equal(requests.length, 1, 'the name check is cached; the search is asked again with NSFW included');
  assert.equal(requests[0].pathname, '/subreddits/search.json');
  assert.equal(requests[0].searchParams.get('include_over_18'), 'on');
  assert.deepEqual(shown.results.map(r => r.name), ['nsfwcandidate', 'sfwsub', 'nsfwsub', 'unknownflag']);
  assert.equal(shown.nsfw_hidden, 0);

  // Defensive parsing of the name lookup: odd shapes never throw and never invent a subreddit.
  const oddAnswers = {
    'empty object': {},
    'no children': { kind: 'Listing', data: {} },
    'null children': { kind: 'Listing', data: { children: null } },
    'children not an array': { kind: 'Listing', data: { children: { a: 1 } } },
    'empty children': listing([]),
    'non-t5 kinds': listing([{ kind: 't3', data: { display_name: 'askreddit', subreddit: 'askreddit' } }, { kind: 't2', data: { display_name: 'askreddit' } }]),
    't5 with null data': listing([{ kind: 't5', data: null }, null, { kind: 't5' }]),
    't5 without a name': listing([{ kind: 't5', data: { title: 'x', subscribers: 5 } }, { kind: 't5', data: { display_name: '' } }]),
    'top-level array': [listing([t5('askreddit')])],
    'null body': null,
  };
  for (const [label, body] of Object.entries(oddAnswers)) {
    mockReddit({ search: listing([]), info: body });
    const odd = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['askreddit'] }));
    assert.deepEqual(odd.results, [], label);
    assert.deepEqual(odd.not_found, ['askreddit'], label);
  }

  // A record with missing optional fields keeps its name and nulls the rest.
  mockReddit({
    search: listing([]),
    info: listing([{ kind: 't5', data: { display_name: 'quietclub', subreddit_type: 'restricted', subscribers: null, over18: false, public_description: '   ' } }]),
  });
  const minimal = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['quietclub'] }));
  assert.deepEqual(minimal.results[0], {
    name: 'quietclub',
    url: 'https://www.reddit.com/r/quietclub/',
    title: null,
    description: null,
    subscribers: null,
    subscribers_as_of: minimal.results[0].subscribers_as_of,
    type: 'restricted',
    nsfw: false,
    source: 'assistant',
    confirmed_exists: true,
  });
  assert.ok(!Number.isNaN(Date.parse(minimal.results[0].subscribers_as_of)));
  assert.ok(minimal.note.includes('2 to 4 different keywords'), 'an empty search says how to retry');

  // Subreddits the token cannot read come back from Reddit with counts and flags nulled (shapes seen
  // live on 2026-11-11). They go to unavailable with a reason and never into results or not_found.
  const nulled = { subscribers: null, over18: null, quarantine: null };
  mockReddit({
    search: listing([t5('openclub'), t5('bannedinsearch', nulled)]),
    info: listing([
      t5('CenturyClub', { ...nulled, subreddit_type: 'private' }),
      t5('fatpeoplehate', nulled),
      t5('TheRedPill', { ...nulled, quarantine_message: 'Are you sure?' }),
      t5('flaggedquarantine', { quarantine: true }),
      t5('learnpython'),
    ]),
  });
  const blocked = await client().tools.findSubreddits(parse({
    query: 'q', candidates: ['centuryclub', 'fatpeoplehate', 'theredpill', 'flaggedquarantine', 'learnpython'],
  }));
  assert.deepEqual(blocked.unavailable, [
    { name: 'CenturyClub', reason: 'private' },
    { name: 'fatpeoplehate', reason: 'banned_or_restricted' },
    { name: 'TheRedPill', reason: 'quarantined' },
    { name: 'flaggedquarantine', reason: 'quarantined' },
  ]);
  assert.deepEqual(blocked.results.map(r => r.name), ['learnpython', 'openclub'], 'an unreadable search result is dropped');
  assert.deepEqual(blocked.not_found, []);
  assert.ok(blocked.note.includes('unavailable'));
  assert.ok(!JSON.stringify(blocked).includes('About fatpeoplehate'), 'an unavailable subreddit\'s description is not passed on');
  assert.ok(!JSON.stringify(blocked).includes('bannedinsearch'), 'an unreadable search result nobody asked about is not named');

  // An unreadable subreddit seen only in the search is reported when the caller named it,
  // whether the name check left it out or failed.
  mockReddit({ search: listing([t5('BannedInSearch', nulled), t5('openclub')]), info: listing([]) });
  const namedA = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['bannedinsearch'] }));
  assert.deepEqual(namedA.unavailable, [{ name: 'BannedInSearch', reason: 'banned_or_restricted' }]);
  assert.deepEqual(namedA.not_found, []);
  mockReddit({ search: listing([t5('BannedInSearch', nulled), t5('openclub')]), info: new Response('upstream', { status: 500 }) });
  const namedB = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['bannedinsearch', 'maybereal'] }));
  assert.deepEqual(namedB.unavailable, [{ name: 'BannedInSearch', reason: 'banned_or_restricted' }]);
  assert.deepEqual(namedB.results.map(r => [r.name, r.confirmed_exists]), [['maybereal', false], ['openclub', true]]);

  // Small suggestions are left out and counted; candidates are never filtered by size; the limit is applied after.
  mockReddit({
    search: listing([t5('big1', { subscribers: 5000 }), t5('tiny', { subscribers: 12 }), t5('big2', { subscribers: 1000 }), t5('big3', { subscribers: 90000 }), t5('nocount', { subscribers: undefined })]),
    info: listing([t5('tinycandidate', { subscribers: 3 })]),
  });
  const sized = client();
  const filtered = await sized.tools.findSubreddits(parse({ query: 'q', candidates: ['tinycandidate'], limit: 2 }));
  assert.deepEqual(filtered.results.map(r => r.name), ['tinycandidate', 'big1', 'big2']);
  assert.equal(filtered.small_hidden, 1);
  const unfiltered = await sized.tools.findSubreddits(parse({ query: 'q', limit: 2, min_subscribers: 0 }));
  assert.deepEqual(unfiltered.results.map(r => r.name), ['big1', 'tiny']);
  assert.equal(unfiltered.small_hidden, 0);
  mockReddit({ search: listing([t5('tiny', { subscribers: 12 })]), info: listing([]) });
  const onlySmall = await client().tools.findSubreddits(parse({ query: 'q' }));
  assert.deepEqual(onlySmall.results, []);
  assert.ok(onlySmall.note.includes('lower min_subscribers'));

  // Names that cannot be subreddits are reported as not found and never reach Reddit.
  mockReddit({ search: listing([t5('python')]), info: listing([t5('learnpython')]) });
  const badNames = await client().tools.findSubreddits(parse({
    query: 'q', candidates: ['a+b', 'u_some-user', 'has space', '../api/v1/me', 'a', 'x'.repeat(22), 'learnpython'],
  }));
  assert.equal(requests.find(u => u.pathname === '/api/info.json').searchParams.get('sr_name'), 'learnpython');
  assert.deepEqual(badNames.not_found, ['a+b', 'u_some-user', 'has space', '../api/v1/me', 'a', 'x'.repeat(22)]);
  assert.deepEqual(badNames.results.map(r => r.name), ['learnpython', 'python']);
  assert.ok(badNames.note.includes('2 to 21 letters'));
  assert.ok(!badNames.note.includes('Reddit returned nothing for the names'), 'Reddit was not asked about them');
  mockReddit({ search: listing([t5('python')]), info: listing([]) });
  const onlyBad = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['a+b'] }));
  assert.equal(requests.length, 1, 'no name check when no candidate is a valid name');
  assert.deepEqual(onlyBad.not_found, ['a+b']);

  // A sentence-length query still runs, with a note that the suggestions may be off topic.
  mockReddit({ search: listing([t5('python')]), info: listing([]) });
  const sentence = await client().tools.findSubreddits(parse({ query: 'where can I learn to cook on a budget' }));
  assert.equal(sentence.total_results, 1);
  assert.ok(sentence.note.includes('2 to 4 keywords'));
  mockReddit({ search: listing([]), info: listing([]) });
  const emptySentence = await client().tools.findSubreddits(parse({ query: 'where can I learn to cook on a budget' }));
  assert.ok(emptySentence.note.includes('reads like a sentence'));

  // A long description is cut, and a non-numeric count is not passed through.
  mockReddit({ search: listing([t5('longdesc', { public_description: 'd'.repeat(1000), subscribers: '12' })]), info: listing([]) });
  const long = await client().tools.findSubreddits(parse({ query: 'q' }));
  assert.equal(long.results[0].description.length, 300);
  assert.equal(long.results[0].subscribers, null);

  // Odd search answers are also tolerated.
  for (const body of [{}, null, listing([{ kind: 'more', data: { children: ['x'] } }])]) {
    mockReddit({ search: body, info: listing([]) });
    const empty = await client().tools.findSubreddits(parse({ query: 'q' }));
    assert.deepEqual(empty.results, []);
    assert.ok(empty.note.includes('likely subreddit names as candidates'));
  }

  // A candidate the name lookup leaves out but the search returns is real, so it is not reported as not found.
  mockReddit({ search: listing([t5('Quarantinedish')]), info: listing([]) });
  const viaSearch = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['quarantinedish'] }));
  assert.deepEqual(viaSearch.results.map(r => [r.name, r.source, r.confirmed_exists]), [['Quarantinedish', 'assistant', true]]);
  assert.deepEqual(viaSearch.not_found, []);

  // Partial failures: the other half still answers, and unchecked names are never presented as confirmed.
  mockReddit({ search: new Response('upstream', { status: 500 }), info: listing([t5('python')]) });
  const searchDown = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['python'] }));
  assert.deepEqual(searchDown.results.map(r => [r.name, r.confirmed_exists]), [['python', true]]);
  assert.ok(searchDown.note.includes('subreddit search failed'));

  mockReddit({ search: listing([t5('python')]), info: new Response('upstream', { status: 500 }) });
  const namesDown = await client().tools.findSubreddits(parse({ query: 'q', candidates: ['Python', 'maybereal'] }));
  assert.deepEqual(namesDown.results.map(r => [r.name, r.source, r.confirmed_exists]), [
    ['python', 'assistant', true],
    ['maybereal', 'assistant', false],
  ]);
  assert.equal(namesDown.results[1].subscribers, null);
  assert.equal(namesDown.results[1].subscribers_as_of, null);
  assert.deepEqual(namesDown.not_found, [], 'a failed check is not evidence that a name does not exist');
  assert.ok(namesDown.note.includes('name check failed'));

  mockReddit({ search: new Response('upstream', { status: 500 }), info: new Response('upstream', { status: 500 }) });
  await assert.rejects(client().tools.findSubreddits(parse({ query: 'q', candidates: ['python'] })), /500/);
  mockReddit({ search: new Response('upstream', { status: 500 }), info: listing([]) });
  await assert.rejects(client().tools.findSubreddits(parse({ query: 'q' })), /500/);

  // Without credentials, before the cutoff: the credentials error, raised before any cache read or request.
  mockReddit({ search: listing([t5('python')]), info: listing([t5('python')]) });
  const loggedOut = client({ authenticated: false });
  loggedOut.cache.set(CacheManager.createKey('subreddit-search', 'q', 30, 'sfw'), { fetched_at: 0, listing: listing([t5('python')]) });
  const isCredentialsError = e =>
    e instanceof CredentialsRequiredError && e.status === 403 && e.message === CREDENTIALS_REQUIRED_MESSAGE;
  await assert.rejects(loggedOut.tools.findSubreddits(parse({ query: 'q' })), isCredentialsError);
  await assert.rejects(loggedOut.tools.findSubreddits(parse({ query: 'q', candidates: ['python'] })), isCredentialsError);
  await assert.rejects(loggedOut.api.searchSubreddits('q'), isCredentialsError);
  await assert.rejects(loggedOut.api.getSubredditsByName(['python']), isCredentialsError);
  assert.equal(requests.length, 0);
  assert.ok(CREDENTIALS_REQUIRED_MESSAGE.includes('existing approved Reddit API credentials'));
  assert.ok(!/apply|request access/i.test(CREDENTIALS_REQUIRED_MESSAGE), 'new users cannot apply any more');
  assert.ok(!misleading.test(CREDENTIALS_REQUIRED_MESSAGE.replace('not a problem with the subreddit names', '')));

  // Without credentials, after the cutoff: the shutdown error, the same one every other tool gives.
  const ended = client({ authenticated: false, endsAt: LOGGED_OUT_ACCESS_ENDS_AT });
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT + 1;
  await assert.rejects(ended.tools.findSubreddits(parse({ query: 'q', candidates: ['python'] })),
    e => e.message === LOGGED_OUT_ENDED_MESSAGE && e.status === 403);
  assert.equal(requests.length, 0);
  Date.now = realNow;

  // Credentials are unaffected by the cutoff.
  Date.now = () => LOGGED_OUT_ACCESS_ENDS_AT + 86400000;
  mockReddit({ search: listing([t5('python')]), info: listing([]) });
  const afterCutoff = await client({ authenticated: true, endsAt: LOGGED_OUT_ACCESS_ENDS_AT }).tools.findSubreddits(parse({ query: 'q' }));
  assert.equal(afterCutoff.total_results, 1);
  Date.now = realNow;

  await assert.rejects(client().api.getSubredditsByName([]), /1 to 100/);
  await assert.rejects(client().api.getSubredditsByName(Array.from({ length: 101 }, (_, i) => `s${i}x`)), /1 to 100/);

  // Through the MCP handlers with no credentials: listed with its schema, and a call returns the credentials error.
  requests = [];
  globalThis.fetch = async url => { requests.push(new URL(String(url))); return new Response('', { status: 404 }); };
  const originalError = console.error;
  console.error = () => {};
  let mcp;
  try {
    mcp = await createMCPServer();
  } finally {
    console.error = originalError;
  }
  caches.push(mcp.cacheManager);
  const { tools } = await mcp.handlers['tools/list']();
  const def = tools.find(t => t.name === 'find_subreddits');
  assert.ok(def, 'find_subreddits is listed');
  assert.equal(def.annotations.readOnlyHint, true);
  assert.deepEqual(def.inputSchema.required, ['query']);
  assert.equal(def.inputSchema.properties.candidates.maxItems, 10);
  assert.equal(def.inputSchema.additionalProperties, false);
  assert.ok(/before browse_subreddit or search_reddit/.test(def.description));
  assert.ok(!/apply/i.test(def.description));
  const call = await mcp.handlers['tools/call']({ name: 'find_subreddits', arguments: { query: 'q', candidates: ['python'] } });
  assert.equal(call.isError, true);
  const expected = Date.now() >= LOGGED_OUT_ACCESS_ENDS_AT ? LOGGED_OUT_ENDED_MESSAGE : CREDENTIALS_REQUIRED_MESSAGE;
  assert.equal(call.content[0].text, `Error: ${expected}`);
  const invalid = await mcp.handlers['tools/call']({ name: 'find_subreddits', arguments: { query: 'q', limit: 0 } });
  assert.equal(invalid.isError, true);
  assert.equal(requests.length, 0);

  console.log('FIND-SUBREDDITS: pass');
} finally {
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  for (const c of caches) c.destroy();
  process.env = originalEnv;
  rmSync(testHome, { recursive: true, force: true });
}
