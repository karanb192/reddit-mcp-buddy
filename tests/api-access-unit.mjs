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
  globalThis.fetch = async () => new Response('blocked', { status: 403 });
  const operations = [
    api => api.search('test'),
    api => api.search('test', { subreddit: 'programming' }),
    api => api.getPost('programming_ab123'),
    api => api.getUser('test_user'),
  ];
  for (const operation of operations) {
    await assert.rejects(operation(client()), error => error.status === 403 && /approved Reddit API credentials/.test(error.message) && !/private|quarantined|Try a public/.test(error.message));
    await assert.rejects(operation(client(true)), error => error.status === 403 && /private/.test(error.message));
  }

  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    return String(url).includes('.rss')
      ? new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { headers: { 'content-type': 'application/atom+xml' } })
      : new Response('blocked', { status: 403 });
  };
  const api = client();
  await api.browseSubreddit('programming');
  assert.equal(requests, 2);
  for (const operation of operations) {
    await assert.rejects(operation(api), /approved Reddit API credentials/);
  }
  assert.equal(requests, 2, 'proven anonymous blocks must fail before another request');
  await api.browseSubreddit('technology');
  assert.equal(requests, 3, 'RSS browsing remains available');

  const waits = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    waits.push(delay);
    return originalSetTimeout(callback, delay === 10000 ? delay : 0, ...args);
  };
  for (const status of [429, 503]) {
    for (const headers of [{ 'x-ratelimit-reset': '43' }, { 'retry-after': '120' }, { 'retry-after': '6' }]) {
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
