/**
 * Server-wide NSFW setting (REDDIT_BUDDY_NSFW).
 *
 * The per-call include_nsfw flag is set by the model, so on its own it cannot
 * give an owner a lock ("never") or a different default ("always").
 */
export type NsfwMode = 'ask' | 'never' | 'always';

export const NSFW_ENV = 'REDDIT_BUDDY_NSFW';

const MODES: readonly NsfwMode[] = ['ask', 'never', 'always'];

export interface NsfwSetting {
  mode: NsfwMode;
  /** Set when the value was not one of the three modes */
  warning?: string;
}

export function parseNsfwMode(value: string | undefined): NsfwSetting {
  const cleaned = (value ?? '').trim().toLowerCase();
  // Claude Desktop passes the placeholder itself when an optional setting is left empty.
  if (cleaned === '' || cleaned.startsWith('${')) {
    return { mode: 'ask' };
  }
  if ((MODES as readonly string[]).includes(cleaned)) {
    return { mode: cleaned as NsfwMode };
  }
  // An unreadable value hides NSFW: a typo must not open what the owner may have meant to lock.
  return {
    mode: 'never',
    warning: `${NSFW_ENV} must be ask, never or always, not ${JSON.stringify(cleaned.slice(0, 20))}. NSFW content is hidden (never) until it is fixed.`,
  };
}

/** Whether a call returns NSFW content, given the server mode and the call's own include_nsfw. */
export function resolveIncludeNsfw(mode: NsfwMode, requested: boolean | undefined): boolean {
  if (mode === 'never') return false;
  return requested ?? mode === 'always';
}

export const NSFW_NEVER_MESSAGE = `This server is set to never return NSFW content (${NSFW_ENV}).`;

/** For the tools that take include_nsfw: what the model can do about hidden NSFW content under this mode. */
export function nsfwHint(mode: NsfwMode): string {
  return mode === 'never'
    ? `${NSFW_NEVER_MESSAGE} include_nsfw has no effect.`
    : 'Set include_nsfw true only if the user asks for NSFW content.';
}

export const INCLUDE_NSFW_DESCRIPTION =
  'Leave unset to follow the server setting (NSFW hidden unless the server owner chose otherwise). Set true ONLY IF the user asks for NSFW content; set false to hide it. No effect on a server set to never return NSFW.';
