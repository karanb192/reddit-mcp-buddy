# <img src="assets/reddit-mcp-buddy-icon-white-background.png" width="48" align="center"/> Reddit MCP Buddy

### Reddit Browser for Claude Desktop and AI Assistants

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for browsing Reddit, searching posts, and analyzing user activity. Anonymous browsing uses Reddit's public RSS feeds when available. Search, comments, user analysis, and full metrics require approved Reddit API access.

[![npm version](https://img.shields.io/npm/v/reddit-mcp-buddy.svg)](https://www.npmjs.com/package/reddit-mcp-buddy)
[![npm downloads](https://img.shields.io/npm/dm/reddit-mcp-buddy.svg)](https://www.npmjs.com/package/reddit-mcp-buddy)
[![GitHub stars](https://img.shields.io/github/stars/karanb192/reddit-mcp-buddy.svg?style=flat&logo=github&color=brightgreen)](https://github.com/karanb192/reddit-mcp-buddy/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## 🎬 See It In Action

![Reddit MCP Buddy Demo - AirPods Max 2 and Dune Part Three](assets/images/reddit-mcp-buddy-demo-2026.gif)

*Claude checking Reddit's reaction to the Dune Part Three trailer and whether the AirPods Max 2 are worth $549*

![Reddit MCP Buddy Demo - Analyzing H1B sentiment across subreddits](assets/images/reddit-mcp-buddy.gif)

*Claude analyzing real-time sentiment about H-1B visa changes across r/cscareerquestions and r/india*

## Table of Contents

- [What makes Reddit MCP Buddy different?](#what-makes-reddit-mcp-buddy-different)
- [Quick Start](#quick-start-30-seconds)
- [What can it do?](#what-can-it-do)
- [Available Tools](#available-tools)
- [Authentication](#authentication-optional)
- [Installation Options](#installation-options)
  - [Global Install](#global-install)
  - [From Source](#from-source)
  - [Using Docker](#using-docker)
  - [Claude Desktop Extension](#claude-desktop-extension)
- [Comparison with Other Tools](#comparison-with-other-tools)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Support](#support)
- [Related Resources](#-related-resources)

## What makes Reddit MCP Buddy different?

- **🚀 Anonymous browsing** - Browse subreddits through public RSS feeds when available; other live-data tools need approved API access
- **⚡ Local rate limits** - Configured caps of 10/60/100 requests per minute; Reddit applies its own limits
- **🎯 Clean data** - No fake "sentiment analysis" or made-up metrics
- **🧠 LLM-optimized** - Built specifically for AI assistants like Claude
- **📦 TypeScript** - Fully typed, reliable, and maintainable
- **✅ Rate-limit testing** - Verification tools for the server's local authentication tiers

## Quick Start (30 seconds)

### For Claude Desktop - Desktop Extension (Easiest!)

1. **Download**: [reddit-mcp-buddy.mcpb](https://github.com/karanb192/reddit-mcp-buddy/releases/latest/download/reddit-mcp-buddy.mcpb)
2. **Install**: Open the downloaded file
3. **Done!** Reddit tools are now available in Claude

### For Claude Desktop - NPM Method (Alternative)

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "reddit-mcp-buddy"]
    }
  }
}
```

### For Claude Code

Run this command to add the MCP server (user scope):

```bash
claude mcp add --transport stdio reddit-mcp-buddy -s user -- npx -y reddit-mcp-buddy
```

### For Other MCP Clients

Use the NPM method: `npx -y reddit-mcp-buddy`

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
- Include subreddit info: Optional flag for subreddit metadata (requires credentials)
```

> **No credentials?** Results are served from Reddit's public RSS feed (`data_source: "rss"`): `score`, `num_comments`, `upvote_ratio`, and `nsfw` come back `null`, and the `include_nsfw` filter can't be applied. Add credentials ([Authentication](#authentication-optional)) for full data via the API.

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
  - Reddit URL (supports multiple formats), OR
  - Post ID alone (will auto-detect subreddit, 2 API calls), OR
  - Post ID + subreddit (most efficient, 1 API call)
- Supported URL formats:
  - reddit.com, www.reddit.com
  - old.reddit.com, new.reddit.com
  - np.reddit.com (No Participation links)
  - m.reddit.com (mobile links)
  - redd.it short URLs
  - URLs with query params (?utm_source=...) or fragments (#comment)
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

Search, post details, user analysis, and full metrics require Reddit API credentials for an approved app and use case.

### Reddit API approval

Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) requires explicit approval before using its API. Creating an app is not a self-service guarantee of access. Reddit directs developers to [Devvit](https://developers.reddit.com/) first; for use cases Devvit does not support, use [Reddit's API access request form](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164).

If you already have approved access, use your app's credentials below. This project cannot grant approval or guarantee an approval timeline, and it does not provide shared API keys or a third-party OAuth service.

Without credentials, `browse_subreddit` can use public RSS feeds and `reddit_explain` works offline. RSS can be blocked or throttled and does not provide engagement metrics or NSFW flags. It does not enable search, post details, or user analysis, and it does not grant API approval.

### Setup Steps

1. **Obtain Reddit API approval** for your app and use case using the links above.
2. **Open** https://www.reddit.com/prefs/apps and select your approved app. If Reddit instructs you to create an app, follow its instructions.
3. **Fill out the form:**
   - **Name**: For example, "mcp-buddy". Reddit rejects client names containing "reddit".
   - **App type**: Use **"script"** for password-grant authentication or **"web app"** for OAuth consent with a refresh token. App-only mode supports both.
   - **Description**: Optional
   - **About URL**: Leave blank
   - **Redirect URI**: Your registered OAuth callback, such as `http://localhost:8080`. It is unused by password-grant authentication.
4. **Complete app registration** as directed by Reddit. If creation is unavailable, follow up through Reddit's access request process.
5. **Find your credentials:**
   - **Client ID**: The string beneath the app's name and type
   - **Client Secret**: The secret string
6. **Update your Claude Desktop config:**

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "reddit-mcp-buddy"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id",
        "REDDIT_CLIENT_SECRET": "your_client_secret",
        "REDDIT_USERNAME": "your_username",
        "REDDIT_PASSWORD": "your_password"
      }
    }
  }
}
```

### Web apps with OAuth consent

An approved web app can authenticate a user without their Reddit password. Complete Reddit's [authorization-code flow](https://github.com/reddit-archive/reddit/wiki/OAuth2#authorization) with your registered redirect URI, a random `state` value that your callback verifies, and `duration=permanent` to obtain a refresh token. Request `identity`, `read`, and `history` for the read-only tools; Reddit documents each endpoint's required scope in its [API reference](https://www.reddit.com/dev/api).

Set these variables in the server's environment:

```json
{
  "REDDIT_CLIENT_ID": "your_client_id",
  "REDDIT_CLIENT_SECRET": "your_client_secret",
  "REDDIT_REFRESH_TOKEN": "your_refresh_token"
}
```

Leave `REDDIT_PASSWORD` unset when using a refresh token. Setting both is rejected at startup. The server exchanges the refresh token for access tokens as needed and does not write environment credentials to `auth.json`. Refresh tokens loaded from that file are not used; configure this mode through the environment.

Treat a refresh token like a password. Keep it outside version control and revoke access in [Reddit app preferences](https://www.reddit.com/prefs/apps) when it is no longer needed. OAuth consent does not grant Reddit API approval or extend the approved use case.

### Three-Tier Authentication System

Reddit MCP Buddy enforces these local caps. They are not Reddit API quotas or guaranteed throughput:

| Mode | Local Cap | Required Credentials | Best For |
|------|------------|---------------------|----------|
| **Anonymous** | 10 req/min* | None | Testing, light usage |
| **App-Only** | 60 req/min | Client ID + Secret | Regular browsing |
| **Authenticated** | 100 req/min | Client ID + Secret, plus refresh token or username/password | Heavy usage, automation |

*\*Server-side cap. Anonymous requests are served from Reddit's logged-out RSS feed, which applies its own stricter per-IP throttle (often one uncached request per 25-60 seconds). The 15-minute cache and automatic retries absorb much of this, but sustained anonymous browsing is effectively slower than 10 req/min.*

#### How It Works:
- **Anonymous Mode**: Default mode, no setup required. Only `browse_subreddit` (plus the offline `reddit_explain`) works: Reddit blocks the logged-out JSON API, so browse results come from Reddit's public RSS feed (`data_source: "rss"`) with engagement metrics and NSFW flags as `null`. The remaining tools require credentials.
- **App-Only Mode**: Uses OAuth2 client credentials grant (works with both script and web apps)
- **Authenticated Mode**: Uses OAuth2 refresh-token authentication for an authorized web app, or password grant for a script app

**Important Notes**:
- Client credentials select app-only mode; a refresh token or username/password selects user authentication.
- A refresh token carries the scopes granted during consent. Missing scopes can prevent individual tools from working.
- User authentication changes this server's local cap; it does not grant a larger quota from Reddit.

## Privacy & Data Handling

Reddit MCP Buddy is designed with privacy and transparency in mind. Here's how your data is handled:

### Data Collection
- **Reddit API Data**: The server fetches public Reddit content (posts, comments, user profiles) through Reddit's official API
- **No Tracking**: We don't collect, store, or transmit any analytics, telemetry, or usage data
- **No Third Parties**: All data flows directly between your machine, Reddit's API, and your AI assistant

### Local Storage
- **Authentication Credentials** (optional):
  - Stored locally in `~/.reddit-mcp-buddy/auth.json` when using `--auth` CLI setup
  - Passwords are **never** written to disk - only used in-memory for OAuth token exchange
  - Environment variables (recommended for Claude Desktop) are never persisted by this server
- **Cache Data**:
  - Reddit API responses are temporarily cached in memory to improve performance
  - Cache size limited to 50MB maximum
  - All cache data is cleared when the server stops
  - Can be disabled with `REDDIT_BUDDY_NO_CACHE=true`

### Data Transmission
- **Reddit API Only**: Your credentials are only sent to Reddit's official OAuth endpoints (`https://oauth.reddit.com` and `https://www.reddit.com`)
- **No External Services**: No data is sent to any other external services, analytics platforms, or third parties
- **Local Processing**: All data processing happens locally on your machine

### Security Notes
- **Read-Only Operations**: All tools are read-only - the server never posts, comments, or modifies any Reddit content
- **Credential Safety**:
  - OAuth tokens are refreshed automatically and kept in memory; only `--auth` CLI setups also cache the token in `~/.reddit-mcp-buddy/auth.json` (file mode 600)
  - Client secrets are treated as sensitive and never logged
  - Use environment variables in Claude Desktop config for maximum security
- **Open Source**: Full source code is available at https://github.com/karanb192/reddit-mcp-buddy for security auditing

### GDPR & Privacy Compliance
- **No Personal Data Collection**: We don't collect or process any personal data beyond what's necessary to authenticate with Reddit's API
- **User Control**: You control all credentials and can delete `~/.reddit-mcp-buddy/auth.json` at any time
- **Right to Erasure**: Simply delete the auth file or uninstall the server to remove all local data

### Questions or Concerns?
If you have any privacy questions or concerns, please [open an issue](https://github.com/karanb192/reddit-mcp-buddy/issues) on GitHub.

## Testing & Development

### Testing Your Rate Limits

Reddit MCP Buddy includes comprehensive testing tools to verify your authentication is working correctly:

```bash
# Clone the repository first
git clone https://github.com/karanb192/reddit-mcp-buddy.git
cd reddit-mcp-buddy
npm install

# Test with your current environment settings
npm run test:rate-limit

# Test specific authentication modes
npm run test:rate-limit:anon    # Test anonymous mode (10 rpm)
npm run test:rate-limit:app     # Test app-only mode (60 rpm)
npm run test:rate-limit:auth    # Test authenticated mode (100 rpm)
```

The rate limit tester will:
- Start a local server instance
- Make rapid API requests to test rate limits
- Display a real-time progress bar
- Confirm which authentication tier you're using
- Show exactly when rate limiting kicks in

### Interactive Authentication Setup (for local testing only)

For local development and testing, you can set up authentication interactively:
```bash
npx -y reddit-mcp-buddy --auth
```

This will prompt you for Reddit app credentials and save them locally. **Note: This does NOT work with Claude Desktop** - use environment variables in your Claude config instead.

### Testing with HTTP Mode

To test the server directly in your terminal:
```bash
# Run in HTTP mode on port 3000
npx -y reddit-mcp-buddy --http

# Or with custom port
REDDIT_BUDDY_PORT=8080 npx -y reddit-mcp-buddy --http
```

**Note:** The server runs in stdio mode by default (for Claude Desktop). Use `--http` flag for testing with Postman MCP or direct API calls.

## Installation Options

### Global Install
```bash
npm install -g reddit-mcp-buddy
reddit-buddy --http  # For testing
```

### From Source
```bash
git clone https://github.com/karanb192/reddit-mcp-buddy.git
cd reddit-mcp-buddy
npm install
npm run build
npm link
```

### Using Docker

The Docker image and CI workflows use Node.js 26. To build and run the image:

```bash
git clone https://github.com/karanb192/reddit-mcp-buddy.git
cd reddit-mcp-buddy
docker build --pull -t reddit-mcp-buddy .
docker run -it reddit-mcp-buddy
```

Run the container smoke test with Docker, curl, and jq installed:

```bash
bash tests/test-docker.sh reddit-mcp-buddy
```

The test checks container health, MCP initialization, tool discovery, and shutdown without Reddit credentials.

### Claude Desktop Extension

For one-click installation in Claude Desktop, download the pre-built extension:

**📦 [Download reddit-mcp-buddy.mcpb](https://github.com/karanb192/reddit-mcp-buddy/releases/latest/download/reddit-mcp-buddy.mcpb)**

**Installation:** Simply open the downloaded `.mcpb` file - Claude Desktop will automatically install the extension and the Reddit tools will be immediately available.

#### Build from Source (Optional)

If you prefer to build the extension yourself:
```bash
git clone https://github.com/karanb192/reddit-mcp-buddy.git
cd reddit-mcp-buddy
./scripts/build-mcpb.sh
```

**Note**: Most users should use the standard npm installation method shown in [Quick Start](#quick-start-30-seconds).

## Comparison with Other Tools

| Feature | Reddit MCP Buddy | Other MCP Tools |
|---------|-------------|----------------|
| **Anonymous Access** | RSS browsing; other data tools require approved API access | Varies by server |
| **Language** | TypeScript/Node.js | Python (most) |
| **Tools Count** | 5 (focused) | 8-10 (redundant) |
| **Fake Metrics** | ✅ Real data only | ❌ "Sentiment scores" |
| **Search** | ✅ Full search | Limited or none |
| **Caching** | ✅ Smart caching | Usually none |
| **LLM Optimized** | ✅ Clear params | Confusing options |
| **Rate Limit Testing** | ✅ Built-in tools | ❌ No verification |

## Rate Limits

| Mode | Requests/Minute | Cache TTL | Setup Required |
|------|----------------|-----------|----------------|
| Anonymous | 10 | 15 min | None |
| App-only | 60 | 5 min | Client ID + Secret |
| Authenticated | 100 | 5 min | All credentials |

*Cache TTL applies to subreddit listings. Post details (10 min), search results (10 min), and user profiles (15 min) use fixed TTLs in all modes. Anonymous throughput is additionally bounded by Reddit's own per-IP RSS throttle, which is stricter than 10/min for uncached requests.*

## Why Reddit MCP Buddy?

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

**"Cannot create an app" or "API approval required"**
- Follow Reddit's [approval process](#reddit-api-approval); this project cannot approve an app or remove Reddit's restrictions
- Use credentials only for an app and use case Reddit has approved

**"Can't achieve 100 requests/minute"**
- The 10/60/100 tiers are this server's local caps, not guaranteed throughput from Reddit
- Respect Reddit's rate-limit responses; adding account credentials does not increase Reddit's granted quota
- Run `npm run test:rate-limit:app` or `npm run test:rate-limit:auth` to inspect the corresponding local mode (requires cloning the repo)

**"Command not found" error**
```bash
# Ensure npm is installed
node --version
npm --version

# Try the full global-bin path
$(npm prefix -g)/bin/reddit-mcp-buddy
```

**Browsing works but search / comments / user analysis fail**
- Without credentials only `browse_subreddit` (served from Reddit's public RSS feed, no scores or comment counts) and the offline `reddit_explain` work
- Anonymous browsing can also hit Reddit's own RSS rate limit (HTTP 429); the server retries automatically, but sustained throttling can still fail
- Solution: Add Reddit credentials (see [Authentication](#authentication-optional))

**Rate limit errors**
- Local caps: 10 requests/minute without auth, 60 with app credentials, and 100 with full authentication
- Reddit applies separate API and RSS limits; the server retries transient failures, but sustained throttling can still fail
- Reduce request frequency and respect Reddit's rate-limit responses
- If an error says `Retry in Ns`, wait that long before retrying. The server returns long upstream waits immediately instead of sleeping through the client's request timeout.

**"Subreddit not found"**
- Check spelling (case-insensitive)
- Some subreddits may be private or quarantined
- Try "all" or "popular" instead

**Connection issues**
- Reddit may be down (check https://www.redditstatus.com)
- Firewall blocking requests
- Try restarting the MCP server

### Environment Variables

#### Authentication Variables
| Variable | Description | Required | Rate Limit |
|----------|-------------|----------|------------|
| `REDDIT_CLIENT_ID` | Reddit app client ID | No | Local cap: 60 req/min (with secret) |
| `REDDIT_CLIENT_SECRET` | Reddit app secret | No | Local cap: 60 req/min (with ID) |
| `REDDIT_USERNAME` | Reddit account username | No | Local cap: 100 req/min (with all 4) |
| `REDDIT_PASSWORD` | Reddit account password | No | Local cap: 100 req/min (with all 4) |
| `REDDIT_REFRESH_TOKEN` | OAuth refresh token; leave password unset | No | Local cap: 100 req/min with client ID + secret |
| `REDDIT_USER_AGENT` | Custom user agent string (applies when credentials are configured) | No | - |

#### Server Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `REDDIT_BUDDY_HTTP` | Run as HTTP server instead of stdio | `false` |
| `REDDIT_BUDDY_PORT` | HTTP server port (when HTTP=true) | `3000` |
| `REDDIT_BUDDY_HOST` | Interface the HTTP server binds to | `127.0.0.1` |
| `REDDIT_BUDDY_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the HTTP endpoint | none |
| `REDDIT_BUDDY_ALLOWED_HOSTS` | Comma-separated `host:port` values accepted in the Host header (DNS-rebinding protection) | loopback values when bound to localhost |
| `REDDIT_BUDDY_NO_CACHE` | Disable caching (always fetch fresh) | `false` |

> **HTTP mode has no authentication.** It binds to localhost so only your machine can reach it, and rejects Host headers outside the loopback set. Setting `REDDIT_BUDDY_HOST=0.0.0.0` exposes it to your whole network - only do that on a trusted network (e.g. inside Docker, which sets it deliberately). On a non-loopback bind the Host check is off by default, since clients legitimately arrive with a container IP or service name; set `REDDIT_BUDDY_ALLOWED_HOSTS` to restrict it. Browser requests are rejected unless their origin is listed in `REDDIT_BUDDY_ALLOWED_ORIGINS`; non-browser clients like Postman are unaffected.

### HTTP and HTTPS Proxies

On Node 22.21.0+ in the 22.x line, or Node 24 and newer, enable Node's built-in proxy support before starting the server. The project's Node 26 Docker image supports this. Check `node --version` first: unsupported versions can ignore these settings and connect directly. Node currently marks this feature as under active development.

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "reddit-mcp-buddy"],
      "env": {
        "NODE_USE_ENV_PROXY": "1",
        "HTTP_PROXY": "http://proxy.example.com:8080",
        "HTTPS_PROXY": "http://proxy.example.com:8080",
        "NO_PROXY": "localhost,127.0.0.1"
      }
    }
  }
}
```

`HTTP_PROXY` routes HTTP requests; `HTTPS_PROXY` routes HTTPS requests, including Reddit API and RSS calls. `NO_PROXY` excludes matching hosts. Export these variables in your shell for CLI use, or pass them with Docker's `-e` options. Set them in the process environment before startup; the server does not load a project `.env` file automatically.

Inside Docker, `localhost` refers to the container. On Docker Desktop, use `host.docker.internal` to reach a proxy running on the host.

Proxy authentication can be included in the proxy URL as `http://username:password@proxy.example.com:8080`. Treat that value as a credential and redact it from shared logs and configuration. For a network that uses a private certificate authority, use `NODE_EXTRA_CA_CERTS` with your organization's PEM certificate file instead of disabling TLS verification.

See [Node's proxy and certificate configuration guide](https://nodejs.org/learn/http/enterprise-network-configuration). Proxy support routes network traffic; it does not grant Reddit API approval or bypass Reddit's access rules.

## Technical Details

### Smart Caching System

Reddit MCP Buddy includes intelligent caching to improve performance and reduce API calls:

- **Memory Safe**: Hard limit of 50MB - won't affect your system performance
- **Per-Content TTLs**: Post details (10min), user profiles (15min), search results (10min); subreddit listings use the mode default (15min anonymous, 5min with credentials)
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

# Run tests
npm test                     # Unit tests
npm run test:integration     # Integration tests
npm run test:all             # All tests

# Test rate limits
npm run test:rate-limit       # Test with current environment
npm run test:rate-limit:anon  # Test anonymous mode (10 rpm)
npm run test:rate-limit:app   # Test app-only mode (60 rpm)
npm run test:rate-limit:auth  # Test authenticated mode (100 rpm)

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

- 🐛 [Report bugs](https://github.com/karanb192/reddit-mcp-buddy/issues)
- 💡 [Request features](https://github.com/karanb192/reddit-mcp-buddy/issues)
- ⭐ [Star on GitHub](https://github.com/karanb192/reddit-mcp-buddy)

## 🔗 Related Resources

### Official MCP Resources
- **[MCP Registry](https://registry.modelcontextprotocol.io)** - Official registry of MCP servers
- **[MCP Specification](https://modelcontextprotocol.io/specification/latest)** - Official Model Context Protocol specification
- **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)** - SDK used to build this server
- **[MCP Servers Repository](https://github.com/modelcontextprotocol/servers)** - Collection of official MCP server implementations
- **[Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers)** - Community-curated list of MCP servers

### Where to Find This Server
- **[MCP Registry API Link](https://registry.modelcontextprotocol.io/v0/servers?search=reddit-mcp-buddy)** - Direct API query for this server
- **[MCP Registry Search](https://registry.modelcontextprotocol.io)** - Search for "reddit" to find all versions
- **[NPM Package](https://www.npmjs.com/package/reddit-mcp-buddy)** - Install via npm/npx
- **[GitHub Repository](https://github.com/karanb192/reddit-mcp-buddy)** - Source code and issues

#### View All Versions via API
```bash
# Get all versions of reddit-mcp-buddy from the registry
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=reddit-mcp-buddy" | jq

# Get just names, version numbers, and latest flag
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=reddit-mcp-buddy" | \
  jq '.servers[] | {name: .server.name, version: .server.version, isLatest: ._meta."io.modelcontextprotocol.registry/official".isLatest}'
```

## License

MIT - Use it however you want!

---

Made with ❤️ for the MCP community. No venture capital, no tracking, just a good MCP server.

Built by [Karan Bansal](https://karanbansal.in) (Head of AI at ArmorCode). I write about Claude Code, MCP, and production agentic AI at [karanbansal.in/blog](https://karanbansal.in/blog/).
