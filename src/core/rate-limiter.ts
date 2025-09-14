/**
 * Rate limiter with sliding window algorithm
 */

export interface RateLimiterOptions {
  limit: number;
  window: number; // in milliseconds
  name?: string; // for logging
}

export class RateLimiter {
  private requests: number[] = [];
  private readonly limit: number;
  private readonly window: number;
  private readonly name: string;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.window = options.window;
    this.name = options.name ?? 'RateLimiter';
  }

  /**
   * Check if a request can be made
   */
  canMakeRequest(): boolean {
    this.cleanup();
    return this.requests.length < this.limit;
  }

  /**
   * Record a request
   */
  recordRequest(): void {
    this.cleanup();
    if (this.requests.length >= this.limit) {
      throw new Error(`Rate limit exceeded for ${this.name}: ${this.limit} requests per ${this.window}ms`);
    }
    this.requests.push(Date.now());
  }

  /**
   * Try to make a request (combines check and record)
   */
  tryRequest(): boolean {
    if (this.canMakeRequest()) {
      this.recordRequest();
      return true;
    }
    return false;
  }

  /**
   * Get time until next available request in seconds
   */
  timeUntilNextRequest(): number {
    this.cleanup();
    
    if (this.requests.length < this.limit) {
      return 0;
    }

    // Find the oldest request that's still in the window
    const oldestRequest = this.requests[0];
    const timeUntilExpiry = (oldestRequest + this.window) - Date.now();
    
    return Math.max(0, Math.ceil(timeUntilExpiry / 1000));
  }

  /**
   * Get current usage stats
   */
  getStats() {
    this.cleanup();
    
    return {
      used: this.requests.length,
      limit: this.limit,
      available: Math.max(0, this.limit - this.requests.length),
      percentUsed: ((this.requests.length / this.limit) * 100).toFixed(1),
      timeUntilReset: this.timeUntilNextRequest(),
      window: this.window / 1000, // in seconds
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.requests = [];
  }

  /**
   * Get a formatted error message for rate limit exceeded
   */
  getErrorMessage(authenticated: boolean = false): string {
    const stats = this.getStats();
    
    if (!authenticated) {
      return `⚠️ Rate limit reached! You get ${this.limit} requests/min without auth.

Want 10x more requests? Run: reddit-buddy --auth (2-min setup)
Or wait ${stats.timeUntilReset} seconds...

Cached data may still be available.`;
    }
    
    return `Rate limit reached (${stats.used}/${stats.limit}). Wait ${stats.timeUntilReset} seconds.`;
  }

  /**
   * Private: Remove expired requests from tracking
   */
  private cleanup(): void {
    const now = Date.now();
    this.requests = this.requests.filter(timestamp => now - timestamp < this.window);
  }
}

/**
 * Compound rate limiter that checks multiple limits
 */
export class CompoundRateLimiter {
  private limiters: Map<string, RateLimiter> = new Map();

  /**
   * Add a rate limiter
   */
  addLimiter(name: string, options: RateLimiterOptions): void {
    this.limiters.set(name, new RateLimiter({ ...options, name }));
  }

  /**
   * Check if request can be made across all limiters
   */
  canMakeRequest(): boolean {
    for (const limiter of this.limiters.values()) {
      if (!limiter.canMakeRequest()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Record request across all limiters
   */
  recordRequest(): void {
    for (const limiter of this.limiters.values()) {
      limiter.recordRequest();
    }
  }

  /**
   * Get the most restrictive time until next request
   */
  timeUntilNextRequest(): number {
    let maxTime = 0;
    
    for (const limiter of this.limiters.values()) {
      maxTime = Math.max(maxTime, limiter.timeUntilNextRequest());
    }
    
    return maxTime;
  }

  /**
   * Get stats for all limiters
   */
  getAllStats() {
    const stats: Record<string, any> = {};
    
    for (const [name, limiter] of this.limiters.entries()) {
      stats[name] = limiter.getStats();
    }
    
    return stats;
  }

  /**
   * Get the most restrictive limiter that's blocking
   */
  getBlockingLimiter(): { name: string; stats: any } | null {
    for (const [name, limiter] of this.limiters.entries()) {
      if (!limiter.canMakeRequest()) {
        return { name, stats: limiter.getStats() };
      }
    }
    return null;
  }

  /**
   * Reset all limiters
   */
  resetAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.reset();
    }
  }
}