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
import {
  WriteError,
  WriteErrorTriple,
  mapWriteError,
  mapWriteHttpError,
  redactWriteError,
} from './write-errors.js';

export interface RedditAPIOptions {
  authManager: AuthManager;
  rateLimiter: RateLimiter;
  cacheManager: CacheManager;
  timeout?: number;
}

export interface SubmitPostParams {
  subreddit: string;
  kind: 'self' | 'link';
  title: string;
  text?: string;
  url?: string;
  flair_id?: string;
  flair_text?: string;
  resubmit?: boolean;
  nsfw?: boolean;
  spoiler?: boolean;
  send_replies?: boolean;
}

export interface SubmitPostResult {
  /** Bare base36 post id (t3_ prefix stripped defensively) */
  id: string;
  /** Fullname (t3_<id>) */
  name: string;
  /** Full URL of the created post */
  url: string;
}

export interface SubmitCommentResult {
  /** Bare base36 comment id (t1_ prefix stripped defensively) */
  id: string;
  /** Absolute-path permalink (/r/sub/comments/...) */
  permalink: string;
}

export interface LinkFlair {
  id: string;
  text: string;
  text_editable: boolean;
  mod_only: boolean;
}

/** Shape of Reddit's { json: { errors, data } } write envelope */
interface WriteEnvelope<T> {
  json?: {
    errors?: WriteErrorTriple[];
    data?: T;
  };
}

/**
 * Sentinel for engagement metrics that RSS feeds don't provide.
 * -1 is unambiguous (real Reddit scores can be negative but never below the
 * post's own downvotes; num_comments is never negative), so the tools layer
 * can detect "unknown" and decide how to present it to the LLM.
 */
export const RSS_UNKNOWN_SCORE = -1;

export class RedditAPI {
  private auth: AuthManager;
  private rateLimiter: RateLimiter;
  private cache: CacheManager;
  private timeout: number;
  private baseUrl = 'https://www.reddit.com';
  private oauthUrl = 'https://oauth.reddit.com';
  // Request deduplication: Map of in-flight requests keyed by endpoint
  private inFlightRequests: Map<string, Promise<any>> = new Map();
  // Track request start times for cleanup of stale in-flight requests
  private inFlightRequestTimestamps: Map<string, number> = new Map();
  // Max time to keep in-flight request tracked (5 minutes - longer than any normal request)
  private readonly IN_FLIGHT_REQUEST_TTL_MS = 5 * 60 * 1000;
  // Exponential backoff configuration
  private readonly MAX_BACKOFF_MS = 30000; // 30 second max backoff
  // Surface long upstream waits instead of consuming the client's request timeout.
  private readonly MAX_AUTO_RETRY_WAIT_MS = 5000;
  private readonly INITIAL_BACKOFF_MS = 100;
  private readonly BACKOFF_MULTIPLIER = 2;
  // Set when the anonymous .json API is proven blocked for this IP: it
  // returned 403 while the RSS fallback succeeded, so Reddit itself was
  // reachable and the subreddit is public — the 403 can only be the
  // IP-level policy block. While active, cache-miss browses skip the doomed
  // .json probe (saves a rate-limit slot and ~0.5s per call). Time-limited
  // so a network/IP change heals without a restart.
  private anonJsonBlockedUntil = 0;
  private readonly ANON_JSON_BLOCK_TTL_MS = 15 * 60 * 1000;
  // Shown by the tools that have no credential-free fallback. Saying
  // "private or quarantined" here sends the model off trying other
  // subreddits when the real cause is the logged-out IP block.
  private readonly ANON_BLOCKED_MESSAGE =
    'Reddit rejected anonymous API access. This tool needs approved Reddit API ' +
    'credentials (see README -> Authentication); browse_subreddit may still work ' +
    'via RSS.';
  // Rules-family reads (rules, requirements, about, flairs) share one TTL so
  // invalidation and expiry behave uniformly across the aggregate rules tool.
  private readonly RULES_TTL_MS = 15 * 60 * 1000;

  constructor(options: RedditAPIOptions) {
    this.auth = options.authManager;
    this.rateLimiter = options.rateLimiter;
    this.cache = options.cacheManager;
    this.timeout = options.timeout ?? 10000; // Increased timeout to 10 seconds
  }

  private anonBlockedError(): Error {
    return this.httpError(this.ANON_BLOCKED_MESSAGE, 403);
  }

  /**
   * Fail fast when the anonymous .json API is known to be blocked: these
   * tools have no RSS fallback, so the request can only end in a 403.
   */
  private assertAnonJsonAllowed(): void {
    if (!this.auth.isAuthenticated() && Date.now() < this.anonJsonBlockedUntil) {
      throw this.anonBlockedError();
    }
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
    const endpoint = `/r/${encodeURIComponent(subreddit)}/${sort}.json`;

    // Make request, with a credential-free RSS fallback.
    // Reddit network-blocks the unauthenticated .json API from many IPs
    // (403 "Blocked" from snooserv) regardless of headers. The public Atom
    // feed (.rss) still serves without auth, so fall back to it when we have
    // no token. Authenticated requests go to oauth.reddit.com and don't need this.
    let data: RedditListing<RedditPost>;
    if (!this.auth.isAuthenticated() && Date.now() < this.anonJsonBlockedUntil) {
      // JSON recently proven blocked — go straight to RSS.
      data = await this.browseSubredditViaRSS(subreddit, sort, { limit, time });
    } else {
      try {
        data = await this.get<RedditListing<RedditPost>>(
          `${endpoint}?${params.toString()}`
        );
        data.data._source = 'api';
      } catch (error) {
        if (this.auth.isAuthenticated()) {
          throw error; // OAuth path should work; don't mask real failures
        }
        console.error(`⚠️ Anonymous .json failed (${error instanceof Error ? error.message : error}). Falling back to RSS feed.`);
        try {
          data = await this.browseSubredditViaRSS(subreddit, sort, { limit, time });
          // RSS worked while .json failed. Latch the skip only on the
          // block's signature (403): a transient .json 500/timeout must not
          // degrade the whole session, and a genuinely private/nonexistent
          // subreddit can't reach here because its RSS feed fails too.
          if ((error as { status?: number }).status === 403) {
            this.anonJsonBlockedUntil = Date.now() + this.ANON_JSON_BLOCK_TTL_MS;
          }
        } catch (rssError) {
          // Surface both failures so the cause is clear; the RSS status is the one the caller can act on
          const message =
            `Both the JSON API and the RSS fallback failed for r/${subreddit}. ` +
            `API: ${error instanceof Error ? error.message : error}. ` +
            `RSS: ${rssError instanceof Error ? rssError.message : rssError}`;
          const rssStatus = (rssError as { status?: number }).status;
          throw rssStatus ? this.httpError(message, rssStatus) : new Error(message);
        }
      }
    }

    // Cache result
    this.cache.set(cacheKey, data);

    return data;
  }

  /**
   * Browse a subreddit via Reddit's public Atom (RSS) feed.
   * Credential-free fallback used when the unauthenticated JSON API is blocked.
   * NOTE: RSS lacks engagement metrics (score, num_comments, upvote_ratio).
   */
  private async browseSubredditViaRSS(
    subreddit: string,
    sort: 'hot' | 'new' | 'top' | 'rising' | 'controversial',
    options: { limit?: number; time?: string } = {}
  ): Promise<RedditListing<RedditPost>> {
    const { limit = 25, time } = options;

    const params = new URLSearchParams({ limit: String(limit) });
    if (time && (sort === 'top' || sort === 'controversial')) {
      params.append('t', time);
    }

    let xml: string;
    try {
      xml = await this.getRSS(`/r/${encodeURIComponent(subreddit)}/${sort}/.rss?${params.toString()}`);
    } catch (error) {
      // Once the JSON probe is skipped (anonJsonBlockedUntil), these errors
      // reach the user directly — give them subreddit context instead of a
      // bare "RSS feed request failed (NNN)".
      const status = (error as { status?: number }).status;
      if (status === 404) {
        throw new Error(`Not found - r/${subreddit} does not exist or is inaccessible`);
      }
      if (status === 403 && /^(all|popular)$/i.test(subreddit)) {
        // Aggregates cannot be private or quarantined; Reddit is refusing this logged-out feed.
        throw this.httpError(`Reddit refused the logged-out RSS feed for r/${subreddit}/${sort} (HTTP 403). Try another sort or a specific subreddit, or add approved Reddit API credentials.`, 403);
      }
      if (status === 403) {
        throw new Error(`Cannot access r/${subreddit} - it may be private, quarantined, or NSFW (Reddit's logged-out feed refuses NSFW subreddits)`);
      }
      if (status === 429) {
        throw this.httpError(`Reddit rate-limited the RSS feed for r/${subreddit}. ${error instanceof Error ? error.message : 'Wait before retrying.'}`, 429);
      }
      throw error;
    }
    return this.parseAtomFeed(xml, subreddit);
  }

  /**
   * Private: Decode XML/HTML entities found in Atom feed text.
   */
  private decodeEntities(text: string): string {
    return text
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'); // must run last
  }

  /**
   * Private: Parse a Reddit Atom feed into the same RedditListing<RedditPost>
   * shape the rest of the pipeline expects. Engagement fields are unknown from
   * RSS and are left at sentinel values (see RSS_UNKNOWN_SCORE) for the tools
   * layer to represent to the LLM.
   */
  private parseAtomFeed(xml: string, fallbackSubreddit: string): RedditListing<RedditPost> {
    const children: RedditListing<RedditPost>['data']['children'] = [];

    const entryMatches = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
    for (const entryXml of entryMatches) {
      const pick = (tag: string): string | undefined => {
        const m = entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`));
        return m ? m[1].trim() : undefined;
      };

      const rawId = pick('id') || '';
      const id = rawId.replace(/^t3_/, '');
      if (!id) continue;

      const title = this.decodeEntities(pick('title') || '');

      const authorMatch = entryXml.match(/<name>([\s\S]*?)<\/name>/);
      const author = (authorMatch ? authorMatch[1] : '').replace(/^\/u\//, '').trim() || '[unknown]';

      const linkMatch = entryXml.match(/<link[^>]*href="([^"]+)"/);
      const permalinkFull = linkMatch ? this.decodeEntities(linkMatch[1]) : '';
      const permalink = permalinkFull.replace(/^https?:\/\/[^/]+/, '');

      const subMatch = permalinkFull.match(/\/r\/([^/]+)/);
      const categoryMatch = entryXml.match(/<category[^>]*term="([^"]+)"/);
      const subreddit = (subMatch?.[1] || categoryMatch?.[1] || fallbackSubreddit).trim();

      const published = pick('published') || pick('updated');
      const created_utc = published ? Math.floor(Date.parse(published) / 1000) : 0;

      // The decoded content HTML contains the post body (for self-posts)
      // followed by Reddit's footer with the "[link]" anchor. Take the LAST
      // "[link]" anchor: the footer comes after the body, so an anchor a
      // self-post author crafted inside their own text can't shadow it.
      const contentHtml = this.decodeEntities(pick('content') || '');
      const linkAnchors = [...contentHtml.matchAll(/<a href="([^"]+)">\s*\[link\]/g)];
      const outboundMatch = linkAnchors.length > 0 ? linkAnchors[linkAnchors.length - 1] : null;
      // Reddit double-escapes entities inside <content>, so the extracted href
      // needs a second decode (?a=1&amp;b=2 -> ?a=1&b=2), same as selftext below.
      const outboundUrl = outboundMatch ? this.decodeEntities(outboundMatch[1]) : '';
      // Self-posts' [link] anchor points back at the post's OWN page, so
      // compare paths instead of matching any '/comments/' substring — link
      // posts that target other Reddit threads (r/bestof, crossposts) must
      // keep their real outbound URL.
      const asPath = (u: string): string =>
        u.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
      const is_self =
        !outboundUrl || (permalink !== '' && asPath(outboundUrl) === asPath(permalink));
      const url = is_self ? `https://www.reddit.com${permalink}` : outboundUrl;

      // Self-post body: strip the markdown div, cut at the "submitted by" footer.
      let selftext: string | undefined;
      if (is_self) {
        const bodyMatch = contentHtml.match(/<div class="md">([\s\S]*?)<\/div>/);
        if (bodyMatch) {
          // Reddit double-escapes entities inside <content>, so decode again
          // after stripping the inner HTML tags.
          selftext = this.decodeEntities(
            bodyMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          );
        }
      }

      const post: RedditPost = {
        id,
        title,
        author,
        subreddit,
        subreddit_name_prefixed: `r/${subreddit}`,
        score: RSS_UNKNOWN_SCORE,
        num_comments: RSS_UNKNOWN_SCORE,
        ups: RSS_UNKNOWN_SCORE,
        downs: 0,
        created_utc,
        url,
        permalink,
        is_self,
        selftext,
      };

      children.push({ kind: 't3', data: post });
    }

    return {
      kind: 'Listing',
      data: {
        children,
        after: null,
        before: null,
        _source: 'rss',
      },
    };
  }

  /**
   * Private: Fetch a Reddit RSS/Atom endpoint and return the raw XML text.
   * Uses the same rate limiter and timeout as the JSON path.
   */
  private async getRSS(endpoint: string, retries: number = 2): Promise<string> {
    if (!this.rateLimiter.canMakeRequest()) {
      throw new Error(this.rateLimiter.getErrorMessage(this.auth.isAuthenticated()));
    }

    const headers = await this.auth.getHeaders();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      this.rateLimiter.recordRequest();

      if (response.status === 429 || response.status === 503) {
        const waitMs =
          this.getRetryAfterDelay(response) ??
          (response.status === 429 ? this.getRateLimitResetDelay(response) : null) ??
          this.calculateBackoff(retries);
        if (retries > 0 && waitMs <= this.MAX_AUTO_RETRY_WAIT_MS) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
          return this.getRSS(endpoint, retries - 1);
        }
        throw this.retryWaitError(response.status, waitMs);
      }

      if (!response.ok) {
        throw this.httpError(`RSS feed request failed (${response.status})`, response.status);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error('RSS endpoint returned HTML (likely blocked)');
      }

      return await response.text();
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('RSS feed request timed out');
      }
      throw error;
    }
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
      // Format: subreddit_postid (or _postid for short URLs like redd.it)
      // Use lastIndexOf to handle subreddits with underscores (e.g. world_news_1abc2d3)
      const lastUnderscore = postId.lastIndexOf('_');
      subreddit = postId.substring(0, lastUnderscore);
      id = postId.substring(lastUnderscore + 1);

      // Handle short URLs (redd.it) where subreddit is empty - fall through to lookup
      if (!subreddit) {
        this.assertAnonJsonAllowed();
        const infoData = await this.get<RedditListing<RedditPost>>(
          `/api/info.json?id=t3_${encodeURIComponent(id)}`
        );
        if (!infoData.data.children.length) {
          throw new Error(`Post with ID ${id} not found`);
        }
        subreddit = infoData.data.children[0].data.subreddit;
      }
    } else {
      // Just the ID, need to fetch subreddit via /api/info
      id = postId;

      // Fetch post info to get subreddit
      this.assertAnonJsonAllowed();
      const infoData = await this.get<RedditListing<RedditPost>>(
        `/api/info.json?id=t3_${encodeURIComponent(id)}`
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
    this.assertAnonJsonAllowed();

    const params = new URLSearchParams({
      limit: String(limit),
      sort,
      depth: String(depth),
      raw_json: '1',
    });

    const data = await this.get<[RedditListing<RedditPost>, RedditListing<RedditComment>]>(
      `/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(id)}.json?${params.toString()}`
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
    this.assertAnonJsonAllowed();

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
      ? `/r/${encodeURIComponent(subreddit)}/search.json`
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
    this.assertAnonJsonAllowed();

    const data = await this.get<{ data: RedditUser }>(
      `/user/${encodeURIComponent(username)}/about.json`
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
      `/user/${encodeURIComponent(username)}/${type}.json?${params.toString()}`
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
      `/r/${encodeURIComponent(name)}/about.json`
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

  // ── Write support (v1.2.0) ─────────────────────────────────────────────────
  // Writes require OAuth user context and share the read RateLimiter: every
  // POST consumes a Reddit quota slot exactly like a read does.

  /**
   * Private: POST transport for Reddit write endpoints.
   *
   * CRITICAL: this transport NEVER auto-retries after the request body has
   * been sent. Reddit offers no idempotency key, so a retry on timeout,
   * ECONNRESET, 5xx, or anything else post-send risks a duplicate post; the
   * read path's retry logic (getImpl) is deliberately not reused here. The
   * only safe rejection is the pre-send rate-limit check. Error text leaving
   * this transport is redacted (redactWriteError) and HTTP failures map via
   * mapWriteHttpError; raw response bodies are never echoed.
   */
  private async postForm<T>(
    endpoint: string,
    form: URLSearchParams,
    context: { subreddit?: string } = {}
  ): Promise<T> {
    // Pre-send rejection is safe: nothing has been transmitted yet.
    if (!this.rateLimiter.canMakeRequest()) {
      throw new Error(this.rateLimiter.getErrorMessage(this.auth.isAuthenticated()));
    }

    // getHeaders() may refresh the OAuth token; still pre-send.
    const headers = await this.auth.getHeaders();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Record before fetch: the quota slot is spent the moment the request is
    // transmitted, and a timeout after send still consumed it.
    this.rateLimiter.recordRequest();

    let response: Response;
    try {
      response = await fetch(`${this.oauthUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      // Post-send failure: whether Reddit accepted the write is unknowable
      // here. Surface that honestly instead of retrying. The WriteGate only
      // records SUCCESSFUL submits for idempotent replay, so nothing exists
      // to replay on this path and a blind re-issue can double-post; the
      // message tells the caller to check for the write first.
      if (error.name === 'AbortError') {
        throw new Error(
          `Write request timed out after ${this.timeout}ms. The submit may or may not have reached Reddit and was NOT retried automatically. A retry is not guaranteed to be a no-op (nothing was recorded for replay because the outcome is unknown): check the acting user's newest submissions for the write, and re-issue only if it is missing.`
        );
      }
      throw new Error(redactWriteError(
        `Write request failed before a response arrived: ${error?.message || String(error)}. It was NOT retried automatically, and a retry is not guaranteed to be a no-op: check the acting user's newest submissions for the write before re-issuing.`
      ));
    }
    clearTimeout(timeoutId);

    if (response.status === 401) {
      this.auth.invalidateAccessToken();
      // Do NOT refresh-and-resubmit: the body was already sent once and a
      // resubmit could double-post. The next call re-mints the token.
      throw new Error(
        'Reddit rejected the write with 401 (expired or invalid token). Not resubmitting automatically; the token refreshes on the next call, so try once more.'
      );
    }

    if (!response.ok) {
      throw mapWriteHttpError(response.status, context.subreddit);
    }

    try {
      return await response.json() as T;
    } catch {
      throw new Error('Reddit returned a non-JSON response to a write request.');
    }
  }

  /**
   * Submit a self or link post via POST /api/submit.
   * api_type=json is mandatory: without it Reddit answers with the legacy
   * jquery response instead of { json: { errors, data } }.
   */
  async submitPost(params: SubmitPostParams): Promise<SubmitPostResult> {
    // Pre-send guard: a link submit without a URL would reach Reddit and
    // burn a quota slot only to fail with NO_URL.
    if (params.kind === 'link' && !params.url) {
      throw new WriteError(mapWriteError([['NO_URL', 'a link post needs a url', 'url']]));
    }

    const form = new URLSearchParams({
      api_type: 'json',
      sr: params.subreddit,
      kind: params.kind,
      title: params.title,
    });
    // Only include params that are set: Reddit treats an absent field and an
    // explicit default differently for some settings (e.g. flair).
    if (params.kind === 'self') {
      if (params.text !== undefined) form.set('text', params.text);
    } else {
      form.set('url', params.url as string);
    }
    if (params.send_replies !== undefined) form.set('sendreplies', String(params.send_replies));
    if (params.resubmit !== undefined) form.set('resubmit', String(params.resubmit));
    if (params.nsfw !== undefined) form.set('nsfw', String(params.nsfw));
    if (params.spoiler !== undefined) form.set('spoiler', String(params.spoiler));
    if (params.flair_id !== undefined) form.set('flair_id', params.flair_id);
    if (params.flair_text !== undefined) form.set('flair_text', params.flair_text);

    const body = await this.postForm<WriteEnvelope<{ id?: string; name?: string; url?: string }>>(
      '/api/submit',
      form,
      { subreddit: params.subreddit }
    );

    const errors = body?.json?.errors ?? [];
    if (errors.length > 0) {
      throw new WriteError(mapWriteError(errors));
    }

    const data = body?.json?.data;
    if (!data?.url) {
      throw new Error('Reddit accepted the submit but returned no post data (unexpected response shape).');
    }
    // id is ALWAYS the bare base36 id: strip a t3_ prefix defensively in case
    // only the fullname is present (the gallery endpoint returns fullnames).
    const id = String(data.id ?? data.name ?? '').replace(/^t3_/, '');
    return { id, name: data.name ?? `t3_${id}`, url: data.url };
  }

  /**
   * Submit a comment or reply via POST /api/comment.
   * thingId is a fullname: t3_<post> for a top-level comment, t1_<comment>
   * for a reply. The success payload lives at json.data.things[0].data.
   */
  async submitComment(thingId: string, text: string): Promise<SubmitCommentResult> {
    const form = new URLSearchParams({
      api_type: 'json',
      thing_id: thingId,
      text,
    });

    const body = await this.postForm<WriteEnvelope<{ things?: Array<{ data?: { id?: string; permalink?: string } }> }>>(
      '/api/comment',
      form
    );

    const errors = body?.json?.errors ?? [];
    if (errors.length > 0) {
      throw new WriteError(mapWriteError(errors));
    }

    const thing = body?.json?.data?.things?.[0]?.data;
    if (!thing?.id) {
      throw new Error('Reddit accepted the comment but returned no comment data (unexpected response shape).');
    }
    const id = String(thing.id).replace(/^t1_/, '');
    // Absolute-path permalink: strip any scheme+host Reddit may prepend
    const permalink = String(thing.permalink ?? '').replace(/^https?:\/\/[^/]+/, '');
    return { id, permalink };
  }

  /**
   * Raw subreddit rules via GET /r/{sub}/about/rules.json. Read traffic:
   * normal retry behavior applies (only the POST transport forbids retry).
   */
  async getSubredditRulesRaw(subreddit: string): Promise<any> {
    const cacheKey = CacheManager.createKey('rules', subreddit, 'rules');
    const cached = this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.get<any>(`/r/${encodeURIComponent(subreddit)}/about/rules.json`);
    this.cache.set(cacheKey, data, this.RULES_TTL_MS);
    return data;
  }

  /**
   * Posting requirements via GET /api/v1/{sub}/post_requirements (needs
   * OAuth with the submit scope). Returns null instead of throwing on
   * 403/404: profile (u_) subreddits have no requirements endpoint, and the
   * tool layer reports "unavailable for profile subreddits". The null is
   * cached too, so repeat rules calls for a profile sub cost zero requests.
   */
  async getPostRequirements(subreddit: string): Promise<Record<string, unknown> | null> {
    const cacheKey = CacheManager.createKey('rules', subreddit, 'requirements');
    // Wrapper object so a cached "unavailable" (null) is distinguishable
    // from a cache miss (cache.get returns null for both otherwise).
    const cached = this.cache.get<{ requirements: Record<string, unknown> | null }>(cacheKey);
    if (cached) {
      return cached.requirements;
    }

    let requirements: Record<string, unknown> | null = null;
    try {
      requirements = await this.get<Record<string, unknown>>(
        `/api/v1/${encodeURIComponent(subreddit)}/post_requirements`
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 403 && status !== 404) {
        throw error;
      }
    }
    this.cache.set(cacheKey, { requirements }, this.RULES_TTL_MS);
    return requirements;
  }

  /**
   * Full about.json data for a subreddit, cached under the rules family so
   * the aggregate rules tool's reads expire and invalidate uniformly.
   * (getSubreddit() exists but caches under its own key/TTL; the rules tool
   * needs capability flags like submission_type on the rules TTL.)
   */
  async getSubredditAboutFull(subreddit: string): Promise<any> {
    const cacheKey = CacheManager.createKey('rules', subreddit, 'about');
    const cached = this.cache.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const resp = await this.get<{ data: any }>(`/r/${encodeURIComponent(subreddit)}/about.json`);
    const about = resp.data;
    this.cache.set(cacheKey, about, this.RULES_TTL_MS);
    return about;
  }

  /**
   * Link flair choices via GET /r/{sub}/api/link_flair_v2.json. That endpoint
   * 403s for non-privileged users in some subreddits, so fall back to the
   * flairselector POST (which serves the selectable choices to anyone who can
   * post) and adapt to the same shape. Returns [] when flairs are disabled.
   */
  async getLinkFlairs(subreddit: string): Promise<LinkFlair[]> {
    const cacheKey = CacheManager.createKey('rules', subreddit, 'flairs');
    const cached = this.cache.get<LinkFlair[]>(cacheKey);
    if (cached) {
      return cached;
    }

    let flairs: LinkFlair[] = [];
    try {
      const raw = await this.get<any[]>(`/r/${encodeURIComponent(subreddit)}/api/link_flair_v2.json`);
      flairs = Array.isArray(raw)
        ? raw.map(f => ({
            id: String(f.id ?? ''),
            text: String(f.text ?? ''),
            text_editable: !!f.text_editable,
            mod_only: !!f.mod_only,
          }))
        : [];
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        flairs = await this.getFlairsViaSelector(subreddit);
      } else if (status === 404) {
        flairs = []; // flairs disabled for this subreddit
      } else {
        throw error;
      }
    }

    this.cache.set(cacheKey, flairs, this.RULES_TTL_MS);
    return flairs;
  }

  /**
   * Private: flairselector fallback. A POST, but read-shaped (it creates
   * nothing), so routing it through the no-retry transport is safe. Any
   * failure means "no flair choices available", never a fatal error: the
   * rules tool degrades to an availability note instead.
   */
  private async getFlairsViaSelector(subreddit: string): Promise<LinkFlair[]> {
    try {
      // name omitted from the form: that selects flair choices for a new link
      const data = await this.postForm<{ choices?: any[] }>(
        `/r/${encodeURIComponent(subreddit)}/api/flairselector`,
        new URLSearchParams(),
        { subreddit }
      );
      const choices = data?.choices;
      if (!Array.isArray(choices)) {
        return [];
      }
      return choices.map(c => ({
        id: String(c.flair_template_id ?? ''),
        text: String(c.flair_text ?? ''),
        text_editable: !!c.flair_text_editable,
        // flairselector only serves choices the user may apply
        mod_only: false,
      }));
    } catch {
      return []; // flairs disabled (empty/non-JSON body) or inaccessible
    }
  }

  /**
   * Identity via GET /api/v1/me, deliberately uncached: this is the startup
   * probe proving the token carries real user context. App-only
   * (client_credentials) tokens have no user identity and cannot post.
   */
  async getMe(): Promise<any> {
    return this.get<any>('/api/v1/me');
  }

  /**
   * Fresh post lookup via GET /api/info.json, BYPASSING the cache entirely:
   * verify-after-submit must see Reddit's current state (removed_by_category
   * lands seconds after submit), never a pre-write cached listing.
   * Returns the first child's data, or null when the post is not found.
   */
  async getPostInfoFresh(fullnameOrId: string): Promise<RedditPost | null> {
    const id = fullnameOrId.replace(/^t3_/, '');
    const data = await this.get<RedditListing<RedditPost>>(
      `/api/info.json?id=t3_${encodeURIComponent(id)}`
    );
    return data?.data?.children?.[0]?.data ?? null;
  }

  /**
   * Private: Error carrying the HTTP status that caused it, so callers can
   * distinguish failure classes (e.g. the anonymous 403 IP-block) without
   * parsing message text.
   */
  private retryWaitError(status: number, waitMs: number): Error {
    const reason = status === 429 ? 'Reddit rate limit' : 'Reddit is temporarily unavailable';
    return this.httpError(`${reason} (HTTP ${status}). Retry in ${Math.ceil(waitMs / 1000)}s.`, status);
  }

  private httpError(message: string, status: number): Error {
    const err: Error & { status?: number } = new Error(message);
    err.status = status;
    return err;
  }

  /**
   * Private: Calculate exponential backoff with jitter
   */
  private calculateBackoff(retriesLeft: number): number {
    const maxRetries = 2;
    const retriesUsed = maxRetries - retriesLeft;

    // Exponential backoff: INITIAL * MULTIPLIER^retriesUsed
    const baseBackoff = this.INITIAL_BACKOFF_MS * Math.pow(this.BACKOFF_MULTIPLIER, retriesUsed);

    // Cap at max backoff
    const cappedBackoff = Math.min(baseBackoff, this.MAX_BACKOFF_MS);

    // Add jitter (±20% of backoff) to prevent thundering herd
    const jitter = cappedBackoff * 0.2 * (Math.random() * 2 - 1);
    const backoff = Math.max(0, cappedBackoff + jitter);

    return Math.round(backoff);
  }

  /**
   * Private: Extract retry-after delay from response headers
   */
  private getRetryAfterDelay(response: Response): number | null {
    const retryAfter = response.headers.get('retry-after');
    if (!retryAfter) return null;

    // Retry-After can be seconds or HTTP date
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds >= 0 ? seconds * 1000 : null;
    }

    // Try parsing as HTTP date
    try {
      const retryDate = new Date(retryAfter);
      const delay = retryDate.getTime() - Date.now();
      return Number.isFinite(delay) ? Math.max(0, delay) : null;
    } catch {
      return null;
    }
  }

  /**
   * Private: Delay until the rate-limit window resets, from Reddit's
   * x-ratelimit-reset header (seconds until reset). The logged-out .rss
   * endpoint sends this on 429s where Retry-After may be absent.
   */
  private getRateLimitResetDelay(response: Response): number | null {
    const reset = response.headers.get('x-ratelimit-reset');
    if (!reset) return null;
    const seconds = parseFloat(reset);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    // +1s cushion so the retry lands inside the next window
    return (seconds + 1) * 1000;
  }

  /**
   * Private: Clean up stale in-flight requests to prevent memory leaks
   */
  private cleanupStaleInFlightRequests(): void {
    const now = Date.now();
    for (const [endpoint, timestamp] of this.inFlightRequestTimestamps.entries()) {
      if (now - timestamp > this.IN_FLIGHT_REQUEST_TTL_MS) {
        this.inFlightRequests.delete(endpoint);
        this.inFlightRequestTimestamps.delete(endpoint);
      }
    }
  }

  /**
   * Private: Make GET request to Reddit API with retry logic and deduplication
   */
  private async get<T>(endpoint: string, retries: number = 2): Promise<T> {
    // Clean up stale requests periodically to prevent memory leaks
    this.cleanupStaleInFlightRequests();

    // Check for in-flight request (deduplication)
    const inFlightRequest = this.inFlightRequests.get(endpoint);
    if (inFlightRequest) {
      return inFlightRequest as Promise<T>;
    }

    // Create promise for this request
    const requestPromise = this.getImpl<T>(endpoint, retries);

    // Track the in-flight request with timestamp
    this.inFlightRequests.set(endpoint, requestPromise);
    this.inFlightRequestTimestamps.set(endpoint, Date.now());

    // Clean up when done (success or error)
    // The .catch(() => {}) prevents unhandled rejection warnings on the floating
    // .finally() chain — the caller handles the actual rejection via the returned promise.
    requestPromise.finally(() => {
      this.inFlightRequests.delete(endpoint);
      this.inFlightRequestTimestamps.delete(endpoint);
    }).catch(() => {});

    return requestPromise;
  }

  /**
   * Private: Implementation of GET request with retry logic
   */
  private async getImpl<T>(endpoint: string, retries: number = 2): Promise<T> {
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
          return this.getImpl<T>(endpoint, retries - 1);
        } catch (refreshError) {
          throw new Error(this.auth.usesRefreshToken()
            ? 'Authentication failed. Reauthorize your Reddit app and update REDDIT_REFRESH_TOKEN, or check the app credentials.'
            : 'Authentication failed. Please run: reddit-mcp-buddy --auth');
        }
      }

      // Handle errors
      if (!response.ok) {
        if (response.status === 503 || response.status === 429) {
          const waitMs = this.getRetryAfterDelay(response)
            ?? (response.status === 429 ? this.getRateLimitResetDelay(response) : null)
            ?? this.calculateBackoff(retries);
          if (retries > 0 && waitMs <= this.MAX_AUTO_RETRY_WAIT_MS) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
            return this.getImpl<T>(endpoint, retries - 1);
          }
          throw this.retryWaitError(response.status, waitMs);
        }

        if (response.status === 404) {
          // Extract subreddit name from URL if possible
          const subredditMatch = endpoint.match(/\/r\/([^\/]+)/);
          const subredditName = subredditMatch ? subredditMatch[1] : 'resource';
          throw this.httpError(`Not found - r/${subredditName} does not exist or is inaccessible`, 404);
        }
        if (response.status === 403) {
          if (!isAuthenticated) {
            // The IP-level block browse_subreddit detects for its own path.
            // This tool has no RSS fallback, so the message asks for
            // credentials; the caller cannot retry its way out.
            throw this.anonBlockedError();
          }
          // For 403, try to determine if it's a non-existent subreddit or private
          const subredditMatch = endpoint.match(/\/r\/([^\/]+)/);
          const subredditName = subredditMatch ? subredditMatch[1] : null;

          if (subredditName) {
            // Common issue: Reddit returns 403 for both non-existent and private subreddits
            throw this.httpError(`Cannot access r/${subredditName} - it may be private, quarantined, or doesn't exist. Try a public subreddit like 'programming', 'technology', or 'news'`, 403);
          }
          throw this.httpError('Access forbidden - the requested content may be private or restricted', 403);
        }

        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          errorText = 'Unable to read error response';
        }

        throw this.httpError(`Reddit API error (${response.status}): ${errorText}`, response.status);
      }

      // Try to parse JSON
      const contentType = response.headers.get('content-type');

      // Check for HTML responses (handles case variations and charset parameters)
      // Examples: "text/html", "TEXT/HTML", "text/html; charset=utf-8", "application/xhtml+xml"
      if (contentType) {
        const normalizedType = contentType.toLowerCase().split(';')[0].trim();
        if (normalizedType === 'text/html' || normalizedType === 'application/xhtml+xml') {
          throw new Error('Reddit returned HTML instead of JSON - the subreddit may be inaccessible or there may be a Reddit issue');
        }
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
          const backoffMs = this.calculateBackoff(retries);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          return this.getImpl<T>(endpoint, retries - 1);
        }
        throw new Error('Request timeout (10s exceeded) - Reddit may be slow or unreachable. Try again or check if Reddit is blocked on your network.');
      }

      // Common network errors - retry transient ones
      if (error.code === 'ECONNRESET' && retries > 0) {
        const backoffMs = this.calculateBackoff(retries);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.getImpl<T>(endpoint, retries - 1);
      }

      if (error.code === 'ENOTFOUND') {
        throw new Error('Cannot resolve Reddit domain - check DNS settings or if Reddit is blocked by your ISP/firewall');
      }

      if (error.code === 'ECONNREFUSED') {
        throw new Error('Connection refused - Reddit may be blocked by firewall or network policy');
      }

      if (error.code === 'ETIMEDOUT') {
        // Retry on connection timeout with exponential backoff
        if (retries > 0) {
          const backoffMs = this.calculateBackoff(retries);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          return this.getImpl<T>(endpoint, retries - 1);
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
