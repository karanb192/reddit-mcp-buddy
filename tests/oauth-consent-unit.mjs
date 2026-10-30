import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import {
  parseOAuthArgs, parseLoopbackRedirect, buildAuthorizeUrl, listenHost, scopesFor, runOAuthConsent, writeTokenFile,
} from '../dist/core/oauth-consent.js';

const clientSecret = 'offline-client-secret';
const refreshSecret = 'offline-refresh-secret';
const accessSecret = 'offline-access-secret';
const code = 'offline-authorization-code';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function callback(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, connection: res.headers.connection }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

function redditFetch({ scope = 'identity read history', tokenStatus = 200, tokenBody, meName = 'offline_user' } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://www.reddit.com/api/v1/access_token') {
      return Response.json(tokenBody ?? { access_token: accessSecret, refresh_token: refreshSecret, token_type: 'bearer', expires_in: 3600, scope },
        { status: tokenStatus });
    }
    if (String(url) === 'https://oauth.reddit.com/api/v1/me') return Response.json(meName ? { name: meName } : {});
    throw new Error('Unexpected offline endpoint: ' + url);
  };
  return { impl, calls };
}

async function consent({ fetchOptions, scopes = scopesFor(false), respond, parallel = false, timeoutMs = 5000 } = {}) {
  const redirectUri = `http://localhost:${await freePort()}/callback`;
  const reddit = redditFetch(fetchOptions);
  const responses = [];
  let authorizeUrl;
  let browser = Promise.resolve();
  const promise = runOAuthConsent({
    clientId: 'offline-client', clientSecret, scopes, redirectUri, timeoutMs, fetch: reddit.impl,
    onAuthorizeUrl: url => { browser = (async () => {
      authorizeUrl = new URL(url);
      const state = authorizeUrl.searchParams.get('state');
      const send = query => callback(`http://127.0.0.1:${new URL(redirectUri).port}${query}`)
        .catch(error => ({ status: error.code }));
      if (parallel) responses.push(...await Promise.all(respond(state).map(send)));
      else for (const query of respond(state)) responses.push(await send(query));
    })(); },
  });
  const outcome = await promise.then(value => ({ value }), error => ({ error }));
  await browser;
  return { ...outcome, authorizeUrl, responses, calls: reddit.calls, redirectUri };
}

const tempDir = mkdtempSync(join(tmpdir(), 'reddit-oauth-consent-'));
try {
  assert.deepEqual(parseOAuthArgs(['--oauth']), { write: false, redirectUri: 'http://localhost:8080' });
  assert.deepEqual(parseOAuthArgs(['--oauth', '--write', '--redirect-uri', 'http://127.0.0.1:9000/cb', '--out', 'token.env']),
    { write: true, redirectUri: 'http://127.0.0.1:9000/cb', out: 'token.env' });
  assert.throws(() => parseOAuthArgs(['--oauth', '--out']), /needs a value/);
  assert.throws(() => parseOAuthArgs(['--oauth', '--scope', 'modposts']), /Unknown option/);
  assert.deepEqual(scopesFor(false), ['identity', 'read', 'history']);
  assert.deepEqual(scopesFor(true), ['identity', 'read', 'history', 'submit', 'flair']);

  for (const bad of ['https://localhost:8080', 'http://example.com:8080', 'http://localhost', 'http://localhost:8080/?x=1', 'not a url']) {
    assert.throws(() => parseLoopbackRedirect(bad), /redirect URI/, bad);
  }
  assert.equal(parseLoopbackRedirect('http://[::1]:8080').hostname, '[::1]');
  for (const [uri, host] of [['http://localhost:8080', '127.0.0.1'], ['http://127.0.0.1:8080', '127.0.0.1'], ['http://[::1]:8080', '::1']]) {
    assert.equal(listenHost(parseLoopbackRedirect(uri)), host, uri);
  }
  const built = new URL(buildAuthorizeUrl('cid', 'st', 'http://localhost:8080', ['identity', 'read']));
  assert.equal(built.origin + built.pathname, 'https://www.reddit.com/api/v1/authorize');
  assert.equal(built.searchParams.get('duration'), 'permanent');
  assert.equal(built.searchParams.get('scope'), 'identity read');

  // A malformed request target gets 400 and consent still completes afterwards.
  const malformedPort = await freePort();
  let malformedStatus;
  const recovered = await runOAuthConsent({ clientId: 'offline-client', clientSecret, scopes: scopesFor(false),
    redirectUri: `http://localhost:${malformedPort}`, fetch: redditFetch().impl, timeoutMs: 5000,
    onAuthorizeUrl: async url => {
      malformedStatus = await new Promise((resolve, reject) => {
        const socket = connect(malformedPort, '127.0.0.1', () => socket.end('GET //% HTTP/1.1\r\nHost: localhost\r\n\r\n'));
        let data = '';
        socket.on('data', chunk => { data += chunk; });
        socket.on('end', () => resolve(Number(data.split(' ')[1])));
        socket.on('error', reject);
      });
      await callback(`http://127.0.0.1:${malformedPort}/?state=${new URL(url).searchParams.get('state')}&code=${code}`);
    } }).then(value => ({ value }), error => ({ error }));
  assert.equal(malformedStatus, 400);
  assert.ifError(recovered.error);
  assert.equal(recovered.value.refreshToken, refreshSecret);

  // Success, after a stray request and a forged state that must not end the flow
  const ok = await consent({ respond: state => ['/favicon.ico', '/callback?state=forged&code=x', `/callback?state=${state}&code=${code}`] });
  assert.ifError(ok.error);
  assert.equal(ok.value.refreshToken, refreshSecret);
  assert.equal(ok.value.username, 'offline_user');
  assert.deepEqual(ok.responses.map(r => r.status), [404, 400, 200]);
  assert.match(ok.responses[2].body, /Authorized as u\/offline_user/);
  assert.ok(ok.responses.every(r => r.connection === 'close'), 'replies must close the connection so the CLI can exit');
  assert.equal(ok.authorizeUrl.searchParams.get('client_id'), 'offline-client');
  assert.equal(ok.authorizeUrl.searchParams.get('response_type'), 'code');
  assert.equal(ok.authorizeUrl.searchParams.get('redirect_uri'), ok.redirectUri);
  assert.equal(ok.authorizeUrl.searchParams.get('state').length, 43);
  const [tokenCall, meCall] = ok.calls;
  assert.deepEqual([...new URLSearchParams(tokenCall.init.body)],
    [['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', ok.redirectUri]]);
  assert.equal(tokenCall.init.headers.Authorization, 'Basic ' + Buffer.from('offline-client:' + clientSecret).toString('base64'));
  assert.equal(meCall.init.headers.Authorization, 'Bearer ' + accessSecret);
  for (const response of ok.responses) {
    for (const secret of [clientSecret, refreshSecret, accessSecret, code]) assert.ok(!response.body.includes(secret));
  }

  // Loopback only: while the callback server listens, a non-loopback address of
  // this machine must refuse the connection.
  const external = Object.values(networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  if (external) {
    const probePort = await freePort();
    let reached;
    const pending = runOAuthConsent({ clientId: 'c', clientSecret: 's', scopes: ['identity'], timeoutMs: 2000,
      redirectUri: `http://localhost:${probePort}`, fetch: redditFetch().impl,
      onAuthorizeUrl: () => { reached = callback(`http://${external.address}:${probePort}/`, 500).then(r => r.status, e => e.code); } });
    await pending.catch(() => {});
    assert.ok(['ECONNREFUSED', 'ETIMEDOUT'].includes(await reached), 'the callback server must not listen on non-loopback interfaces');
  } else {
    console.log('  (no non-loopback IPv4 interface; bind check skipped)');
  }

  const denied = await consent({ respond: state => [`/callback?state=${state}&error=access_denied`] });
  assert.match(denied.error.message, /not granted/);
  assert.equal(denied.calls.length, 0);

  const rejected = await consent({
    fetchOptions: { tokenStatus: 400, tokenBody: { error: 'invalid_grant', error_description: refreshSecret } },
    respond: state => [`/callback?state=${state}&code=${code}`],
  });
  assert.match(rejected.error.message, /HTTP 400 \(invalid_grant\)/);
  assert.ok(!rejected.error.message.includes(refreshSecret));

  const temporary = await consent({
    fetchOptions: { tokenBody: { access_token: accessSecret, token_type: 'bearer', expires_in: 3600, scope: 'identity read history' } },
    respond: state => [`/callback?state=${state}&code=${code}`],
  });
  assert.match(temporary.error.message, /did not return a refresh token/);

  const narrow = await consent({ scopes: scopesFor(true), respond: state => [`/callback?state=${state}&code=${code}`] });
  assert.match(narrow.error.message, /did not grant the requested scopes: submit, flair/);

  const anonymous = await consent({ fetchOptions: { meName: '' }, respond: state => [`/callback?state=${state}&code=${code}`] });
  assert.match(anonymous.error.message, /Could not verify the authorized account/);

  const replay = await consent({ parallel: true, respond: state => [`/callback?state=${state}&code=${code}`, `/callback?state=${state}&code=${code}`] });
  assert.ifError(replay.error);
  // The second request either gets 409 or, if it lands after the server closed, a reset connection; never a second success.
  const replayStatuses = replay.responses.map(r => r.status);
  assert.equal(replayStatuses.filter(status => status === 200).length, 1, String(replayStatuses));
  assert.ok(replayStatuses.every(status => [200, 409, 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(status)), String(replayStatuses));
  assert.equal(replay.calls.filter(call => call.url.endsWith('/access_token')).length, 1, 'a replayed callback must not exchange twice');

  const timedOut = await consent({ timeoutMs: 50, respond: () => [] });
  assert.match(timedOut.error.message, /Timed out/);

  // An accepted callback stops the consent timer, so a slow exchange still delivers the token.
  const slow = redditFetch();
  const slowFetch = async (url, init) => { await new Promise(r => setTimeout(r, 300)); return slow.impl(url, init); };
  const slowPort = await freePort();
  const late = await runOAuthConsent({ clientId: 'c', clientSecret: 's', scopes: ['identity'], timeoutMs: 150,
    redirectUri: `http://localhost:${slowPort}`, fetch: slowFetch,
    onAuthorizeUrl: url => { callback(`http://127.0.0.1:${slowPort}/?state=${new URL(url).searchParams.get('state')}&code=${code}`); } })
    .then(value => ({ value }), error => ({ error }));
  assert.ifError(late.error);
  assert.equal(late.value.refreshToken, refreshSecret);

  const busyPort = await freePort();
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(busyPort, '127.0.0.1', resolve));
  try {
    await assert.rejects(runOAuthConsent({ clientId: 'c', clientSecret: 's', scopes: ['identity'],
      redirectUri: `http://localhost:${busyPort}`, onAuthorizeUrl: () => {}, fetch: redditFetch().impl }), /is in use/);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }

  const tokenFile = join(tempDir, 'token.env');
  await writeTokenFile(tokenFile, refreshSecret);
  assert.equal(readFileSync(tokenFile, 'utf8'), `REDDIT_REFRESH_TOKEN=${refreshSecret}\n`);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const existing = join(tempDir, 'existing.env');
  writeFileSync(existing, 'keep\n');
  await assert.rejects(writeTokenFile(existing, refreshSecret), /EEXIST/);
  assert.equal(readFileSync(existing, 'utf8'), 'keep\n');

  console.log('OAUTH-CONSENT: pass');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
