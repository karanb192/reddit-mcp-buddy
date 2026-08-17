/**
 * Error mapping for Reddit write endpoints.
 *
 * Reddit reports write failures as [type, message, field] triples inside an
 * HTTP 200 body ({ json: { errors: [...] } }), not as HTTP error statuses.
 * This module turns known triples into curated, actionable guidance and
 * formats unknown ones generically. Write paths must NEVER echo raw Reddit
 * response bodies: on media flows they carry an S3 upload lease
 * (x-amz-signature, policy) and a websocket_url with a bearer-like token, so
 * everything that could surface to a tool result or a log goes through
 * redactWriteError() first.
 */

/** Reddit's error triple: [type, human message, field]. Field may be null. */
export type WriteErrorTriple = ReadonlyArray<string | null>;

export interface MappedWriteError {
  /** Reddit's error type (e.g. RATELIMIT) or a synthetic HTTP_* code */
  code: string;
  /** Curated, safe-to-surface description. Never raw Reddit body text. */
  message: string;
  /** What the model should do next */
  guidance: string;
  /** Whether a (possibly modified) retry can succeed */
  retryable: boolean;
  /** RATELIMIT only: minutes to wait, parsed from Reddit's message */
  waitMinutes?: number;
  /** ALREADY_SUB only: retrying with resubmit: true will post anyway */
  suggestResubmit?: boolean;
}

/**
 * Error subclass thrown by the write transport and submit endpoints. Carries
 * the mapped object so the tool layer can render structured guidance instead
 * of re-parsing message text.
 */
export class WriteError extends Error {
  readonly write: MappedWriteError;

  constructor(mapped: MappedWriteError) {
    // Include guidance in the plain message too: if the error bubbles up to a
    // generic handler, the model still gets the actionable half.
    super(mapped.guidance ? `${mapped.message} ${mapped.guidance}` : mapped.message);
    this.name = 'WriteError';
    this.write = mapped;
  }
}

/**
 * The known-triple table from the plan's section 6, modeled as data.
 * `message` is our own wording: Reddit's message text is only consulted for
 * the RATELIMIT wait-time parse, never echoed.
 */
const KNOWN_TRIPLES: Record<string, Omit<MappedWriteError, 'code'>> = {
  RATELIMIT: {
    message: 'Reddit rate-limited this account (account-level posting throttle, separate from the API quota).',
    guidance: 'Wait the indicated time before submitting again; do not retry immediately.',
    retryable: true,
  },
  ALREADY_SUB: {
    message: 'This link has already been submitted to this subreddit.',
    guidance: 'Pass resubmit: true to post it anyway, or stop.',
    retryable: true,
    suggestResubmit: true,
  },
  SUBMIT_VALIDATION_FLAIR_REQUIRED: {
    message: 'This subreddit requires a post flair.',
    guidance: 'Call subreddit_rules to list the flair choices, then retry with a flair_id.',
    retryable: true,
  },
  SUBREDDIT_NOTALLOWED: {
    message: 'This account is not permitted to post in this subreddit (restricted or approval-only).',
    guidance: 'Do not retry; pick a different subreddit or request approval from its moderators.',
    retryable: false,
  },
  NO_URL: {
    message: 'A link post needs a URL and none was provided.',
    guidance: 'Provide link_url and retry.',
    retryable: true,
  },
  BAD_URL: {
    message: 'Reddit rejected the URL as invalid.',
    guidance: 'Check that link_url is a full http(s) URL and retry.',
    retryable: true,
  },
  THREAD_LOCKED: {
    message: 'The thread is locked; it does not accept new comments.',
    guidance: 'Stop; commenting here is not possible.',
    retryable: false,
  },
  TOO_OLD: {
    message: 'The thread is archived; commenting is disabled.',
    guidance: 'Stop; archived threads cannot receive comments.',
    retryable: false,
  },
  DELETED_LINK: {
    message: 'The post being replied to was deleted.',
    guidance: 'Stop; the target no longer exists.',
    retryable: false,
  },
  DELETED_COMMENT: {
    message: 'The comment being replied to was deleted.',
    guidance: 'Stop; the target no longer exists.',
    retryable: false,
  },
};

/**
 * Parse the wait time out of Reddit's RATELIMIT message, e.g.
 * "you are doing that too much. try again in 9 minutes." Reddit sometimes
 * phrases it in seconds; those round up to at least 1 minute so the surfaced
 * number never understates the wait.
 */
function parseRatelimitWaitMinutes(message: string): number | undefined {
  const match = message.match(/(\d+)\s*(minute|second)/i);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return /second/i.test(match[2]) ? Math.max(1, Math.ceil(n / 60)) : n;
}

/**
 * Map Reddit's error triples to actionable guidance. Prefers the first triple
 * whose type is in the known table; a fully unknown set gets a generic
 * formatting that names the type and field but never echoes message text
 * (unknown messages are unvetted response content).
 */
export function mapWriteError(triples: WriteErrorTriple[]): MappedWriteError {
  const known = triples.find(t => typeof t?.[0] === 'string' && t[0] in KNOWN_TRIPLES);

  if (known) {
    const code = known[0] as string;
    const spec = KNOWN_TRIPLES[code];
    const mapped: MappedWriteError = { code, ...spec };
    if (code === 'RATELIMIT') {
      const waitMinutes = parseRatelimitWaitMinutes(known[1] ?? '');
      if (waitMinutes !== undefined) {
        mapped.waitMinutes = waitMinutes;
        mapped.guidance = `Wait about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'} before submitting again; do not retry immediately.`;
      }
    }
    return mapped;
  }

  const first = triples[0];
  const type = typeof first?.[0] === 'string' && first[0] ? first[0] : 'UNKNOWN';
  const field = typeof first?.[2] === 'string' && first[2] ? first[2] : undefined;
  return {
    code: type,
    message: `Reddit rejected the write (${type}${field ? ` on field ${field}` : ''}).`,
    guidance: 'Check the inputs against the subreddit rules; the Reddit error type is in code.',
    retryable: false,
  };
}

/**
 * Map an HTTP-level failure on a write path. Write 403/404s mean the
 * subreddit is unreachable for posting; the read path's "try r/programming"
 * advice would be actively wrong here.
 */
export function mapWriteHttpError(status: number, subreddit?: string): WriteError {
  const sub = subreddit ? `r/${subreddit}` : 'this subreddit';

  if (status === 403 || status === 404) {
    return new WriteError({
      code: `HTTP_${status}`,
      message: `Cannot post to ${sub} (private, quarantined, or banned).`,
      guidance: 'Do not retry; this account cannot write there.',
      retryable: false,
    });
  }
  if (status === 429) {
    return new WriteError({
      code: 'HTTP_429',
      message: 'Reddit rate-limited the request (HTTP 429).',
      guidance: 'Wait before retrying; do not auto-hammer.',
      retryable: true,
    });
  }
  if (status >= 500) {
    return new WriteError({
      code: `HTTP_${status}`,
      // 5xx after a write was sent is ambiguous: Reddit may have accepted it
      // before failing. The transport never auto-retries; the idempotency
      // record makes an identical manual retry safe.
      message: `Reddit server error (HTTP ${status}); the write may or may not have gone through.`,
      guidance: 'It was not retried automatically. Re-issue the identical call: a recent duplicate returns the original result instead of double-posting.',
      retryable: false,
    });
  }
  return new WriteError({
    code: `HTTP_${status}`,
    message: `Reddit write request failed (HTTP ${status}).`,
    guidance: 'Check the inputs; the response body is withheld from this error on purpose.',
    retryable: false,
  });
}

/**
 * Scrub secrets from any error text that could surface on a write path.
 * Targets the known leak shapes (S3 upload lease and websocket handoff) plus
 * bearer-like tokens as a general backstop. Order matters only in that each
 * pattern replaces the secret value while keeping the identifying label, so
 * the redacted text still says WHAT was scrubbed.
 */
export function redactWriteError(text: string): string {
  return text
    // S3 lease signature: header, query-param, or JSON forms
    .replace(/([xX]-[aA]mz-[sS]ignature["']?\s*[:=]\s*["']?)[A-Fa-f0-9]+/g, '$1[REDACTED]')
    // S3 policy blob: a long base64 string labeled "policy"
    .replace(/(["']?policy["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=]{20,}/g, '$1[REDACTED]')
    // websocket handoff URL: the path carries a bearer-like token
    .replace(/(wss:\/\/)[^\s"'<>]+/g, '$1[REDACTED]')
    .replace(/(["']websocket_url["']\s*:\s*["'])[^"']+/g, '$1[REDACTED]')
    // Authorization headers / bearer-like tokens
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[REDACTED]')
    .replace(/(["']access_token["']\s*:\s*["'])[^"']+/g, '$1[REDACTED]');
}
