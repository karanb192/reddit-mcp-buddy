/**
 * Reddit authentication manager
 */

import { homedir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';

export interface AuthConfig {
  clientId: string;
  clientSecret: string;  // Required for script apps
  username?: string;     // For script app auth
  password?: string;     // Never stored, only used temporarily
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  userAgent?: string;
}

// Zod schema for OAuth token response validation
const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1, 'access_token must not be empty'),
  token_type: z.string().min(1, 'token_type must not be empty'),
  expires_in: z.number().positive('expires_in must be positive'),
  scope: z.string(),
}).strict().passthrough(); // Strict mode + passthrough for extra fields

export class AuthManager {
  private config: AuthConfig | null = null;
  private configPath: string;
  // Lock for token refresh to prevent concurrent refresh attempts (race conditions)
  private tokenRefreshPromise: Promise<void> | null = null;
  // Token expiration buffer (refresh 10 seconds before actual expiration to handle clock drift)
  private readonly TOKEN_EXPIRATION_BUFFER_MS = 10000;

  constructor() {
    this.configPath = this.getConfigPath();
  }

  /**
   * Load authentication configuration
   */
  async load(): Promise<AuthConfig | null> {
    // First check environment variables
    const envConfig = this.loadFromEnv();
    if (envConfig) {
      this.config = envConfig;
      return this.config;
    }

    // Then check config file
    try {
      const configFile = join(this.configPath, 'auth.json');
      const data = await fs.readFile(configFile, 'utf-8');
      this.config = JSON.parse(data);

      // Validate config
      if (this.config && !this.isValidConfig(this.config)) {
        console.error('Invalid auth configuration found');
        this.config = null;
      }

      return this.config;
    } catch (error) {
      // No auth configured or invalid file
      return null;
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnv(): AuthConfig | null {
    const clientId = this.cleanEnvVar(process.env.REDDIT_CLIENT_ID);
    const clientSecret = this.cleanEnvVar(process.env.REDDIT_CLIENT_SECRET);
    const username = this.cleanEnvVar(process.env.REDDIT_USERNAME);
    const password = this.cleanEnvVar(process.env.REDDIT_PASSWORD);
    const userAgent = this.cleanEnvVar(process.env.REDDIT_USER_AGENT);

    // Need at least client ID and secret for script apps
    if (!clientId || !clientSecret) {
      return null;
    }

    return {
      clientId,
      clientSecret,
      username,
      password,
      userAgent: userAgent || 'RedditBuddy/1.0 (by /u/karanb192)'
    };
  }

  /**
   * Clean environment variable value
   * Handles empty strings, undefined, and unresolved template strings
   */
  private cleanEnvVar(value: string | undefined): string | undefined {
    if (!value) return undefined;

    const trimmed = value.trim();

    // Treat empty strings as undefined
    if (trimmed === '') return undefined;

    // Treat unresolved template strings as undefined
    // (happens when Claude Desktop doesn't have the config value set)
    // Handles various template patterns:
    // - ${VAR} - standard template
    // - ${VAR:-default} - template with default
    // - ${${VAR}} - nested template
    // - ${ or } alone - partial/malformed templates
    // - ${VAR}${VAR2} - multiple templates
    if (this.containsUnresolvedTemplate(trimmed)) {
      return undefined;
    }

    return trimmed;
  }

  /**
   * Check if a string contains unresolved template patterns
   */
  private containsUnresolvedTemplate(value: string): boolean {
    // Check for any ${...} pattern (including nested, with defaults, etc.)
    if (/\$\{[^}]*\}/.test(value)) {
      return true;
    }

    // Check for unclosed template start: ${ without matching }
    if (value.includes('${') && !value.includes('}')) {
      return true;
    }

    // Check for orphaned template syntax that looks like unresolved vars
    // e.g., "$REDDIT_CLIENT_ID" without braces (common in some configs)
    if (/\$[A-Z_][A-Z0-9_]*/.test(value)) {
      return true;
    }

    return false;
  }

  /**
   * Save authentication configuration
   */
  async save(config: AuthConfig): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.configPath, { recursive: true });

      // Save config
      const configFile = join(this.configPath, 'auth.json');
      await fs.writeFile(
        configFile,
        JSON.stringify(config, null, 2),
        { mode: 0o600 } // Read/write for owner only
      );

      // Verify file permissions were actually applied (security check)
      const stats = await fs.stat(configFile);
      const mode = stats.mode & parseInt('777', 8); // Extract permission bits
      if (mode !== 0o600) {
        console.error(`Warning: Auth file permissions are ${mode.toString(8)}, expected 600`);
        // On some systems, chmod after write may be needed
        try {
          await fs.chmod(configFile, 0o600);
        } catch (chmodError) {
          throw new Error(`Failed to set auth file permissions to 0o600: ${chmodError}`);
        }
      }

      this.config = config;
    } catch (error) {
      throw new Error(`Failed to save auth configuration: ${error}`);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): AuthConfig | null {
    return this.config;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this.config !== null &&
           this.config.clientId !== undefined &&
           this.config.clientSecret !== undefined;
  }

  /**
   * Check if token is expired or will expire soon (including buffer for clock drift)
   * Returns true if:
   * - No expiresAt set
   * - Current time >= expiresAt
   * - Current time >= expiresAt - buffer (to handle clock drift and refresh early)
   */
  isTokenExpired(): boolean {
    if (!this.config?.expiresAt || this.config.expiresAt <= 0) return true;
    // Consider token expired if we're within the buffer time before actual expiration
    // This prevents using an expired token due to clock drift between client and server
    const expirationThreshold = this.config.expiresAt - this.TOKEN_EXPIRATION_BUFFER_MS;
    return Date.now() >= expirationThreshold;
  }

  /**
   * Get access token for Reddit OAuth
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.config) return null;

    // For script apps, we can use app-only auth
    if (!this.config.accessToken || this.isTokenExpired()) {
      // Wait for any in-flight refresh to complete, or start a new one
      if (this.tokenRefreshPromise) {
        await this.tokenRefreshPromise;
      } else {
        await this.refreshAccessToken();
      }
    }

    return this.config.accessToken || null;
  }

  /**
   * Refresh access token using client credentials
   * Uses a lock to prevent concurrent refresh attempts (race conditions)
   */
  async refreshAccessToken(): Promise<void> {
    // If a refresh is already in progress, wait for it to complete
    if (this.tokenRefreshPromise) {
      await this.tokenRefreshPromise;
      return;
    }

    // Create a promise for this refresh and store it
    const refreshPromise = this.doRefreshAccessToken();
    this.tokenRefreshPromise = refreshPromise;

    try {
      await refreshPromise;
    } finally {
      // Clear the promise when done (success or error)
      this.tokenRefreshPromise = null;
    }
  }

  /**
   * Internal implementation of token refresh (protected by lock)
   */
  private async doRefreshAccessToken(): Promise<void> {
    if (!this.config?.clientId || !this.config?.clientSecret) {
      throw new Error('No client credentials configured');
    }

    try {
      // Reddit script apps use password grant type
      const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

      let body: string;

      if (this.config.username && this.config.password) {
        // Use password grant for authenticated requests (100 req/min)
        body = new URLSearchParams({
          grant_type: 'password',
          username: this.config.username,
          password: this.config.password,
        }).toString();
      } else {
        // Use client credentials grant for anonymous requests (still better than no auth)
        body = new URLSearchParams({
          grant_type: 'client_credentials',
        }).toString();
      }

      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.config.userAgent || 'RedditBuddy/1.0 (by /u/karanb192)'
        },
        body
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get access token: ${response.status} - ${error}`);
      }

      const rawData = await response.json();

      // Validate token response structure
      let data;
      try {
        data = OAuthTokenResponseSchema.parse(rawData);
      } catch (validationError) {
        if (validationError instanceof z.ZodError) {
          const issues = validationError.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
          throw new Error(`Invalid OAuth token response format: ${issues}`);
        }
        throw new Error('Failed to validate OAuth token response');
      }

      // Validate token format (basic JWT-like check)
      const tokenParts = data.access_token.split('.');
      if (tokenParts.length < 1 || data.access_token.length < 10) {
        throw new Error('Invalid access token format received from Reddit');
      }

      // Validate token expiration time (boundary check)
      const MAX_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60; // 1 year max
      if (data.expires_in <= 0 || data.expires_in > MAX_TOKEN_LIFETIME_SECONDS) {
        throw new Error(`Invalid token expiration time: ${data.expires_in}s is unreasonable`);
      }

      // Calculate expiration time
      const expiresAt = Date.now() + (data.expires_in * 1000);

      // Sanity check: expiration time should be in the future
      if (expiresAt <= Date.now()) {
        throw new Error('Token expiration time is in the past');
      }

      // Update config
      this.config.accessToken = data.access_token;
      this.config.expiresAt = expiresAt;
      this.config.scope = data.scope;

      // Never save password to disk
      const configToSave = { ...this.config };
      delete configToSave.password;

      // Save updated config
      await this.save(configToSave);
    } catch (error) {
      throw new Error(`Failed to refresh access token: ${error}`);
    }
  }

  /**
   * Clear authentication
   */
  async clear(): Promise<void> {
    this.config = null;
    
    try {
      const configFile = join(this.configPath, 'auth.json');
      await fs.unlink(configFile);
    } catch {
      // File might not exist
    }
  }

  /**
   * Get headers for Reddit API requests
   */
  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': 'RedditBuddy/1.0 (by /u/karanb192)',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    };

    const token = await this.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * Get rate limit based on auth status
   */
  getRateLimit(): number {
    if (!this.isAuthenticated()) {
      return 10; // No auth at all
    }
    // Full auth with username/password: 100, app-only: 60
    return (this.config?.username && this.config?.password) ? 100 : 60;
  }

  /**
   * Get cache TTL based on auth status (in ms)
   */
  getCacheTTL(): number {
    return this.isAuthenticated()
      ? 5 * 60 * 1000  // 5 minutes for authenticated
      : 15 * 60 * 1000; // 15 minutes for unauthenticated
  }

  /**
   * Check if we have full authentication (with user credentials)
   */
  hasFullAuth(): boolean {
    return this.isAuthenticated() &&
           !!this.config?.username &&
           !!this.config?.password;
  }

  /**
   * Get auth mode string for display
   */
  getAuthMode(): string {
    if (!this.isAuthenticated()) {
      return 'Anonymous';
    }
    return this.hasFullAuth() ? 'Authenticated' : 'App-Only';
  }

  /**
   * Private: Get configuration directory path based on OS
   */
  private getConfigPath(): string {
    return join(homedir(), '.reddit-mcp-buddy');
  }

  /**
   * Private: Validate configuration
   */
  private isValidConfig(config: any): config is AuthConfig {
    return config &&
           typeof config.clientId === 'string' && config.clientId.length > 0 &&
           typeof config.clientSecret === 'string' && config.clientSecret.length > 0;
  }

  /**
   * Setup wizard for authentication
   */
  static async runSetupWizard(): Promise<AuthConfig> {
    console.log('\n🚀 Reddit MCP Buddy Authentication Setup\n');
    console.log('This will help you set up authentication for 10x more requests.\n');
    
    console.log('Step 1: Create a Reddit App');
    console.log('  1. Go to: https://www.reddit.com/prefs/apps');
    console.log('  2. Click "Create App" or "Create Another App"');
    console.log('  3. Fill in the following:');
    console.log('     - Name: Reddit MCP Buddy (or anything you like)');
    console.log('     - App type: Select "script"');
    console.log('     - Description: Personal use');
    console.log('     - About URL: (leave blank)');
    console.log('     - Redirect URI: http://localhost:8080');
    console.log('  4. Click "Create app"\n');
    
    console.log('Step 2: Copy your Client ID');
    console.log('  - Find it under "personal use script"');
    console.log('  - It looks like: XaBcDeFgHiJkLm\n');
    
    // In a real implementation, we'd use a prompt library here
    console.log('Please enter your Client ID and press Enter:');
    
    // This is a placeholder - in real implementation, use readline or a prompt library
    const clientId = 'YOUR_CLIENT_ID_HERE';
    
    // Validate client ID format
    if (!/^[A-Za-z0-9_-]{10,30}$/.test(clientId)) {
      throw new Error('Invalid Client ID format');
    }
    
    // This method is deprecated - use CLI setup instead
    throw new Error('Please use "reddit-mcp-buddy --auth" for authentication setup');
  }
}