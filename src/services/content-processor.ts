/**
 * Content processor for intelligent summarization and analysis
 */

import { RedditPost, RedditComment, RedditListing } from '../types/reddit.types.js';
import { 
  ProcessedPost, 
  SubredditSummary, 
  UserSummary,
  TrendingAnalysis,
  SentimentComparison 
} from '../types/mcp.types.js';

export class ContentProcessor {
  /**
   * Process and summarize subreddit posts
   */
  static processSubredditPosts(listing: RedditListing<RedditPost>): SubredditSummary {
    const posts = listing.data.children.map(child => child.data);
    
    const processed = posts.map(post => this.processPost(post));
    const vibe = this.analyzeVibe(posts);
    const tldr = this.generateTLDR(posts);
    
    return {
      posts: processed,
      vibe,
      tldr,
      totalPosts: posts.length,
    };
  }

  /**
   * Process individual post
   */
  static processPost(post: RedditPost): ProcessedPost {
    return {
      id: post.id,
      title: post.title,
      score: post.score,
      comments: post.num_comments,
      insight: this.generateInsight(post),
      url: `https://reddit.com${post.permalink}`,
      author: post.author,
      subreddit: post.subreddit,
      created: new Date(post.created_utc * 1000),
    };
  }

  /**
   * Generate insight for a post
   */
  static generateInsight(post: RedditPost): string {
    const ratio = post.num_comments / (post.score || 1);
    const age = (Date.now() / 1000) - post.created_utc;
    const velocity = post.score / (age / 3600); // upvotes per hour
    
    // Analyze engagement pattern
    if (ratio > 0.5) {
      return '🔥 Controversial - high discussion ratio';
    }
    if (velocity > 1000) {
      return '🚀 Viral - gaining traction rapidly';
    }
    if (post.score > 10000) {
      return '⭐ Mega-hit post';
    }
    if (post.score > 1000) {
      return '📈 Popular post';
    }
    if (post.is_video) {
      return '🎥 Video content';
    }
    if (post.stickied) {
      return '📌 Pinned by moderators';
    }
    if (post.distinguished) {
      return '👮 Official post';
    }
    if (ratio > 0.2) {
      return '💬 Discussion-heavy';
    }
    
    return '📄 Standard post';
  }

  /**
   * Analyze overall vibe of posts
   */
  static analyzeVibe(posts: RedditPost[]): string {
    if (posts.length === 0) {
      return '🌵 Empty - no posts found';
    }
    
    const avgScore = posts.reduce((sum, p) => sum + p.score, 0) / posts.length;
    const avgComments = posts.reduce((sum, p) => sum + p.num_comments, 0) / posts.length;
    const hasControversial = posts.some(p => p.upvote_ratio && p.upvote_ratio < 0.7);
    const hasVideo = posts.filter(p => p.is_video).length > posts.length / 3;
    
    if (avgScore > 5000) {
      return '🔥 Hot and trending - extremely active';
    }
    if (avgScore > 1000) {
      return '📈 Active discussion - healthy engagement';
    }
    if (hasControversial) {
      return '⚡ Controversial - mixed opinions';
    }
    if (hasVideo) {
      return '🎬 Video-heavy content';
    }
    if (avgComments > 100) {
      return '💬 Discussion-focused community';
    }
    if (avgScore > 100) {
      return '👥 Normal activity';
    }
    
    return '🌱 Quiet - low engagement';
  }

  /**
   * Generate TLDR summary
   */
  static generateTLDR(posts: RedditPost[]): string {
    if (posts.length === 0) {
      return 'No posts to summarize';
    }
    
    const topPost = posts[0];
    const topics = this.extractTopics(posts.slice(0, 3));
    
    const topPostSummary = `Top: "${this.truncateTitle(topPost.title)}" (${this.formatScore(topPost.score)} upvotes)`;
    
    if (topics.length > 0) {
      return `${topPostSummary}. Themes: ${topics.join(', ')}`;
    }
    
    return topPostSummary;
  }

  /**
   * Extract main topics from posts
   */
  static extractTopics(posts: RedditPost[]): string[] {
    const topics = new Set<string>();
    
    // Simple keyword extraction from titles
    const commonWords = new Set(['the', 'is', 'at', 'be', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'to', 'for']);
    
    posts.forEach(post => {
      const words = post.title.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 3 && !commonWords.has(word));
      
      // Take first 2 meaningful words
      words.slice(0, 2).forEach(word => topics.add(word));
    });
    
    return Array.from(topics).slice(0, 5);
  }

  /**
   * Analyze sentiment of text
   */
  static analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' | 'mixed' {
    const lower = text.toLowerCase();
    
    const positiveWords = [
      'good', 'great', 'awesome', 'excellent', 'love', 'best', 
      'amazing', 'wonderful', 'fantastic', 'happy', 'excited',
      'beautiful', 'perfect', 'nice', 'cool', 'fun'
    ];
    
    const negativeWords = [
      'bad', 'terrible', 'awful', 'hate', 'worst', 'horrible',
      'disgusting', 'ugly', 'stupid', 'dumb', 'sucks', 'angry',
      'sad', 'disappointed', 'failed', 'broken'
    ];
    
    let positiveScore = 0;
    let negativeScore = 0;
    
    positiveWords.forEach(word => {
      if (lower.includes(word)) positiveScore++;
    });
    
    negativeWords.forEach(word => {
      if (lower.includes(word)) negativeScore++;
    });
    
    if (positiveScore > 0 && negativeScore > 0) return 'mixed';
    if (positiveScore > negativeScore) return 'positive';
    if (negativeScore > positiveScore) return 'negative';
    
    return 'neutral';
  }

  /**
   * Calculate trending velocity
   */
  static calculateVelocity(post: RedditPost): number {
    const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;
    return ageHours > 0 ? post.score / ageHours : post.score;
  }

  /**
   * Process trending analysis
   */
  static processTrendingPosts(
    listings: RedditListing<RedditPost>[],
    options: { maxPosts?: number; maxCrossPosts?: number } = {}
  ): TrendingAnalysis {
    const { maxPosts = 10, maxCrossPosts = 5 } = options;
    const allPosts = listings.flatMap(l => l.data.children.map(c => c.data));
    
    // Calculate velocity and trending score
    const postsWithMetrics = allPosts.map(post => {
      const velocity = this.calculateVelocity(post);
      const trendingScore = velocity * Math.log10(post.num_comments + 1);
      
      return {
        ...this.processPost(post),
        velocity,
        trending_score: trendingScore,
        subreddit: post.subreddit,
      };
    });
    
    // Sort by trending score
    postsWithMetrics.sort((a, b) => b.trending_score - a.trending_score);
    
    // Find cross-posts (same or similar titles)
    const crossPosts: Array<{ title: string; subreddits: string[] }> = [];
    const titleMap = new Map<string, Set<string>>();
    
    allPosts.forEach(post => {
      const normalizedTitle = post.title.toLowerCase().trim();
      if (!titleMap.has(normalizedTitle)) {
        titleMap.set(normalizedTitle, new Set());
      }
      titleMap.get(normalizedTitle)!.add(post.subreddit);
    });
    
    titleMap.forEach((subreddits, title) => {
      if (subreddits.size > 1) {
        crossPosts.push({
          title: title.substring(0, 100),
          subreddits: Array.from(subreddits),
        });
      }
    });
    
    // Extract emerging topics
    const emergingTopics = this.extractTopics(
      postsWithMetrics
        .filter(p => p.velocity > 500)
        .map(p => ({ ...p, title: p.title } as any))
    );
    
    return {
      posts: postsWithMetrics.slice(0, maxPosts),
      emergingTopics,
      crossPosts: crossPosts.slice(0, maxCrossPosts),
    };
  }

  /**
   * Compare sentiment across subreddits
   */
  static compareSentiments(
    topic: string,
    subredditData: Map<string, RedditListing<RedditPost>>
  ): SentimentComparison {
    const results: SentimentComparison['subreddits'] = [];
    
    subredditData.forEach((listing, subreddit) => {
      const posts = listing.data.children
        .map(c => c.data)
        .filter(p => p.title.toLowerCase().includes(topic.toLowerCase()));
      
      if (posts.length === 0) {
        results.push({
          name: subreddit,
          sentiment: 'neutral',
          sampleSize: 0,
          examples: [],
        });
        return;
      }
      
      // Analyze sentiment from titles and scores
      const sentiments = posts.map(p => ({
        sentiment: this.analyzeSentiment(p.title),
        score: p.score,
      }));
      
      const sentimentCounts = {
        positive: 0,
        negative: 0,
        neutral: 0,
        mixed: 0,
      };
      
      sentiments.forEach(s => {
        sentimentCounts[s.sentiment]++;
      });
      
      // Determine overall sentiment
      let overallSentiment: 'positive' | 'negative' | 'neutral' | 'mixed' = 'neutral';
      const maxCount = Math.max(...Object.values(sentimentCounts));
      
      if (sentimentCounts.positive === maxCount) overallSentiment = 'positive';
      else if (sentimentCounts.negative === maxCount) overallSentiment = 'negative';
      else if (sentimentCounts.mixed === maxCount) overallSentiment = 'mixed';
      
      results.push({
        name: subreddit,
        sentiment: overallSentiment,
        sampleSize: posts.length,
        examples: posts.slice(0, 3).map(p => this.truncateTitle(p.title)),
      });
    });
    
    // Find consensus
    const sentimentGroups = results.reduce((acc, r) => {
      if (!acc[r.sentiment]) acc[r.sentiment] = [];
      acc[r.sentiment].push(r.name);
      return acc;
    }, {} as Record<string, string[]>);
    
    const consensus = Object.entries(sentimentGroups)
      .sort((a, b) => b[1].length - a[1].length)[0];
    
    return {
      topic,
      subreddits: results,
      consensus: consensus ? `Most subreddits (${consensus[1].join(', ')}) feel ${consensus[0]} about ${topic}` : undefined,
      divergence: results
        .filter(r => r.sentiment !== consensus?.[0])
        .map(r => `${r.name} is ${r.sentiment}`),
    };
  }

  /**
   * Format score for display
   */
  static formatScore(score: number): string {
    if (score >= 1000000) {
      return `${(score / 1000000).toFixed(1)}M`;
    }
    if (score >= 1000) {
      return `${(score / 1000).toFixed(1)}k`;
    }
    return String(score);
  }

  /**
   * Truncate long titles
   */
  static truncateTitle(title: string, maxLength: number = 80): string {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + '...';
  }

  /**
   * Process user summary
   */
  static processUserSummary(
    user: any,
    posts: RedditListing<RedditPost | RedditComment>,
    options: { maxTopSubreddits?: number; comments?: RedditListing<any> } = {}
  ): UserSummary {
    const { maxTopSubreddits = 5 } = options;
    const accountAge = new Date(user.created_utc * 1000);
    const ageYears = (Date.now() - accountAge.getTime()) / (365 * 24 * 60 * 60 * 1000);
    
    // Analyze posting patterns
    const subredditActivity = new Map<string, { posts: number; karma: number }>();
    
    posts.data.children.forEach(child => {
      const item = child.data as any;
      const subreddit = item.subreddit || 'unknown';
      
      if (!subredditActivity.has(subreddit)) {
        subredditActivity.set(subreddit, { posts: 0, karma: 0 });
      }
      
      const activity = subredditActivity.get(subreddit)!;
      activity.posts++;
      activity.karma += item.score || 0;
    });
    
    // Get top subreddits
    const topSubreddits = Array.from(subredditActivity.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.karma - a.karma)
      .slice(0, maxTopSubreddits);
    
    // Detect interests from subreddit names
    const interests = this.detectInterests(Array.from(subredditActivity.keys()));
    
    // Process recent posts (already limited by API call)
    const recentPosts = posts.data.children
      .map(child => {
        const post = child.data as RedditPost;
        return this.processPost(post);
      });
    
    // Process recent comments if provided
    let recentComments;
    if (options.comments && options.comments.data.children.length > 0) {
      recentComments = options.comments.data.children.map(child => {
        const comment = child.data as any; // Reddit API returns additional fields
        return {
          id: comment.id,
          body: comment.body?.substring(0, 200) + (comment.body?.length > 200 ? '...' : ''),
          score: comment.score,
          subreddit: comment.subreddit || 'unknown',
          postTitle: comment.link_title,
          created: new Date(comment.created_utc * 1000),
          url: `https://reddit.com${comment.permalink}`,
        };
      });
    }
    
    return {
      username: user.name,
      accountAge: ageYears > 1 
        ? `${Math.floor(ageYears)} years` 
        : `${Math.floor(ageYears * 12)} months`,
      karma: {
        link: user.link_karma || 0,
        comment: user.comment_karma || 0,
        total: (user.link_karma || 0) + (user.comment_karma || 0),
      },
      interests,
      topSubreddits,
      recentPosts,
      recentComments,
    };
  }

  /**
   * Detect user interests from subreddit activity
   */
  static detectInterests(subreddits: string[]): string[] {
    const interests = new Set<string>();
    
    const categoryMap: Record<string, string[]> = {
      'Technology': ['programming', 'javascript', 'python', 'webdev', 'tech', 'coding', 'linux', 'android', 'apple'],
      'Gaming': ['gaming', 'games', 'pcgaming', 'ps4', 'ps5', 'xbox', 'nintendo', 'steam'],
      'Science': ['science', 'physics', 'chemistry', 'biology', 'space', 'astronomy'],
      'Finance': ['investing', 'stocks', 'wallstreetbets', 'cryptocurrency', 'bitcoin', 'finance'],
      'Sports': ['sports', 'nba', 'nfl', 'soccer', 'football', 'baseball', 'hockey'],
      'Entertainment': ['movies', 'television', 'music', 'books', 'netflix', 'anime'],
      'News': ['news', 'worldnews', 'politics', 'economics'],
      'Lifestyle': ['food', 'cooking', 'fitness', 'health', 'fashion', 'travel'],
    };
    
    subreddits.forEach(sub => {
      const lower = sub.toLowerCase();
      
      for (const [category, keywords] of Object.entries(categoryMap)) {
        if (keywords.some(keyword => lower.includes(keyword))) {
          interests.add(category);
        }
      }
    });
    
    return Array.from(interests);
  }
}