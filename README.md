[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/karanb192-reddit-buddy-mcp-badge.png)](https://mseep.ai/app/karanb192-reddit-buddy-mcp)

# 🤖 Reddit Buddy MCP

### Reddit Browser for Claude Desktop and AI Assistants

A Model Context Protocol (MCP) server that enables Claude Desktop and other AI assistants to browse Reddit, search posts, and analyze user activity. Clean, fast, and actually works - no API keys required.

[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@karanb192/reddit-buddy-mcp.svg)](https://www.npmjs.com/package/@karanb192/reddit-buddy-mcp)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-blue)](https://nodejs.org)

## Table of Contents

- [What makes Reddit Buddy different?](#what-makes-reddit-buddy-different)
- [Quick Start](#quick-start-30-seconds)
- [What can it do?](#what-can-it-do)
- [Available Tools](#available-tools)
- [Authentication](#authentication-optional)
- [Installation Options](#installation-options)
- [Comparison with Other Tools](#comparison-with-other-tools)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Support](#support)

## What makes Reddit Buddy different?

- **🚀 Zero setup** - Works instantly, no Reddit API registration needed
- **⚡ 10x faster** - Optional authentication gives you 10x more requests
- **🎯 Clean data** - No fake "sentiment analysis" or made-up metrics
- **🧠 LLM-optimized** - Built specifically for AI assistants like Claude
- **📦 TypeScript** - Fully typed, reliable, and maintainable

## Quick Start (30 seconds)

### For Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["@karanb192/reddit-buddy-mcp"]
    }
  }
}
```

That's it! Reddit Buddy is now available in Claude.

## What can it do?

Ask your AI assistant to:

- 📊 **"What's trending on Reddit?"** - Browse hot posts from r/all
- 🔍 **"Search for discussions about AI"** - Search across all subreddits
- 💬 **"Get comments from this Reddit post"** - Fetch post with full comment threads
- 👤 **"Analyze user spez"** - Get user history, karma, and activity
- 📚 **"Explain Reddit karma"** - Understand Reddit terminology

## Available Tools

### `browse_subreddit`
Browse posts from any subreddit with sorting options.
```
- Subreddit:
  - "all" - entire Reddit frontpage
  - "popular" - trending across Reddit
  - Any specific subreddit (e.g., "technology", "programming", "science")
- Sort by: hot, new, top, rising, controversial
- Time range: hour, day, week, month, year, all (for top/controversial sort)
- Include subreddit info: Optional flag for subreddit metadata
```

### `search_reddit`
Search across Reddit or specific subreddits.
```
- Query: Your search terms
- Filter by: subreddit, author, time, flair
- Sort by: relevance, hot, top, new, comments
```

### `get_post_details`
Get a post with all its comments.
```
- Input:
  - Reddit URL (full URL including subreddit), OR
  - Post ID alone (will auto-detect subreddit, 2 API calls), OR
  - Post ID + subreddit (most efficient, 1 API call)
- Options: comment sorting, depth, link extraction
```

### `user_analysis`
Analyze a Reddit user's profile.
```
- Username: Any Reddit user
- Returns: karma, posts, comments, active subreddits
```

### `reddit_explain`
Get explanations of Reddit terms.
```
- Terms: karma, cake day, AMA, ELI5, etc.
```

## Authentication (Optional)

Want 10x more requests? Add Reddit credentials:

1. Go to https://www.reddit.com/prefs/apps
2. Create an app (type: script)
3. Add credentials to `.env`:

```env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=YourApp/1.0
```

4. Update your Claude config:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["reddit-buddy-mcp"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id",
        "REDDIT_CLIENT_SECRET": "your_client_secret",
        "REDDIT_USER_AGENT": "YourApp/1.0"
      }
    }
  }
}
```

## Installation Options

### Testing with HTTP Mode (for developers)

To test the server directly in your terminal:
```bash
# Run in HTTP mode on port 3000
npx @karanb192/reddit-buddy-mcp --http

# Or with custom port
REDDIT_BUDDY_PORT=8080 npx @karanb192/reddit-buddy-mcp --http
```

**Note:** The server runs in stdio mode by default (for Claude Desktop). Use `--http` flag for testing with Postman MCP or direct API calls.

### Global Install
```bash
npm install -g @karanb192/reddit-buddy-mcp
reddit-buddy --http  # For testing
```

### From Source
```bash
git clone https://github.com/karanb192/reddit-buddy-mcp.git
cd reddit-buddy-mcp
npm install
npm run build
npm link
```

### Using Docker
```bash
docker run -it karanb192/reddit-buddy-mcp
```

## Comparison with Other Tools

| Feature | Reddit Buddy | Other MCP Tools |
|---------|-------------|----------------|
| **Zero Setup** | ✅ Works instantly | ❌ Requires API keys |
| **Language** | TypeScript/Node.js | Python (most) |
| **Tools Count** | 5 (focused) | 8-10 (redundant) |
| **Fake Metrics** | ✅ Real data only | ❌ "Sentiment scores" |
| **Search** | ✅ Full search | Limited or none |
| **Caching** | ✅ Smart caching | Usually none |
| **LLM Optimized** | ✅ Clear params | Confusing options |

## Rate Limits

| Mode | Requests/Minute | Cache TTL |
|------|----------------|-----------|
| Anonymous | 10 | 15 min |
| Authenticated | 100 | 5 min |

## Why Reddit Buddy?

### What others do wrong:
- ❌ **Fake metrics** - "sentiment scores" that are just keyword counting
- ❌ **Complex setup** - Requiring API keys just to start
- ❌ **Bloated responses** - Returning 100+ fields of Reddit's raw API
- ❌ **Poor LLM integration** - Confusing parameters and unclear descriptions

### What we do right:
- ✅ **Real data only** - If it's not from Reddit's API, we don't make it up
- ✅ **Clean responses** - Only the fields that matter
- ✅ **Clear parameters** - LLMs understand exactly what to send
- ✅ **Fast & cached** - Responses are instant when possible

## Examples

### Your AI can now answer:

**"What are the top posts about GPT-4 today?"**
```
→ search_reddit with query="GPT-4", time="day", sort="top"
```

**"Show me what's trending in technology"**
```
→ browse_subreddit with subreddit="technology", sort="hot"
```

**"What do people think about this article?"**
```
→ search_reddit with the article URL to find discussions
```

**"Analyze the user DeepFuckingValue"**
```
→ user_analysis with username="DeepFuckingValue"
```

**"Get the comments from this Reddit post"**
```
→ get_post_details with url="https://reddit.com/r/..."
```

**"What's trending across all of Reddit?"**
```
→ browse_subreddit with subreddit="all", sort="hot"
```

## Troubleshooting

### Common Issues

**"Command not found" error**
```bash
# Ensure npm is installed
node --version
npm --version

# Try with full npx path
$(npm bin -g)/reddit-buddy-mcp
```

**Rate limit errors**
- Without auth: Limited to 10 requests/minute
- Solution: Add Reddit credentials (see [Authentication](#authentication-optional))

**"Subreddit not found"**
- Check spelling (case-insensitive)
- Some subreddits may be private or quarantined
- Try "all" or "popular" instead

**Connection issues**
- Reddit may be down (check https://www.redditstatus.com)
- Firewall blocking requests
- Try restarting the MCP server

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `REDDIT_CLIENT_ID` | Reddit app client ID | No | - |
| `REDDIT_CLIENT_SECRET` | Reddit app secret | No | - |
| `REDDIT_USER_AGENT` | User agent string | No | `RedditBuddy/1.0` |
| `REDDIT_BUDDY_HTTP` | Run as HTTP server | No | `false` |
| `REDDIT_BUDDY_NO_CACHE` | Disable caching (always fetch fresh) | No | `false` |

## Technical Details

### Smart Caching System

Reddit Buddy includes intelligent caching to improve performance and reduce API calls:

- **Memory Safe**: Hard limit of 50MB - won't affect your system performance
- **Adaptive TTLs**: Hot posts (5min), New posts (2min), Top posts (30min)
- **LRU Eviction**: Automatically removes least-used data when approaching limits
- **Hit Tracking**: Optimizes cache based on actual usage patterns

This means faster responses and staying well within Reddit's rate limits, all while using minimal system resources.

## Development

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Build
npm run build

# Test
npm test

# Lint
npm run lint

# Type check
npm run typecheck
```

### Requirements
- Node.js >= 18.0.0
- npm or yarn
- TypeScript 5.5+

## Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

We keep things simple:
- No fake analytics
- Clean, typed code
- Clear documentation
- Fast responses

## Support

- 🐛 [Report bugs](https://github.com/karanb192/reddit-buddy-mcp/issues)
- 💡 [Request features](https://github.com/karanb192/reddit-buddy-mcp/issues)
- ⭐ [Star on GitHub](https://github.com/karanb192/reddit-buddy-mcp)

## License

MIT - Use it however you want!

---

Made with ❤️ for the MCP community. No venture capital, no tracking, just a good MCP server.