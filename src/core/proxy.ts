/**
 * Proxy support for Node fetch (undici).
 *
 * Why:
 * - Many cloud/server IPs are blocked by Reddit (403).
 * - We want to route ONLY reddit-mcp-buddy outbound HTTP(S) via a user-provided proxy.
 *
 * Supported env vars:
 * - HTTP_PROXY / HTTPS_PROXY / NO_PROXY (HTTP(S) proxy)
 * - ALL_PROXY (typically SOCKS5)
 *
 * Notes:
 * - For SOCKS5 with DNS over proxy, prefer: ALL_PROXY=socks5h://user:pass@host:port
 * - We only enable the proxy dispatcher if any proxy env var is set.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

function hasProxyEnv(): boolean {
  const v = (s?: string) => (s || '').trim();
  return Boolean(v(process.env.ALL_PROXY) || v(process.env.HTTP_PROXY) || v(process.env.HTTPS_PROXY));
}

export function setupProxyFromEnv(): void {
  if (!hasProxyEnv()) return;

  // EnvHttpProxyAgent reads standard env vars (HTTP_PROXY/HTTPS_PROXY/NO_PROXY/ALL_PROXY).
  // This makes global fetch() honor proxy settings without touching request sites.
  setGlobalDispatcher(new EnvHttpProxyAgent());

  // Keep logs minimal but helpful.
  console.error('🌐 Proxy enabled via env (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY)');
}

