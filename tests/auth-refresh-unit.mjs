import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthManager } from '../dist/core/auth.js';
import { RedditAPI } from '../dist/services/reddit-api.js';
import { CacheManager } from '../dist/core/cache.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const directory = mkdtempSync(join(tmpdir(), 'reddit-oauth-unit-'));
const configFile = join(directory, 'auth.json');
const refreshSecret = 'offline-refresh-secret';
function env(extra = {}) {
  for (const key of Object.keys(process.env)) if (key.startsWith('REDDIT_')) delete process.env[key];
  Object.assign(process.env, { REDDIT_CLIENT_ID: 'offline-client', REDDIT_CLIENT_SECRET: 'offline-secret', ...extra });
}
function manager() {
  const auth = new AuthManager();
  auth.configPath = directory;
  return auth;
}
function token(scope = 'identity read history') {
  return Response.json({ access_token: 'offline-access-token', token_type: 'bearer', expires_in: 3600, scope });
}
try {
  env({ REDDIT_REFRESH_TOKEN: refreshSecret });
  const auth = manager();
  await auth.load();
  assert.equal(auth.hasFullAuth(), false);
  assert.equal(auth.hasUserContext(), true);
  assert.equal(auth.getRateLimit(), 100);
  assert.equal(auth.getAuthMode(), 'Authenticated (OAuth refresh token)');
  assert.equal(auth.hasScopes(['read']), false, 'scopes are unknown until an access token is obtained');
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.reddit.com/api/v1/access_token');
    assert.deepEqual([...new URLSearchParams(options.body)], [['grant_type', 'refresh_token'], ['refresh_token', refreshSecret]]);
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('offline-client:offline-secret').toString('base64'));
    return token();
  };
  await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(calls, 1, 'concurrent calls must share one token exchange');
  assert.equal(auth.hasScopes(['identity', 'read', 'history']), true);
  assert.equal(auth.hasScopes(['submit']), false);
  assert.equal(existsSync(configFile), false, 'environment tokens must not be persisted');
  auth.getConfig().expiresAt = 0;
  await auth.getAccessToken();
  assert.equal(calls, 2);
  assert.equal(auth.getConfig().refreshToken, refreshSecret, 'retain the long-lived token when the response omits it');

  for (const errorResponse of [
    () => Response.json({ error: 'invalid_grant', error_description: refreshSecret }, { status: 400 }),
    () => Response.json({ error: refreshSecret }, { status: 403 }),
    () => new Response(refreshSecret, { status: 200 }),
    () => Response.json({ error: refreshSecret }),
  ]) {
    auth.getConfig().expiresAt = 0;
    globalThis.fetch = async () => errorResponse();
    await assert.rejects(auth.getAccessToken(), error => !error.message.includes(refreshSecret) && /Failed to refresh/.test(error.message));
  }
  auth.getConfig().expiresAt = 0;
  globalThis.fetch = async () => { throw new Error('transport echoed ' + refreshSecret + ' offline-secret'); };
  await assert.rejects(auth.getAccessToken(), error => !error.message.includes(refreshSecret) && !error.message.includes('offline-secret'));
  auth.getConfig().expiresAt = 0;
  globalThis.fetch = async () => token('*');
  await auth.getAccessToken();
  assert.equal(auth.hasScopes(['submit', 'edit']), true);

  const cache = new CacheManager();
  try {
    const api = new RedditAPI({ authManager: auth, cacheManager: cache,
      rateLimiter: { canMakeRequest: () => true, recordRequest() {} } });
    globalThis.fetch = async url => String(url).includes('access_token')
      ? Response.json({ error: 'invalid_grant' }, { status: 400 })
      : new Response('', { status: 401 });
    await assert.rejects(api.search('test'), /Reauthorize your Reddit app and update REDDIT_REFRESH_TOKEN/);
  } finally { cache.destroy(); }

  env({ REDDIT_REFRESH_TOKEN: refreshSecret, REDDIT_PASSWORD: 'offline-password' });
  await assert.rejects(manager().load(), /not both/);
  env({ REDDIT_REFRESH_TOKEN: refreshSecret });
  delete process.env.REDDIT_CLIENT_SECRET;
  await assert.rejects(manager().load(), /requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET/);
  delete process.env.REDDIT_CLIENT_ID;
  await assert.rejects(manager().load(), /requires/);

  env({ REDDIT_REFRESH_TOKEN: '${user_config.reddit_refresh_token}' });
  const optional = manager();
  await optional.load();
  assert.equal(optional.usesRefreshToken(), false, 'unresolved optional extension values are ignored');
  assert.equal(optional.getRateLimit(), 60);

  env({ REDDIT_USERNAME: 'offline-user', REDDIT_PASSWORD: 'offline-password' });
  const password = manager();
  await password.load();
  globalThis.fetch = async (url, options) => {
    assert.deepEqual([...new URLSearchParams(options.body)], [['grant_type', 'password'], ['username', 'offline-user'], ['password', 'offline-password']]);
    return token('*');
  };
  await password.getAccessToken();
  assert.equal(password.hasFullAuth(), true);
  assert.equal(password.getAuthMode(), 'Authenticated');
  assert.equal(password.getRateLimit(), 100);

  writeFileSync(configFile, JSON.stringify({ clientId: 'file-client', clientSecret: 'file-secret', refreshToken: refreshSecret }), { mode: 0o600 });
  for (const key of Object.keys(process.env)) if (key.startsWith('REDDIT_')) delete process.env[key];
  await auth.load();
  assert.equal(auth.usesRefreshToken(), false, 'reloading from disk clears environment provenance');
  assert.equal(auth.hasUserContext(), false, 'a file token must not select the new user-auth route');
  globalThis.fetch = async (url, options) => {
    assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
    return token();
  };
  await auth.getAccessToken();
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).refreshToken, undefined);
  console.log('AUTH-REFRESH: pass');
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
}
