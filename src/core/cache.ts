/**
 * Smart in-memory cache with LRU eviction and adaptive TTL
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  size: number;
  hits: number;
  expiresAt: number; // When this entry expires (milliseconds since epoch)
}

interface CacheOptions {
  maxSize?: number; // Max size in bytes (default: 50MB)
  defaultTTL?: number; // Default TTL in ms
  cleanupInterval?: number; // Cleanup interval in ms
}

export class CacheManager {
  private cache = new Map<string, CacheEntry<any>>();
  private sizeUsed = 0;
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly ttlByPattern: Map<RegExp, number>;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? 50 * 1024 * 1024; // 50MB default
    this.defaultTTL = options.defaultTTL ?? 5 * 60 * 1000; // 5 minutes default

    // Adaptive TTL based on content type
    this.ttlByPattern = new Map([
      [/^subreddit:.*:hot$/, 5 * 60 * 1000],    // Hot posts: 5 minutes
      [/^subreddit:.*:new$/, 2 * 60 * 1000],    // New posts: 2 minutes
      [/^subreddit:.*:top$/, 30 * 60 * 1000],   // Top posts: 30 minutes
      [/^post:/, 10 * 60 * 1000],               // Individual posts: 10 minutes
      [/^user:/, 15 * 60 * 1000],               // User data: 15 minutes
      [/^search:/, 10 * 60 * 1000],             // Search results: 10 minutes
    ]);

    // Only start cleanup if cache is enabled (maxSize > 0)
    if (this.maxSize > 0 && options.cleanupInterval !== 0) {
      this.startCleanup(options.cleanupInterval ?? 60000); // Every minute
    }
  }

  /**
   * Get item from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired using expiresAt field
    if (Date.now() >= entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // Update hit count for LRU tracking
    entry.hits++;

    return entry.data as T;
  }

  /**
   * Set item in cache with automatic size management
   */
  set<T>(key: string, data: T, customTTL?: number): void {
    const size = this.estimateSize(data);

    // Evict entries if needed to make room
    while (this.sizeUsed + size > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }

    // Remove old entry if exists
    if (this.cache.has(key)) {
      this.delete(key);
    }

    // Determine TTL: custom > pattern-based > default
    let ttl = this.defaultTTL;
    if (customTTL !== undefined && customTTL > 0) {
      ttl = customTTL;
    } else {
      // Check if key matches any pattern
      for (const [pattern, patternTTL] of this.ttlByPattern.entries()) {
        if (pattern.test(key)) {
          ttl = patternTTL;
          break;
        }
      }
    }

    // Add new entry
    const now = Date.now();
    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      expiresAt: now + ttl,
      size,
      hits: 0
    };

    this.cache.set(key, entry);
    this.sizeUsed += size;
  }

  /**
   * Check if key exists in cache and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    // Check if expired
    if (Date.now() >= entry.expiresAt) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.sizeUsed -= entry.size;
    return this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
    this.sizeUsed = 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const totalHits = Array.from(this.cache.values())
      .reduce((sum, entry) => sum + entry.hits, 0);

    return {
      entries: this.cache.size,
      sizeUsed: this.sizeUsed,
      maxSize: this.maxSize,
      sizeUsedMB: (this.sizeUsed / 1024 / 1024).toFixed(2),
      maxSizeMB: (this.maxSize / 1024 / 1024).toFixed(2),
      hitRate: this.cache.size > 0 ? (totalHits / this.cache.size).toFixed(2) : 0,
      oldestEntry: this.getOldestEntry(),
      mostUsed: this.getMostUsedKeys(5)
    };
  }

  /**
   * Generate cache key with validation
   * Ensures cache keys are unique, properly formatted, and don't contain invalid characters
   */
  static createKey(...parts: (string | number | boolean | undefined)[]): string {
    // Filter out undefined/null values
    const validParts = parts.filter(p => p !== undefined && p !== null);

    if (validParts.length === 0) {
      throw new Error('Cache key must have at least one part');
    }

    // Convert all parts to strings and validate
    const stringParts = validParts.map((p) => {
      const str = String(p).toLowerCase().trim();
      if (str.length === 0) {
        throw new Error('Cache key parts cannot be empty strings');
      }
      // Validate characters (alphanumeric, underscore, hyphen only)
      if (!/^[a-z0-9_-]+$/.test(str)) {
        throw new Error(`Invalid cache key part: "${str}" contains invalid characters`);
      }
      return str;
    });

    // Join with colons and validate final key
    const key = stringParts.join(':');

    // Sanity check: key shouldn't be too long (prevents accidental misuse)
    if (key.length > 256) {
      throw new Error(`Cache key too long: ${key.length} > 256 characters`);
    }

    return key;
  }

  /**
   * Private: Estimate size of data in bytes
   */
  private estimateSize(data: any): number {
    try {
      return JSON.stringify(data).length * 2; // Rough estimate (UTF-16)
    } catch {
      return 1024; // Default 1KB for non-serializable
    }
  }

  /**
   * Private: Evict least recently used entry
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let minScore = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // Score based on hits and age
      // Prevent division by zero when age is 0 (newly added entry)
      const age = Math.max(1, Date.now() - entry.timestamp); // At least 1ms
      const score = entry.hits / (age / 1000); // Hits per second

      if (score < minScore) {
        minScore = score;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.delete(lruKey);
    }
  }

  /**
   * Private: Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      // Use expiresAt field for cleanup
      if (now >= entry.expiresAt) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.delete(key));
  }

  /**
   * Private: Start cleanup timer
   * Uses unref() to prevent the timer from keeping the process alive
   */
  private startCleanup(interval: number): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    // Mark timer as non-blocking so it doesn't prevent process exit
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Private: Stop cleanup timer
   */
  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Private: Get oldest cache entry
   */
  private getOldestEntry(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  /**
   * Private: Get most used keys
   */
  private getMostUsedKeys(count: number): string[] {
    return Array.from(this.cache.entries())
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, count)
      .map(([key]) => key);
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    this.stopCleanup();
    this.clear();
  }
}