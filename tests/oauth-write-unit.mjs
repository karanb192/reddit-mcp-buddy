import assert from 'node:assert/strict';
import { createSharedServices, createMCPServer } from '../dist/mcp-server.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const services = [];
const required = ['identity', 'read', 'submit', 'flair'];
let scopes = required.join(' ');
let identity = 'offline_user';
let rejectGrant = false;
let rejectPost = false;
let refreshes = 0;
let posts = 0;
const token = () => Response.json({ access_token: 'offline-access-token', token_type: 'bearer', expires_in: 3600, scope: scopes });
async function shared() {
  const service = await createSharedServices();
  services.push(service);
  return service;
}
async function toolCount(service) {
  const server = await createMCPServer(service, { transport: 'stdio' });
  return (await server.handlers['tools/list']()).tools.length;
}
try {
  for (const key of Object.keys(process.env)) if (key.startsWith('REDDIT_')) delete process.env[key];
  Object.assign(process.env, { REDDIT_CLIENT_ID: 'offline-client', REDDIT_CLIENT_SECRET: 'offline-secret',
    REDDIT_REFRESH_TOKEN: 'offline-refresh', REDDIT_BUDDY_WRITE: 'true' });
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/access_token') {
      refreshes++;
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
      return rejectGrant ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : token();
    }
    if (path === '/api/v1/me') return Response.json(identity ? { name: identity } : {});
    if (path === '/api/submit') {
      posts++;
      return rejectPost ? new Response('', { status: 401 }) : Response.json({});
    }
    throw new Error('Unexpected offline endpoint: ' + path);
  };

  const valid = await shared();
  assert.equal(valid.writeStatus.enabled, true);
  assert.equal(valid.actingUser, identity);
  assert.equal(await toolCount(valid), 8);
  for (const missing of required) {
    scopes = required.filter(scope => scope !== missing).join(' ');
    const denied = await shared();
    assert.equal(denied.writeStatus.enabled, false);
    assert.match(denied.writeStatus.reason, /scopes/);
    assert.equal(await toolCount(denied), 5);
  }
  scopes = required.join(' ');
  process.env.REDDIT_USERNAME = 'another_user';
  const mismatch = await shared();
  assert.equal(mismatch.writeStatus.enabled, false);
  assert.match(mismatch.writeStatus.reason, /does not match/);
  process.env.REDDIT_USERNAME = identity.toUpperCase();
  assert.equal((await shared()).writeStatus.enabled, true);
  delete process.env.REDDIT_USERNAME;
  identity = '';
  assert.equal((await shared()).writeStatus.enabled, false);
  identity = 'offline_user';
  rejectGrant = true;
  const revoked = await shared();
  assert.equal(revoked.writeStatus.enabled, false);
  assert.match(revoked.writeStatus.reason, /invalid_grant/);
  rejectGrant = false;

  const before = refreshes;
  process.env.REDDIT_BUDDY_WRITE = 'false';
  assert.equal(await toolCount(await shared()), 5);
  process.env.REDDIT_BUDDY_WRITE = 'true';
  process.env.REDDIT_BUDDY_HTTP = 'true';
  assert.equal(await toolCount(await shared()), 5);
  assert.equal(refreshes, before, 'disabled and HTTP modes must not probe credentials');
  delete process.env.REDDIT_BUDDY_HTTP;

  const api = valid.writeTools.api;
  rejectPost = true;
  await assert.rejects(api.postForm('/api/submit', new URLSearchParams()), /Not resubmitting automatically/);
  assert.equal(posts, 1);
  assert.equal(refreshes, before, 'a rejected write must not refresh and resubmit');
  rejectPost = false;
  await api.postForm('/api/submit', new URLSearchParams());
  assert.equal(posts, 2);
  assert.equal(refreshes, before + 1, 'the next explicit call refreshes before sending');
  console.log('OAUTH-WRITE: pass');
} finally {
  for (const service of services) service.cacheManager.destroy();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
