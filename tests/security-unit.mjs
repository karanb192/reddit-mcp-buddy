import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { RedditAPI } from '../dist/services/reddit-api.js';
import { CacheManager } from '../dist/core/cache.js';

const originalFetch = globalThis.fetch;
const cache = new CacheManager();
try {
  globalThis.fetch = async () => new Response('<html><body>' + 'x'.repeat(60000) + '</body></html>', { status: 400, headers: { 'content-type': 'text/html' } });
  const api = new RedditAPI({
    authManager: { isAuthenticated: () => true, getHeaders: async () => ({}) },
    rateLimiter: { canMakeRequest: () => true, recordRequest() {} },
    cacheManager: cache,
  });
  await assert.rejects(api.search('test'), error => error.message.length < 300 && !error.message.includes('<'));
} finally {
  globalThis.fetch = originalFetch;
  cache.destroy();
}

const env = { PATH: process.env.PATH, HOME: process.env.HOME, REDDIT_BUDDY_HTTP: 'true', REDDIT_BUDDY_PORT: '38431' };
const server = spawn(process.execPath, ['dist/index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
try {
  await new Promise((resolve, reject) => {
    server.stderr.on('data', chunk => { if (/38431/.test(String(chunk))) resolve(); });
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
    setTimeout(() => reject(new Error('server did not start')), 10000);
  });
  // 3.6 million three-byte characters: under 10 MB counted as characters, about 10.8 MB as bytes.
  const body = '"' + '€'.repeat(3_600_000) + '"';
  const response = await fetch('http://127.0.0.1:38431/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  }).catch(error => ({ status: error.cause?.code ?? 'error' }));
  assert.ok(response.status === 413 || response.status === 'ECONNRESET' || response.status === 'EPIPE', `expected 413, got ${response.status}`);
  console.log('SECURITY: pass');
} finally {
  server.kill();
}
