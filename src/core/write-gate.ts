/**
 * Server-owned write bookkeeping: rate floor, idempotency, duplicate-content
 * guard, and enforced dry-run tracking.
 *
 * One WriteGate is created in createSharedServices() and shared by every MCP
 * server instance. It must NEVER live on a per-request object: the HTTP path
 * mints a fresh Server per request, and per-request state would reset the
 * caps and idempotency records to zero on every call.
 *
 * The rate floor is deliberately non-bypassable. This is a public package;
 * without a floor, create_post plus add_comment over an arbitrary subreddit
 * is a spam surface for any operator (Reddit's Responsible Builder Policy
 * names exactly this). Environment variables can only TIGHTEN the limits,
 * never loosen them; a human-in-the-loop workflow never notices the floor.
 */

import { createHash } from 'crypto';

export type WriteKind = 'post' | 'comment';

export interface WriteCheckResult {
  allowed: boolean;
  reason?: string;
  waitSeconds?: number;
}

/** What a completed write stored for idempotent replay. */
export interface StoredWriteResult {
  post_id?: string;
  comment_id?: string;
  url?: string;
  permalink?: string;
}

export interface WriteGateOptions {
  /** Injectable clock so tests can advance time without waiting. */
  now?: () => number;
}

// Non-bypassable defaults. Env vars are honored only when STRICTER.
const MAX_POSTS_PER_HOUR = 5;
const MAX_COMMENTS_PER_HOUR = 30;
const MIN_WRITE_INTERVAL_MS = 15000;
const HOUR_MS = 60 * 60 * 1000;
// Idempotency, duplicate-content, and validate-pass records all share this
// window: long enough to cover any realistic retry loop, short enough that a
// deliberate identical repost the next day still works.
const IDEMPOTENCY_WINDOW_MS = 15 * 60 * 1000;

/** Parse a positive integer env var; anything else means "not set". */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class WriteGate {
  private readonly now: () => number;
  private readonly maxPostsPerHour: number;
  private readonly maxCommentsPerHour: number;
  private readonly minWriteIntervalMs: number;

  // Sliding-window timestamps of recorded writes, pruned on every check
  private postTimes: number[] = [];
  private commentTimes: number[] = [];
  private lastWriteAt = 0; // 0 = no write yet this process

  // key -> completed write, for idempotent replay of retried submits
  private submits = new Map<string, { at: number; result: StoredWriteResult }>();
  // key -> timestamp of a passed validate_only run (no-elicitation fallback)
  private validatePasses = new Map<string, number>();

  constructor(options: WriteGateOptions = {}) {
    this.now = options.now ?? Date.now;

    // Env can only tighten: min() for caps, max() for the interval. A value
    // looser than the default is silently ignored rather than errored, so a
    // fork of someone's config cannot accidentally weaken the floor.
    const envPosts = envPositiveInt('REDDIT_BUDDY_MAX_POSTS_PER_HOUR');
    const envComments = envPositiveInt('REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR');
    const envIntervalS = envPositiveInt('REDDIT_BUDDY_MIN_WRITE_INTERVAL_S');

    this.maxPostsPerHour = envPosts !== undefined
      ? Math.min(MAX_POSTS_PER_HOUR, envPosts)
      : MAX_POSTS_PER_HOUR;
    this.maxCommentsPerHour = envComments !== undefined
      ? Math.min(MAX_COMMENTS_PER_HOUR, envComments)
      : MAX_COMMENTS_PER_HOUR;
    this.minWriteIntervalMs = envIntervalS !== undefined
      ? Math.max(MIN_WRITE_INTERVAL_MS, envIntervalS * 1000)
      : MIN_WRITE_INTERVAL_MS;
  }

  /**
   * Check whether a write of the given kind may proceed right now.
   * Does not consume a slot; call recordWrite() after the write succeeds.
   */
  checkWrite(kind: WriteKind): WriteCheckResult {
    const now = this.now();
    this.pruneWriteTimes(now);

    // Minimum spacing between ANY two writes, regardless of kind
    if (this.lastWriteAt > 0) {
      const sinceLast = now - this.lastWriteAt;
      if (sinceLast < this.minWriteIntervalMs) {
        const waitSeconds = Math.ceil((this.minWriteIntervalMs - sinceLast) / 1000);
        return {
          allowed: false,
          reason: `Minimum interval between writes is ${Math.ceil(this.minWriteIntervalMs / 1000)}s; last write was ${Math.floor(sinceLast / 1000)}s ago.`,
          waitSeconds,
        };
      }
    }

    const times = kind === 'post' ? this.postTimes : this.commentTimes;
    const cap = kind === 'post' ? this.maxPostsPerHour : this.maxCommentsPerHour;
    if (times.length >= cap) {
      // Oldest slot in the window frees up first
      const waitSeconds = Math.max(1, Math.ceil((times[0] + HOUR_MS - now) / 1000));
      return {
        allowed: false,
        reason: `Write cap reached: ${cap} ${kind}s per hour. This floor is not configurable upward.`,
        waitSeconds,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a completed write. Logs conspicuously to stderr: every write this
   * server performs must be visible in the server logs, not just in the tool
   * result the model consumed.
   */
  recordWrite(kind: WriteKind, context: { subreddit?: string; actingUser?: string } = {}): void {
    const now = this.now();
    this.pruneWriteTimes(now);
    const times = kind === 'post' ? this.postTimes : this.commentTimes;
    times.push(now);
    this.lastWriteAt = now;

    const cap = kind === 'post' ? this.maxPostsPerHour : this.maxCommentsPerHour;
    const where = context.subreddit ? ` to r/${context.subreddit}` : '';
    const who = context.actingUser ? ` as u/${context.actingUser}` : '';
    console.error(`✍️  WRITE: ${kind}${where}${who} (${times.length}/${cap} ${kind}s this hour)`);
  }

  /**
   * Idempotency key for a post submit. A transport-level failure after send
   * (timeout, 5xx) leaves "did Reddit accept it?" unknowable; retrying the
   * identical submit must replay the stored result instead of double-posting.
   */
  makePostKey(subreddit: string, kind: string, title: string, bodyOrUrl: string): string {
    return this.hashKey('post', this.normSubreddit(subreddit), kind.trim().toLowerCase(),
      this.normText(title), this.normText(bodyOrUrl));
  }

  /** Idempotency key for a comment submit. */
  makeCommentKey(thingId: string, text: string): string {
    return this.hashKey('comment', thingId.trim().toLowerCase(), this.normText(text));
  }

  /** Stored result for a recent identical submit, or null. */
  findRecentSubmit(key: string): StoredWriteResult | null {
    this.pruneSubmits();
    return this.submits.get(key)?.result ?? null;
  }

  /** Record a completed submit under its idempotency key. */
  recordSubmit(key: string, result: StoredWriteResult): void {
    this.pruneSubmits();
    this.submits.set(key, { at: this.now(), result });
  }

  /**
   * Same-sub duplicate content guard: the idempotency key covers exact retry
   * replays, but a re-drafted call with the same (subreddit, title, body) is
   * still the same content. Within the window it returns the stored result
   * instead of re-posting (Responsible Builder Policy anti-spam mitigation).
   */
  findDuplicateContent(subreddit: string, title: string, body: string): StoredWriteResult | null {
    this.pruneSubmits();
    return this.submits.get(this.makeContentKey(subreddit, title, body))?.result ?? null;
  }

  /** Record a successful post under its content hash for the duplicate guard. */
  recordContent(subreddit: string, title: string, body: string, result: StoredWriteResult): void {
    this.pruneSubmits();
    this.submits.set(this.makeContentKey(subreddit, title, body), { at: this.now(), result });
  }

  /**
   * Enforced dry-run tracking for clients that cannot elicit: a real submit
   * must be preceded by a tracked validate_only pass over the same content.
   */
  recordValidatePass(key: string): void {
    this.pruneValidatePasses();
    this.validatePasses.set(key, this.now());
  }

  /** Whether the same content passed validate_only within the window. */
  hasRecentValidatePass(key: string): boolean {
    this.pruneValidatePasses();
    return this.validatePasses.has(key);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private pruneWriteTimes(now: number): void {
    const cutoff = now - HOUR_MS;
    this.postTimes = this.postTimes.filter(t => t > cutoff);
    this.commentTimes = this.commentTimes.filter(t => t > cutoff);
  }

  private pruneSubmits(): void {
    const cutoff = this.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [key, entry] of this.submits.entries()) {
      if (entry.at <= cutoff) this.submits.delete(key);
    }
  }

  private pruneValidatePasses(): void {
    const cutoff = this.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [key, at] of this.validatePasses.entries()) {
      if (at <= cutoff) this.validatePasses.delete(key);
    }
  }

  private makeContentKey(subreddit: string, title: string, body: string): string {
    return this.hashKey('content', this.normSubreddit(subreddit),
      this.normText(title), this.normText(body));
  }

  /**
   * sha256 over length-prefixed parts. The length prefix prevents ambiguity
   * between e.g. ("ab", "c") and ("a", "bc") that plain joining would allow.
   */
  private hashKey(...parts: string[]): string {
    const hash = createHash('sha256');
    for (const part of parts) {
      hash.update(`${part.length}:${part}`);
    }
    return hash.digest('hex');
  }

  /** Subreddit names are case-insensitive on Reddit; normalize accordingly. */
  private normSubreddit(subreddit: string): string {
    return subreddit.trim().replace(/^\/?r\//i, '').toLowerCase();
  }

  /**
   * Title/body normalization: trim plus whitespace-collapse so an identical
   * retry that only differs in incidental whitespace still matches. Case is
   * preserved: changed casing is a deliberate content change.
   */
  private normText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }
}
