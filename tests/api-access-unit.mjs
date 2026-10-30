import assert from 'node:assert/strict';
import { RedditAPI } from '../dist/services/reddit-api.js';
import { CacheManager } from '../dist/core/cache.js';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const caches = [];
function client(authenticated = false) {
  const cache = new CacheManager();
  caches.push(cache);
  return new RedditAPI({
    authManager: { isAuthenticated: () => authenticated, getHeaders: async () => ({}) },
    rateLimiter: { canMakeRequest: () => true, recordRequest() {} },
    cacheManager: cache,
  });
}

try {
  const waits = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    waits.push(delay);
    return originalSetTimeout(callback, delay === 10000 ? delay : 0, ...args);
  };
  for (const status of [429, 503]) {
    for (const headers of [{ 'x-ratelimit-reset': '43' }, { 'retry-after': '120' }, { 'retry-after': '6' }]) {
      if (status === 503 && headers['x-ratelimit-reset']) continue;
      let calls = 0;
      globalThis.fetch = async url => {
        calls++;
        return String(url).includes('.rss')
          ? new Response('', { status, headers })
          : new Response('blocked', { status: 403 });
      };
      const expectedWait = headers['x-ratelimit-reset'] ? '44s' : headers['retry-after'] + 's';
      await assert.rejects(client().browseSubreddit('programming'), error => error.message.includes('Retry in ' + expectedWait));
      assert.equal(calls, 2, 'long RSS waits must not trigger a retry');

      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('', { status, headers }); };
      await assert.rejects(client(true).search('test'), error => error.status === status && error.message.includes('Retry in ' + expectedWait));
      assert.equal(calls, 1, 'long JSON waits must not trigger a retry');
    }
  }
  assert.ok(waits.every(delay => delay === 10000), 'only fetch timeouts, never long retry timers, should be scheduled');
  for (const rss of [false, true]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503, headers: { 'x-ratelimit-reset': '300' } });
      return rss
        ? new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { headers: { 'content-type': 'application/atom+xml' } })
        : Response.json({ data: { children: [] } });
    };
    const retrying = client(true);
    if (rss) await retrying.getRSS('/r/test/.rss');
    else await retrying.search('test');
    assert.equal(calls, 2, 'quota reset on 503 must not suppress transient recovery');
  }
  globalThis.fetch = async url => String(url).includes('.rss')
    ? new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    : new Response('blocked', { status: 403 });
  // CI's path: an earlier browse already proved the logged-out JSON block, so the RSS error reaches the caller directly.
  const latched = client();
  latched['anonJsonBlockedUntil'] = Date.now() + 60000;
  await assert.rejects(latched.browseSubreddit('all', 'rising'),
    error => error.status === 403 && error.message.includes('refused the logged-out RSS feed for r/all/rising') && !/private|quarantined/.test(error.message));
  await assert.rejects(client().browseSubreddit('popular', 'hot'), error => error.status === 403 && error.message.includes('refused the logged-out RSS feed for r/popular/hot'));
  await assert.rejects(client().browseSubreddit('programming', 'rising'), error => /private, quarantined, or NSFW/.test(error.message));
  const parsing = client();
  assert.equal(parsing.getRetryAfterDelay(new Response('', { headers: { 'retry-after': 'invalid' } })), null);
  assert.equal(parsing.getRetryAfterDelay(new Response('', { headers: { 'retry-after': '-1' } })), null);
  assert.equal(parsing.getRateLimitResetDelay(new Response('', { headers: { 'x-ratelimit-reset': 'Infinity' } })), null);
  const dateDelay = parsing.getRetryAfterDelay(new Response('', { headers: { 'retry-after': new Date(Date.now() + 60000).toUTCString() } }));
  assert.ok(dateDelay > 58000 && dateDelay <= 60000);
  console.log('API-ACCESS: pass');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  for (const cache of caches) cache.destroy();
}
