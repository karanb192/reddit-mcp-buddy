/**
 * Reddit API client with built-in error handling and retries
 */

import { 
  RedditPost, 
  RedditComment, 
  RedditUser, 
  RedditSubreddit, 
  RedditListing 
} from '../types/reddit.types.js';
import { AuthManager } from '../core/auth.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { CacheManager } from '../core/cache.js';

export interface RedditAPIOptions {
  authManager: AuthManager;
  rateLimiter: RateLimiter;
  cacheManager: CacheManager;
  timeout?: number;
}

export class RedditAPI {
  private auth: AuthManager;
  private rateLimiter: RateLimiter;
  private cache: CacheManager;
  private timeout: number;
  private baseUrl = 'https://www.reddit.com';
  private oauthUrl = 'https://oauth.reddit.com';

  constructor(options: RedditAPIOptions) {
    this.auth = options.authManager;
    this.rateLimiter = options.rateLimiter;
    this.cache = options.cacheManager;
    this.timeout = options.timeout ?? 10000; // Increased timeout to 10 seconds
  }

  /**
   * Browse a subreddit
   */
  async browseSubreddit(
    subreddit: string,
    sort: 'hot' | 'new' | 'top' | 'rising' | 'controversial' = 'hot',
    options: {
      limit?: number;
      time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
      after?: string;
    } = {}
  ): Promise<RedditListing<RedditPost>> {
    // Validate and clean subreddit name
    if (!subreddit || subreddit.trim() === '') {
      throw new Error('Subreddit name is required. Try "programming", "technology", "news", or "AskReddit"');
    }
    
    // Clean up subreddit name (remove r/ prefix if present, trim whitespace)
    subreddit = subreddit.replace(/^r\//, '').trim();
    
    const { limit = 10, time, after } = options;
    
    // Build cache key
    const cacheKey = CacheManager.createKey('subreddit', subreddit, sort, limit, time, after);
    
    // Check cache
    const cached = this.cache.get<RedditListing<RedditPost>>(cacheKey);
    if (cached) {
      return cached;
    }

    // Build URL
    const params = new URLSearchParams({
      limit: String(limit),
      raw_json: '1', // Avoid HTML entities
    });
    
    if (time && (sort === 'top' || sort === 'controversial')) {
      params.append('t', time);
    }
    
    if (after) {
      params.append('after', after);
    }

    // All subreddits use /r/ prefix
    const endpoint = `/r/${subreddit}/${sort}.json`;

    // Make request
    const data = await this.get<RedditListing<RedditPost>>(
      `${endpoint}?${params.toString()}`
    );

    // Cache result
    this.cache.set(cacheKey, data);
    
    return data;
  }

  /**
   * Get post details with comments
   */
  async getPost(
    postId: string,
    options: {
      limit?: number;
      sort?: 'best' | 'top' | 'new' | 'controversial' | 'qa';
      depth?: number;
    } = {}
  ): Promise<[RedditListing<RedditPost>, RedditListing<RedditComment>]> {
    const { limit = 50, sort = 'best', depth = 3 } = options;

    // Extract subreddit and post ID from various formats
    let subreddit: string;
    let id: string;

    if (postId.includes('/comments/')) {
      // Full URL format
      const match = postId.match(/\/r\/(\w+)\/comments\/(\w+)/);
      if (match) {
        subreddit = match[1];
        id = match[2];
      } else {
        throw new Error('Invalid post URL format');
      }
    } else if (postId.includes('_')) {
      // Format: subreddit_postid
      [subreddit, id] = postId.split('_');
    } else {
      // Just the ID, need to fetch subreddit via /api/info
      id = postId;

      // Fetch post info to get subreddit
      const infoData = await this.get<RedditListing<RedditPost>>(
        `/api/info.json?id=t3_${id}`
      );

      if (!infoData.data.children.length) {
        throw new Error(`Post with ID ${id} not found`);
      }

      subreddit = infoData.data.children[0].data.subreddit;
    }

    const cacheKey = CacheManager.createKey('post', subreddit, id, sort, limit, depth);
    
    const cached = this.cache.get<[RedditListing<RedditPost>, RedditListing<RedditComment>]>(cacheKey);
    if (cached) {
      return cached;
    }

    const params = new URLSearchParams({
      limit: String(limit),
      sort,
      depth: String(depth),
      raw_json: '1',
    });

    const data = await this.get<[RedditListing<RedditPost>, RedditListing<RedditComment>]>(
      `/r/${subreddit}/comments/${id}.json?${params.toString()}`
    );

    this.cache.set(cacheKey, data);
    
    return data;
  }

  /**
   * Search Reddit
   */
  async search(
    query: string,
    options: {
      subreddit?: string;
      sort?: 'relevance' | 'hot' | 'top' | 'new' | 'comments';
      time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
      limit?: number;
      after?: string;
      restrictSr?: boolean;
    } = {}
  ): Promise<RedditListing<RedditPost>> {
    const { 
      subreddit, 
      sort = 'relevance', 
      time = 'all', 
      limit = 10,
      after,
      restrictSr = !!subreddit
    } = options;

    const cacheKey = CacheManager.createKey('search', query, subreddit, sort, time, limit, after);
    
    const cached = this.cache.get<RedditListing<RedditPost>>(cacheKey);
    if (cached) {
      return cached;
    }

    const params = new URLSearchParams({
      q: query,
      sort,
      t: time,
      limit: String(limit),
      restrict_sr: String(restrictSr),
      raw_json: '1',
    });

    if (after) {
      params.append('after', after);
    }

    const endpoint = subreddit 
      ? `/r/${subreddit}/search.json`
      : '/search.json';

    const data = await this.get<RedditListing<RedditPost>>(
      `${endpoint}?${params.toString()}`
    );

    this.cache.set(cacheKey, data);
    
    return data;
  }

  /**
   * Get user information
   */
  async getUser(username: string): Promise<RedditUser> {
    const cacheKey = CacheManager.createKey('user', username);
    
    const cached = this.cache.get<RedditUser>(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.get<{ data: RedditUser }>(
      `/user/${username}/about.json`
    );

    const user = data.data;
    this.cache.set(cacheKey, user);
    
    return user;
  }

  /**
   * Get user's recent posts
   */
  async getUserPosts(
    username: string,
    type: 'submitted' | 'comments' = 'submitted',
    options: {
      sort?: 'new' | 'top' | 'hot';
      time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
      limit?: number;
    } = {}
  ): Promise<RedditListing<RedditPost | RedditComment>> {
    const { sort = 'new', time = 'all', limit = 10 } = options;
    
    const cacheKey = CacheManager.createKey('user-posts', username, type, sort, time, limit);
    
    const cached = this.cache.get<RedditListing<RedditPost | RedditComment>>(cacheKey);
    if (cached) {
      return cached;
    }

    const params = new URLSearchParams({
      sort,
      t: time,
      limit: String(limit),
      raw_json: '1',
    });

    const data = await this.get<RedditListing<RedditPost | RedditComment>>(
      `/user/${username}/${type}.json?${params.toString()}`
    );

    this.cache.set(cacheKey, data);
    
    return data;
  }

  /**
   * Get subreddit information
   */
  async getSubreddit(name: string): Promise<RedditSubreddit> {
    const cacheKey = CacheManager.createKey('subreddit-info', name);
    
    const cached = this.cache.get<RedditSubreddit>(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.get<{ data: RedditSubreddit }>(
      `/r/${name}/about.json`
    );

    const subreddit = data.data;
    this.cache.set(cacheKey, subreddit);
    
    return subreddit;
  }

  /**
   * Get trending subreddits
   */
  async getTrending(): Promise<string[]> {
    const cacheKey = CacheManager.createKey('trending');
    
    const cached = this.cache.get<string[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Reddit's trending API has been deprecated, so we'll use popular subreddits
    const popular = await this.browseSubreddit('popular', 'hot', { limit: 25 });
    
    // Extract unique subreddits from popular posts
    const subreddits = new Set<string>();
    popular.data.children.forEach(child => {
      subreddits.add(child.data.subreddit);
    });
    
    const trending = Array.from(subreddits).slice(0, 10);
    this.cache.set(cacheKey, trending);
    
    return trending;
  }

  /**
   * Private: Make GET request to Reddit API with retry logic
   */
  private async get<T>(endpoint: string, retries: number = 2): Promise<T> {
    // Check rate limit
    if (!this.rateLimiter.canMakeRequest()) {
      const isAuth = this.auth.isAuthenticated();
      throw new Error(this.rateLimiter.getErrorMessage(isAuth));
    }

    // Get headers (includes auth if available)
    let headers = await this.auth.getHeaders();
    
    // Determine base URL
    const isAuthenticated = this.auth.isAuthenticated();
    const baseUrl = isAuthenticated ? this.oauthUrl : this.baseUrl;
    
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Record successful request
      this.rateLimiter.recordRequest();

      // Handle auth token expiry
      if (response.status === 401 && isAuthenticated && retries > 0) {
        // Token might be expired, try refreshing
        try {
          await this.auth.refreshAccessToken();
          headers = await this.auth.getHeaders();
          // Retry with new token
          return this.get<T>(endpoint, retries - 1);
        } catch (refreshError) {
          throw new Error('Authentication failed. Please run: reddit-mcp-buddy --auth');
        }
      }

      // Handle errors
      if (!response.ok) {
        // Retry on transient errors (503, 429)
        if ((response.status === 503 || response.status === 429) && retries > 0) {
          // Service unavailable or too many requests - exponential backoff
          const backoffMs = (2 - retries) * 1000; // 1s, then 2s
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          return this.get<T>(endpoint, retries - 1);
        }

        if (response.status === 404) {
          // Extract subreddit name from URL if possible
          const subredditMatch = endpoint.match(/\/r\/([^\/]+)/);
          const subredditName = subredditMatch ? subredditMatch[1] : 'resource';
          throw new Error(`Not found - r/${subredditName} does not exist or is inaccessible`);
        }
        if (response.status === 403) {
          // For 403, try to determine if it's a non-existent subreddit or private
          const subredditMatch = endpoint.match(/\/r\/([^\/]+)/);
          const subredditName = subredditMatch ? subredditMatch[1] : null;
          
          if (subredditName) {
            // Common issue: Reddit returns 403 for both non-existent and private subreddits
            throw new Error(`Cannot access r/${subredditName} - it may be private, quarantined, or doesn't exist. Try a public subreddit like 'programming', 'technology', or 'news'`);
          }
          throw new Error('Access forbidden - the requested content may be private or restricted');
        }
        if (response.status === 429) {
          throw new Error('Rate limited by Reddit - please wait before trying again');
        }
        if (response.status === 503) {
          throw new Error('Reddit is temporarily unavailable - please try again later');
        }
        
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          errorText = 'Unable to read error response';
        }
        
        throw new Error(`Reddit API error (${response.status}): ${errorText}`);
      }

      // Try to parse JSON
      const contentType = response.headers.get('content-type');
      
      if (contentType && contentType.includes('text/html')) {
        throw new Error('Reddit returned HTML instead of JSON - the subreddit may be inaccessible or there may be a Reddit issue');
      }
      
      const data = await response.json();
      return data as T;
      
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Log the actual error for debugging
      console.error('Reddit API Error:', error.message || error);

      if (error.name === 'AbortError') {
        // Retry on timeout if retries available
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return this.get<T>(endpoint, retries - 1);
        }
        throw new Error('Request timeout (10s exceeded) - Reddit may be slow or unreachable. Try again or check if Reddit is blocked on your network.');
      }

      // Common network errors - retry transient ones
      if (error.code === 'ECONNRESET' && retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.get<T>(endpoint, retries - 1);
      }

      if (error.code === 'ENOTFOUND') {
        throw new Error('Cannot resolve Reddit domain - check DNS settings or if Reddit is blocked by your ISP/firewall');
      }

      if (error.code === 'ECONNREFUSED') {
        throw new Error('Connection refused - Reddit may be blocked by firewall or network policy');
      }

      if (error.code === 'ETIMEDOUT') {
        // Retry on connection timeout
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return this.get<T>(endpoint, retries - 1);
        }
        throw new Error('Connection timeout - Reddit may be blocked or network is unstable');
      }

      if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        throw new Error('SSL certificate error - may be caused by proxy or firewall');
      }

      // Fetch-specific errors
      if (error.cause?.code === 'ENOTFOUND') {
        throw new Error(`Cannot reach Reddit servers - ${error.cause.hostname || 'reddit.com'} is not accessible. Check if Reddit is blocked in your region/network.`);
      }

      if (error.message?.includes('fetch failed')) {
        // Extract more details from the fetch error
        const details = error.cause ? ` (${error.cause.code || error.cause.message})` : '';
        throw new Error(`Failed to connect to Reddit${details}. Common causes: firewall blocking, geo-restriction, or ISP blocking Reddit.`);
      }

      if (error.message?.includes('fetch')) {
        throw new Error(`Network error accessing Reddit: ${error.message}. If Reddit works in your browser, try using a VPN.`);
      }

      // Pass through the original error if we don't have a specific handler
      throw error;
    }
  }
}