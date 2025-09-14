/**
 * Reddit authentication manager
 */

import { homedir, platform } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';

export interface AuthConfig {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  deviceId?: string;
}

export class AuthManager {
  private config: AuthConfig | null = null;
  private configPath: string;

  constructor() {
    this.configPath = this.getConfigPath();
  }

  /**
   * Load authentication configuration
   */
  async load(): Promise<AuthConfig | null> {
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
    return this.config !== null && this.config.clientId !== undefined;
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(): boolean {
    if (!this.config?.expiresAt) return true;
    return Date.now() >= this.config.expiresAt;
  }

  /**
   * Get access token for Reddit OAuth
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.config) return null;
    
    // For script apps, we can use app-only auth
    if (!this.config.accessToken || this.isTokenExpired()) {
      await this.refreshAccessToken();
    }
    
    return this.config.accessToken || null;
  }

  /**
   * Refresh access token using client credentials
   */
  async refreshAccessToken(): Promise<void> {
    if (!this.config?.clientId) {
      throw new Error('No client ID configured');
    }

    try {
      // Reddit script apps can use device_id flow without secret
      const auth = Buffer.from(`${this.config.clientId}:`).toString('base64');
      
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'RedditBuddy/1.0.0 by karanb192'
        },
        body: 'grant_type=https://oauth.reddit.com/grants/installed_client&device_id=DO_NOT_TRACK'
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get access token: ${response.status} - ${error}`);
      }

      const data = await response.json() as {
        access_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
      };

      // Update config
      this.config.accessToken = data.access_token;
      this.config.expiresAt = Date.now() + (data.expires_in * 1000);
      this.config.scope = data.scope;
      
      // Save updated config
      await this.save(this.config);
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
    return this.isAuthenticated() ? 100 : 10;
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
   * Private: Get configuration directory path based on OS
   */
  private getConfigPath(): string {
    const home = homedir();
    
    switch (platform()) {
      case 'win32':
        return join(
          process.env.APPDATA || join(home, 'AppData', 'Roaming'),
          'reddit-buddy'
        );
      case 'darwin':
        return join(home, 'Library', 'Application Support', 'reddit-buddy');
      default: // linux and others
        return join(
          process.env.XDG_CONFIG_HOME || join(home, '.config'),
          'reddit-buddy'
        );
    }
  }

  /**
   * Private: Validate configuration
   */
  private isValidConfig(config: any): config is AuthConfig {
    return config && typeof config.clientId === 'string' && config.clientId.length > 0;
  }

  /**
   * Setup wizard for authentication
   */
  static async runSetupWizard(): Promise<AuthConfig> {
    console.log('\n🚀 Reddit Buddy Authentication Setup\n');
    console.log('This will help you set up authentication for 10x more requests.\n');
    
    console.log('Step 1: Create a Reddit App');
    console.log('  1. Go to: https://www.reddit.com/prefs/apps');
    console.log('  2. Click "Create App" or "Create Another App"');
    console.log('  3. Fill in the following:');
    console.log('     - Name: Reddit Buddy (or anything you like)');
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
    
    const config: AuthConfig = {
      clientId,
      deviceId: 'DO_NOT_TRACK'
    };
    
    console.log('\n✅ Setup complete! Your authentication is configured.');
    console.log('You now have access to 100 requests per minute.\n');
    
    return config;
  }
}