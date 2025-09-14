/**
 * MCP Tool type definitions
 */

export interface ProcessedPost {
  id: string;
  title: string;
  score: number;
  comments: number;
  insight: string;
  url: string;
  author?: string;
  subreddit?: string;
  created?: Date;
}

export interface SubredditSummary {
  posts: ProcessedPost[];
  vibe: string;
  tldr: string;
  totalPosts?: number;
  timeRange?: string;
}

export interface UserSummary {
  username: string;
  accountAge: string;
  karma: {
    link: number;
    comment: number;
    total: number;
  };
  interests?: string[];
  topSubreddits?: Array<{
    name: string;
    posts: number;
    karma: number;
  }>;
  recentPosts?: ProcessedPost[];
  recentComments?: Array<{
    id: string;
    body: string;
    score: number;
    subreddit: string;
    postTitle?: string;
    created: Date;
    url: string;
  }>;
  timeRangeNote?: string; // Note about the time range of returned data
}

export interface SubredditAnalysis {
  name: string;
  subscribers: number;
  activeUsers?: number;
  description: string;
  rules?: string[];
  moderators?: string[];
  growth?: {
    trend: 'growing' | 'stable' | 'declining';
    percentChange?: number;
  };
  topContributors?: Array<{
    username: string;
    posts: number;
    avgScore: number;
  }>;
  commonTopics?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative' | 'mixed';
  bestPostTime?: {
    hour: number;
    day: string;
    reason: string;
  };
}

export interface SentimentComparison {
  topic: string;
  subreddits: Array<{
    name: string;
    sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
    sampleSize: number;
    examples?: string[];
  }>;
  consensus?: string;
  divergence?: string[];
}

export interface TrendingAnalysis {
  posts: Array<ProcessedPost & {
    velocity: number; // upvotes per hour
    trending_score: number;
    subreddit: string;
  }>;
  emergingTopics?: string[];
  crossPosts?: Array<{
    title: string;
    subreddits: string[];
  }>;
}

export interface RedditExplanation {
  term: string;
  definition: string;
  origin?: string;
  usage?: string;
  examples?: string[];
  relatedTerms?: string[];
  subredditContext?: string;
}