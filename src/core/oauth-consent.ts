/**
 * One-time OAuth consent for an approved Reddit web app (reddit-mcp-buddy --oauth).
 * Runs Reddit's authorization-code flow against a loopback callback and returns
 * the refresh token that REDDIT_REFRESH_TOKEN expects. It never posts, and it
 * never prints the client secret, the authorization code, or an access token.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';

export const READ_SCOPES = ['identity', 'read', 'history'] as const;
export const WRITE_SCOPES = ['submit', 'flair'] as const;

const AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const ME_URL = 'https://oauth.reddit.com/api/v1/me';
const DEFAULT_REDIRECT_URI = 'http://localhost:8080';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'RedditBuddy/1.0 (by /u/karanb192)';
const OAUTH_ERROR_CODES = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type', 'invalid_request', 'invalid_scope'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface OAuthArgs {
  write: boolean;
  redirectUri: string;
  out?: string;
}

export interface OAuthConsentOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  redirectUri: string;
  timeoutMs?: number;
  /** Receives the URL the user must open; the flow waits for its callback. */
  onAuthorizeUrl: (url: string) => void;
  fetch?: typeof fetch;
}

export interface OAuthConsentResult {
  refreshToken: string;
  username: string;
  scopes: string[];
}

export function parseOAuthArgs(argv: string[]): OAuthArgs {
  const args: OAuthArgs = { write: false, redirectUri: DEFAULT_REDIRECT_URI };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--oauth') continue;
    if (arg === '--write') {
      args.write = true;
    } else if (arg === '--redirect-uri' || arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--out') args.out = value;
      else args.redirectUri = value;
    } else {
      throw new Error(`Unknown option for --oauth: ${arg}`);
    }
  }
  return args;
}

export function scopesFor(write: boolean): string[] {
  return write ? [...READ_SCOPES, ...WRITE_SCOPES] : [...READ_SCOPES];
}

/**
 * The callback must stay on this machine: a non-loopback redirect would send the
 * authorization code to whatever host the URI names.
 */
export function parseLoopbackRedirect(redirectUri: string): URL {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error(`Invalid redirect URI: ${redirectUri}`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname) || !url.port) {
    throw new Error('The redirect URI must be http://localhost:<port> (or 127.0.0.1) with an explicit port, matching the one registered for your Reddit app.');
  }
  if (url.search || url.hash) {
    throw new Error('The redirect URI must not contain a query string or fragment.');
  }
  return url;
}

export function buildAuthorizeUrl(clientId: string, state: string, redirectUri: string, scopes: readonly string[]): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    duration: 'permanent',
    scope: scopes.join(' '),
  }).toString();
  return url.toString();
}

function sameState(supplied: string | null, expected: string): boolean {
  const a = Buffer.from(supplied ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function oauthErrorCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : '';
  return OAUTH_ERROR_CODES.includes(code) ? code : 'unknown_error';
}

export function runOAuthConsent(options: OAuthConsentOptions): Promise<OAuthConsentResult> {
  const redirect = parseLoopbackRedirect(options.redirectUri);
  const fetchImpl = options.fetch ?? fetch;
  const state = randomBytes(32).toString('base64url');
  const expectedPath = redirect.pathname || '/';
  const basic = 'Basic ' + Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');

  const exchange = async (code: string): Promise<OAuthConsentResult> => {
    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUri }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Reddit did not issue a token: HTTP ${tokenResponse.status} (${await oauthErrorCode(tokenResponse)})`);
    }
    const token = await tokenResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (!token || 'error' in token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
      throw new Error('Reddit did not return a refresh token. Check that the app is a web app and the consent used duration=permanent.');
    }
    const granted = String(token.scope ?? '').split(/\s+/).filter(Boolean);
    const missing = options.scopes.filter(scope => !granted.includes(scope) && !granted.includes('*'));
    if (missing.length > 0) {
      throw new Error(`Reddit did not grant the requested scopes: ${missing.join(', ')}`);
    }
    const meResponse = await fetchImpl(ME_URL, {
      headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const me = meResponse.ok ? await meResponse.json().catch(() => null) as { name?: unknown } | null : null;
    if (typeof me?.name !== 'string' || !me.name) {
      throw new Error(`Could not verify the authorized account: HTTP ${meResponse.status}`);
    }
    return { refreshToken: token.refresh_token, username: me.name, scopes: granted };
  };

  return new Promise<OAuthConsentResult>((resolve, reject) => {
    let settled = false;
    let handling = false;
    const finish = (error: Error | null, result?: OAuthConsentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(result as OAuthConsentResult);
    };
    const reply = (res: ServerResponse, status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(message);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', redirect);
      // Stray requests (favicon, probes, a stale tab) must not end the flow.
      if (req.method !== 'GET' || url.pathname !== expectedPath) {
        reply(res, 404, 'Not found.');
        return;
      }
      if (!sameState(url.searchParams.get('state'), state)) {
        reply(res, 400, 'This authorization link is stale or was not started here. Use the link printed in your terminal.');
        return;
      }
      if (handling || settled) {
        reply(res, 409, 'This authorization was already processed.');
        return;
      }
      handling = true;
      // From here the exchange settles the flow on its own request timeouts; a
      // consent timer firing mid-exchange would drop a token Reddit already issued.
      clearTimeout(timer);
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code) {
        reply(res, 400, 'Authorization was not granted. You can close this tab.');
        finish(new Error('Authorization was not granted on Reddit.'));
        return;
      }
      exchange(code).then(
        result => {
          reply(res, 200, `Authorized as u/${result.username}. Return to your terminal; you can close this tab.`);
          finish(null, result);
        },
        error => {
          reply(res, 500, 'Authorization failed. Check your terminal for details.');
          finish(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for Reddit authorization. Run the command again.')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    server.on('error', (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === 'EADDRINUSE'
        ? `Port ${redirect.port} is in use. Free it or register another loopback redirect URI and pass --redirect-uri.`
        : `Could not start the local callback server: ${error.message}`));
    });
    // Loopback only, never all interfaces. "localhost" binds IPv4, which browsers
    // reach for localhost redirects even when ::1 resolves first.
    const host = redirect.hostname === '[::1]' ? '::1' : '127.0.0.1';
    server.listen(Number(redirect.port), host, () => {
      options.onAuthorizeUrl(buildAuthorizeUrl(options.clientId, state, options.redirectUri, options.scopes));
    });
  });
}

/** Write the token as an env line readable only by the owner; never overwrite. */
export async function writeTokenFile(path: string, refreshToken: string): Promise<void> {
  await fs.writeFile(path, `REDDIT_REFRESH_TOKEN=${refreshToken}\n`, { mode: 0o600, flag: 'wx' });
}
