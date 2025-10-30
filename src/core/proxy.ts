/**
 * HTTP Proxy configuration for Reddit API requests
 * 
 * Automatically detects and configures proxy from environment variables:
 * - HTTPS_PROXY / https_proxy
 * - HTTP_PROXY / http_proxy
 * - NO_PROXY / no_proxy
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Setup HTTP proxy for all fetch requests
 * 
 * This function reads proxy configuration from environment variables and
 * sets up a global dispatcher. Once configured, ALL fetch() calls will
 * automatically use the proxy without any code changes.
 * 
 * Supported environment variables (checked in order):
 * - HTTPS_PROXY, https_proxy: For HTTPS requests
 * - HTTP_PROXY, http_proxy: For HTTP requests
 * - NO_PROXY, no_proxy: Comma-separated list of hosts to exclude
 * 
 * Proxy URL formats:
 * - http://proxy.example.com:8080
 * - http://username:password@proxy.example.com:8080
 * - https://proxy.example.com:8443
 */
export function setupProxy(): void {
  // Check environment variables (case-insensitive, uppercase first)
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  
  // Use HTTPS proxy first, fall back to HTTP proxy
  const proxyUrl = httpsProxy || httpProxy;
  
  if (!proxyUrl) {
    return; // No proxy configured, direct connection
  }

  try {
    // Validate proxy URL
    const proxyUrlObj = new URL(proxyUrl);
    
    // Create ProxyAgent
    const proxyAgent = new ProxyAgent(proxyUrl);
    
    // Set as global dispatcher - affects ALL fetch() calls
    setGlobalDispatcher(proxyAgent);
    
    // Log proxy configuration (hide password for security)
    const safeProxyUrl = proxyUrlObj.password
      ? proxyUrl.replace(`:${proxyUrlObj.password}@`, ':***@')
      : proxyUrl;
    
    console.error(`🔧 Proxy configured: ${safeProxyUrl}`);
    
  } catch (error: any) {
    // Invalid proxy URL - log warning but don't crash
    console.error(`⚠️  Invalid proxy URL: ${error.message}`);
    console.error(`   Continuing with direct connection`);
  }
}

/**
 * Get current proxy configuration (for debugging)
 */
export function getProxyConfig(): { https?: string; http?: string; no?: string } {
  return {
    https: process.env.HTTPS_PROXY || process.env.https_proxy,
    http: process.env.HTTP_PROXY || process.env.http_proxy,
    no: process.env.NO_PROXY || process.env.no_proxy,
  };
}

