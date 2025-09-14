/**
 * Reddit API type definitions
 */

export interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  subreddit_name_prefixed: string;
  score: number;
  num_comments: number;
  created_utc: number;
  selftext?: string;
  url: string;
  permalink: string;
  is_video?: boolean;
  is_self?: boolean;
  over_18?: boolean;
  stickied?: boolean;
  locked?: boolean;
  link_flair_text?: string;
  author_flair_text?: string;
  distinguished?: string;
  ups: number;
  downs: number;
  upvote_ratio?: number;
}

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  permalink: string;
  depth: number;
  replies?: RedditComment[];
  distinguished?: string;
  is_submitter?: boolean;
  stickied?: boolean;
  controversiality?: number;
}

export interface RedditUser {
  name: string;
  created_utc: number;
  link_karma: number;
  comment_karma: number;
  is_gold?: boolean;
  is_mod?: boolean;
  verified?: boolean;
  has_verified_email?: boolean;
  icon_img?: string;
  subreddit?: {
    display_name: string;
    public_description: string;
    subscribers: number;
  };
}

export interface RedditSubreddit {
  display_name: string;
  display_name_prefixed: string;
  title: string;
  public_description: string;
  description: string;
  subscribers: number;
  active_user_count?: number;
  created_utc: number;
  over18: boolean;
  subreddit_type: 'public' | 'private' | 'restricted' | 'gold_restricted' | 'archived';
  community_icon?: string;
  banner_img?: string;
  header_img?: string;
  wiki_enabled?: boolean;
  allow_videos?: boolean;
  allow_images?: boolean;
  lang?: string;
  whitelist_status?: string;
}

export interface RedditListing<T> {
  kind: string;
  data: {
    after?: string | null;
    before?: string | null;
    children: Array<{
      kind: string;
      data: T;
    }>;
    dist?: number;
    modhash?: string;
  };
}

export interface RedditSearchResult {
  posts: RedditPost[];
  after?: string | null;
  before?: string | null;
}