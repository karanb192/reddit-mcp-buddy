# <img src="assets/reddit-mcp-buddy-icon-white-background.png" width="48" align="center"/> Reddit MCP Buddy

### Reddit Browser for Claude Desktop and AI Assistants

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets an AI assistant browse Reddit, search posts, read comment threads, find subreddits, and look at a user's activity through Reddit's own API. Posting and commenting are opt-in. See [Posting](#posting-v120).

> **You need Reddit API credentials that Reddit has already approved.** Reddit is closing the access this server uses, and there is no way to get new credentials for it.
>
> - **2026-10-31:** Reddit stopped accepting new requests for public API access ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)).
> - **2026-11-13:** the date Reddit set for ending RSS feed support ([changelog, October 8, 2026](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026)). RSS was the only thing this server could read without credentials, so every Reddit tool now needs them.
> - **2027-01-12:** Reddit starts closing API access for apps whose owners have not registered them at [developers.reddit.com/app-registration](https://developers.reddit.com/app-registration) or answered Reddit's outreach ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)).
> - **March 2027:** Reddit ends the remaining public API access ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)).
>
> This project cannot grant API access or register your app for you.

[![npm version](https://img.shields.io/npm/v/reddit-mcp-buddy.svg)](https://www.npmjs.com/package/reddit-mcp-buddy)
[![npm downloads](https://img.shields.io/npm/dm/reddit-mcp-buddy.svg)](https://www.npmjs.com/package/reddit-mcp-buddy)
[![GitHub stars](https://img.shields.io/github/stars/karanb192/reddit-mcp-buddy.svg?style=flat&logo=github&color=brightgreen)](https://github.com/karanb192/reddit-mcp-buddy/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## See It In Action

![Reddit MCP Buddy Demo - AirPods Max 2 and Dune Part Three](assets/images/reddit-mcp-buddy-demo-2026.gif)

*Claude checking Reddit's reaction to the Dune Part Three trailer and whether the AirPods Max 2 are worth $549*

![Reddit MCP Buddy Demo - Analyzing H1B sentiment across subreddits](assets/images/reddit-mcp-buddy.gif)

*Claude analyzing real-time sentiment about H-1B visa changes across r/cscareerquestions and r/india*

## Table of Contents

- [Quick Start](#quick-start)
- [What you can ask](#what-you-can-ask)
- [Available Tools](#available-tools)
- [NSFW content](#nsfw-content)
- [Authentication](#authentication)
- [Posting (v1.2.0)](#posting-v120)
- [Settings](#settings)
- [Privacy & Data Handling](#privacy--data-handling)
- [Other ways to install](#other-ways-to-install)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Support](#support)
- [Related Resources](#related-resources)

## Quick Start

You need your approved Reddit app's client ID and secret. [Authentication](#authentication) shows where to find them.

### Claude Desktop extension

1. **Download**: [reddit-mcp-buddy.mcpb](https://github.com/karanb192/reddit-mcp-buddy/releases/latest/download/reddit-mcp-buddy.mcpb)
2. **Install**: Open the downloaded file
3. **Add credentials**: Enter the client ID and secret in the extension settings

### Claude Desktop with npm

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "reddit-mcp-buddy"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id",
        "REDDIT_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Claude Code

Run this command to add the MCP server (user scope):

```bash
claude mcp add --transport stdio reddit-mcp-buddy -s user \
  -e REDDIT_CLIENT_ID=your_client_id -e REDDIT_CLIENT_SECRET=your_client_secret \
  -- npx -y reddit-mcp-buddy
```

### Other MCP clients

Run `npx -y reddit-mcp-buddy` with `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` set in its environment.

A global install, a build from source and Docker are under [Other ways to install](#other-ways-to-install).

## What you can ask

| Ask your assistant | What it calls |
|--------------------|---------------|
| "What's trending on Reddit?" | `browse_subreddit` with subreddit `all`, sort `hot` |
| "Show me the top posts in r/technology this week" | `browse_subreddit` with sort `top`, time `week` |
| "What are the top posts about GPT-4 today?" | `search_reddit` with time `day`, sort `top` |
| "Get the comments from this Reddit post" | `get_post_details` with the post's URL |
| "Analyze user spez" | `user_analysis` |
| "Where do people discuss home espresso machines?" | `find_subreddits` with query `home espresso` and the names it thinks fit |
| "Explain Reddit karma" | `reddit_explain` |
| "Post this to r/test" | `subreddit_rules`, then `create_post` after you confirm (opt-in, see [Posting](#posting-v120)) |

What comes back:

- **Reddit's data and nothing else.** No sentiment scores or other invented metrics.
- **Only the fields an assistant needs**, not Reddit's full raw objects.
- **A note when something was left out.** Hidden NSFW items, subreddits that are private, quarantined or banned, and an author or flair filter applied after Reddit's own limit are all reported in the response.

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
- Include NSFW: off by default; posts left out are counted in nsfw_hidden
```

### `search_reddit`
Search across Reddit or specific subreddits.
```
- Query: Your search terms
- Filter by: subreddit, author, time, flair
- Sort by: relevance, hot, top, new, comments
- Include NSFW: off by default. Reddit leaves NSFW posts out before it answers, so a
  search inside an NSFW subreddit returns nothing unless this is on
```

### `get_post_details`
Get a post and its comments.
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
- Comments: 20 by default, up to 500
- Options: comment sorting, depth, link extraction
```

### `user_analysis`
Analyze a Reddit user's profile.
```
- Username: Any Reddit user
- Returns: karma, posts, comments, active subreddits
```

### `find_subreddits`
Find subreddits for a topic, and check subreddit names before using them.
```
- Query: 2 to 4 keywords, not a sentence (Reddit's subreddit search matches words)
- Candidates: up to 10 subreddit names the assistant thinks fit (optional)
- Include NSFW: off by default; subreddits left out are counted in nsfw_hidden
- Limit: how many Reddit search suggestions to return (default 10, max 50)
- Min subscribers: search suggestions below this are left out (default 1000);
  candidates are never filtered by size
- Returns: name, url, title, description, subscribers with an as-of time, NSFW flag, type,
  source (assistant or reddit_search), and whether it was confirmed to exist
- Candidates Reddit does not return are listed in not_found; if the name check itself
  fails, they come back unchecked instead
- Subreddits that exist but cannot be read (private, quarantined, banned) are listed
  in unavailable with the reason
- At most 2 Reddit requests per call
```

### `reddit_explain`
Get explanations of Reddit terms. Works offline, with no credentials.
```
- Terms: karma, cake day, AMA, ELI5, etc.
```

### Write tools (opt-in)

`create_post`, `add_comment`, and `subreddit_rules` only appear when you enable posting; read-only installs see exactly the six tools above. Details in [Posting (v1.2.0)](#posting-v120).

## NSFW content
NSFW posts and subreddits are left out by default. When you ask for them, the assistant can set `include_nsfw` on `browse_subreddit`, `search_reddit` or `find_subreddits` for that one call. To change the rule for the whole server, set `REDDIT_BUDDY_NSFW`:

| Value | What it does |
|-------|--------------|
| `ask` (default) | Hidden unless a call sets `include_nsfw: true` |
| `never` | Always hidden, whatever the assistant sends. `include_nsfw` has no effect, `get_post_details` refuses a post marked NSFW, and `user_analysis` leaves NSFW posts and comments out |
| `always` | Included unless a call sets `include_nsfw: false` |

```json
"env": {
  "REDDIT_CLIENT_ID": "your_client_id",
  "REDDIT_CLIENT_SECRET": "your_client_secret",
  "REDDIT_BUDDY_NSFW": "never"
}
```

- In `ask` and `always`, `get_post_details` and `user_analysis` are not filtered: you named the post or the user.
- Any other value is treated as `never` and logged at startup, so a typo cannot open what you meant to lock.
- The server goes by Reddit's own NSFW mark on each post and subreddit, and on the comments in a user's history. It does not inspect content, so something Reddit has marked as not NSFW is shown.
- Reddit puts no NSFW mark on the comments under a post, so the post's mark decides for them: `get_post_details` returns the comments of a post that is not marked NSFW as they are, on `never` too.
- On `never`, anything Reddit has not marked either way is left out as well, and `browse_subreddit` leaves out the subreddit info of an NSFW subreddit.
- Claude Desktop extension users: use the **NSFW content** field in the extension settings. It maps to the same variable.

## Authentication

Every tool that reads Reddit needs credentials for a Reddit app whose API access Reddit has already approved. Only `reddit_explain`, which works offline, runs without them.

### Who can use this server

- **You already hold approved Reddit API access:** use your app's credentials below.
- **You do not:** Reddit stopped accepting new requests for public API access on 2026-10-31 ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)), so there is no way to get credentials for this server now. This project cannot grant access, and it does not provide shared API keys or a third-party OAuth service.
- **Keep your access past 2027-01-12:** Reddit starts closing API access on that date for apps whose owners have not registered them at [developers.reddit.com/app-registration](https://developers.reddit.com/app-registration) or answered Reddit's outreach ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)). Registration is done by each app's owner; this project cannot do it for you.

Without credentials, every Reddit tool returns an error that says credentials are needed.

### Setup Steps

1. **Open** https://www.reddit.com/prefs/apps and select your approved app.
2. **Check the app type:** **"script"** supports password-grant authentication, **"web app"** supports OAuth consent with a refresh token (see below), and app-only mode works with both.
3. **Find your credentials:**
   - **Client ID**: The string beneath the app's name and type
   - **Client Secret**: The secret string
4. **Update your Claude Desktop config:**

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

An approved web app can authenticate a user without their Reddit password. `--oauth` runs Reddit's [authorization-code flow](https://github.com/reddit-archive/reddit/wiki/OAuth2#authorization) once and prints a refresh token.

1. **Register the redirect URI.** On [Reddit app preferences](https://www.reddit.com/prefs/apps), the web app's redirect URI must be a loopback address with a port, such as `http://localhost:8080`.
2. **Run the consent command** on the machine where your browser is signed in to Reddit:

   ```bash
   npx -y reddit-mcp-buddy --oauth
   ```

   It prompts for the web app's client ID and secret, or reads `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` from the environment. It requests `identity`, `read`, and `history`, which the read-only tools need. Add `--write` to also request `submit` and `flair` for [posting](#posting-v120). Pass `--redirect-uri http://localhost:<port>` if you registered a different port.
3. **Open the printed link and click Allow.** Reddit redirects back to a temporary local server that only listens on your machine. It checks the random `state` value, exchanges the one-time code, and confirms the account with `/api/v1/me`. It waits up to 5 minutes and never posts.
4. **Copy the token into your config.** It prints `REDDIT_REFRESH_TOKEN=...`. To keep it off the screen, add `--out ~/reddit-token.env`, a path outside any repository. If that file already exists, the command stops before asking for consent. If writing fails after consent, it prints the token instead. On macOS and Linux the file is readable only by you.

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

### Modes and local request caps

The server enforces these caps itself. They are not Reddit API quotas or guaranteed throughput.

| Mode | Credentials | Local cap |
|------|-------------|-----------|
| **App-only** | Client ID + secret | 60 requests/minute |
| **User** | Client ID + secret, plus a refresh token or username and password | 100 requests/minute |

- App-only mode uses the OAuth2 client credentials grant and works with both script and web apps.
- User mode uses a refresh token for an authorized web app, or the password grant for a script app.
- A refresh token carries the scopes granted during consent. Missing scopes can prevent individual tools from working.
- User mode raises this server's local cap. It does not grant a larger quota from Reddit.

## Posting (v1.2.0)

Since v1.2.0 the server can post for you. Three tools, all opt-in:

- **`create_post`** - Submit a text or link post to one subreddit. Checks mechanical rules (title limits, flair required, link vs text allowed) and supports `validate_only: true` as a dry run. Confirmation depends on the client's capabilities as described below.
- **`add_comment`** - Comment on a post or reply to a specific comment (by id or URL), with the same confirmation flow.
- **`subreddit_rules`** - Read-only. Fetches a sub's rules, posting requirements, capability flags, and flair choices in one cached call, so drafts fit the sub before anything is submitted.

The intended workflow: `subreddit_rules` first, then `create_post` with `validate_only: true`, review the full draft and options with the user, then submit the identical payload.

### Enabling posting

Add `REDDIT_BUDDY_WRITE` next to your existing credentials:

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
        "REDDIT_PASSWORD": "your_password",
        "REDDIT_BUDDY_WRITE": "true"
      }
    }
  }
}
```

Claude Desktop extension users: flip the **Enable posting tools** toggle in the extension settings instead. It maps to the same `REDDIT_BUDDY_WRITE` variable.

Alternatively, replace `REDDIT_PASSWORD` with `REDDIT_REFRESH_TOKEN` from the [web-app consent flow](#web-apps-with-oauth-consent); `npx -y reddit-mcp-buddy --oauth --write` requests the posting scopes. Posting requires the granted scopes `identity`, `read`, `submit`, and `flair`. Add `history` if you also use `user_analysis`. `REDDIT_USERNAME` is optional with a refresh token; when provided, it must match the account returned by Reddit.

Credentials must come from environment variables (or extension config fields, which become environment variables). The interactive `--auth` file setup does not enable posting. Startup verifies the account through Reddit and checks granted scopes. If any requirement is missing, the server logs the reason and keeps posting tools disabled.

### The safety model, in plain words

Posting uses your account. The server enforces registration, rate limits, and duplicate checks; human approval also depends on the client:

- **Off by default.** Without `REDDIT_BUDDY_WRITE`, the write tools do not exist: read-only installs see only the 6 read tools, and pay zero extra context.
- **stdio only.** The HTTP transport has no authentication, so write tools refuse to register there. No process on your machine or network can turn the HTTP endpoint into a posting proxy.
- **Confirmation depends on the client.** Clients supporting [MCP elicitation](https://modelcontextprotocol.io/specification/latest) get a confirmation prompt with the target, account, content preview, full content length, and post options. The prompt requires an explicit acceptance. Previews can be truncated, so review the full draft in your client first. Without elicitation, the server requires a preview or successful dry run followed by the identical payload within 15 minutes. It cannot verify that a human approved that repeat: approval depends on the client's tool prompt and the model following instructions. Only enable posting in a client whose approval behavior you trust.
- **Hourly caps you cannot raise.** At most 5 posts/hour, 30 comments/hour, and 15 seconds between writes, enforced in the server. Environment variables can tighten these, never loosen them. Honest limit: the caps live in the server process (a restart resets the hour, parallel sessions have separate caps, and a fork of this open-source code can remove them). They exist to make casual abuse pointless, not to stop a determined operator.
- **Duplicate suppression.** Retrying an identical submit within 15 minutes returns the original post instead of posting twice, including the same content re-drafted for the same sub. Posting the same content to a different subreddit is allowed, with a warning naming the earlier post.
- **Verified after submit.** Reddit happily returns "success" for posts AutoModerator removes seconds later. The server re-checks after submitting and reports `status: "filtered"` with a warning when that happens, instead of telling you it went live.
- **Conspicuous logging.** Every allowed write is logged to stderr with the kind, the target (subreddit when known), and the acting user.

### Know the trade-off before enabling

Reddit's password grant returns a token with **full account scope**. An OAuth refresh token carries the permissions granted during consent. These permissions apply across the account, not just one subreddit. With posting off, the server uses the credentials for reads; enabling posting lets it submit posts and comments. Keep passwords and refresh tokens out of version control and off shared machines.

Also worth knowing: Reddit applies its own account-level posting throttles on top of everything above, based on account age and karma. If Reddit says "try again in N minutes", the server surfaces the wait instead of hammering.

## Settings

### Environment variables

#### Authentication Variables
| Variable | Description | Required |
|----------|-------------|----------|
| `REDDIT_CLIENT_ID` | Reddit app client ID | Yes |
| `REDDIT_CLIENT_SECRET` | Reddit app secret | Yes |
| `REDDIT_USERNAME` | Reddit account username, with the password for a script app | No |
| `REDDIT_PASSWORD` | Reddit account password; leave unset when using a refresh token | No |
| `REDDIT_REFRESH_TOKEN` | OAuth refresh token for a web app | No |
| `REDDIT_USER_AGENT` | Custom user agent string | No |

Which credentials select which mode, and the local cap for each, are under [Modes and local request caps](#modes-and-local-request-caps).

#### Server Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `REDDIT_BUDDY_HTTP` | Run as HTTP server instead of stdio | `false` |
| `REDDIT_BUDDY_PORT` | HTTP server port (when HTTP=true) | `3000` |
| `REDDIT_BUDDY_HOST` | Interface the HTTP server binds to | `127.0.0.1` |
| `REDDIT_BUDDY_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the HTTP endpoint | none |
| `REDDIT_BUDDY_ALLOWED_HOSTS` | Comma-separated `host:port` values accepted in the Host header (DNS-rebinding protection) | loopback values when bound to localhost |
| `REDDIT_BUDDY_NO_CACHE` | Disable caching (always fetch fresh) | `false` |
| `REDDIT_BUDDY_NSFW` | [NSFW content](#nsfw-content): `ask` (hidden unless a call asks), `never` (always hidden) or `always` (included by default) | `ask` |

#### Posting (v1.2.0)
| Variable | Description | Default |
|----------|-------------|---------|
| `REDDIT_BUDDY_WRITE` | Register the [posting tools](#posting-v120); requires env user credentials, verified identity and scopes, and stdio | `false` |
| `REDDIT_BUDDY_MAX_POSTS_PER_HOUR` | Posts per hour; only values from 1 to 4 are honored (0 and invalid values are ignored) | `5` |
| `REDDIT_BUDDY_MAX_COMMENTS_PER_HOUR` | Comments per hour; only values from 1 to 29 are honored (0 and invalid values are ignored) | `30` |
| `REDDIT_BUDDY_MIN_WRITE_INTERVAL_S` | Seconds between writes; only values ABOVE 15 are honored | `15` |

The three rate-floor variables can only tighten the built-in caps. Setting them looser than the defaults does nothing, on purpose, and 0 does not mean "pause posting": it falls back to the default cap.

### HTTP mode

The server runs over stdio by default. To run it as a local HTTP server, for Postman MCP or direct API calls:

```bash
# Run in HTTP mode on port 3000
npx -y reddit-mcp-buddy --http

# Or with custom port
REDDIT_BUDDY_PORT=8080 npx -y reddit-mcp-buddy --http
```

> **HTTP mode has no authentication.** It binds to localhost so only your machine can reach it, and rejects Host headers outside the loopback set. Setting `REDDIT_BUDDY_HOST=0.0.0.0` exposes it to your whole network - only do that on a trusted network (e.g. inside Docker, which sets it deliberately). On a non-loopback bind the Host check is off by default, since clients legitimately arrive with a container IP or service name; set `REDDIT_BUDDY_ALLOWED_HOSTS` to restrict it. Browser requests are rejected unless their origin is listed in `REDDIT_BUDDY_ALLOWED_ORIGINS`; non-browser clients like Postman are unaffected.

### Caching

Reddit's responses are cached in memory to cut repeat requests.

| Content | Cached for |
|---------|------------|
| Subreddit listings | 5 minutes |
| Post details | 10 minutes |
| Search results | 10 minutes |
| User profiles | 15 minutes |

- The cache is capped at 50MB and evicts the least-used entries first.
- Everything is cleared when the server stops.
- Set `REDDIT_BUDDY_NO_CACHE=true` to turn it off.

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

`HTTP_PROXY` routes HTTP requests; `HTTPS_PROXY` routes HTTPS requests, including Reddit API calls. `NO_PROXY` excludes matching hosts. Export these variables in your shell for CLI use, or pass them with Docker's `-e` options. Set them in the process environment before startup; the server does not load a project `.env` file automatically.

Inside Docker, `localhost` refers to the container. On Docker Desktop, use `host.docker.internal` to reach a proxy running on the host.

Proxy authentication can be included in the proxy URL as `http://username:password@proxy.example.com:8080`. Treat that value as a credential and redact it from shared logs and configuration. For a network that uses a private certificate authority, use `NODE_EXTRA_CA_CERTS` with your organization's PEM certificate file instead of disabling TLS verification.

See [Node's proxy and certificate configuration guide](https://nodejs.org/learn/http/enterprise-network-configuration). Proxy support routes network traffic; it does not grant Reddit API approval or bypass Reddit's access rules.

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
  - Reddit API responses are cached in memory only and cleared when the server stops (see [Caching](#caching))

### Data Transmission
- **Reddit API Only**: Your credentials are only sent to Reddit's official OAuth endpoints (`https://oauth.reddit.com` and `https://www.reddit.com`)
- **No External Services**: No data is sent to any other external services, analytics platforms, or third parties
- **Local Processing**: All data processing happens locally on your machine

### Security Notes
- **Read-Only by Default**: Posting requires explicit opt-in. Review the [client-dependent confirmation flow](#the-safety-model-in-plain-words) before enabling it.
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

## Other ways to install

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
docker run -it -e REDDIT_CLIENT_ID=your_client_id -e REDDIT_CLIENT_SECRET=your_client_secret reddit-mcp-buddy
```

Run the container smoke test with Docker, curl, and jq installed:

```bash
bash tests/test-docker.sh reddit-mcp-buddy
```

The test checks container health, MCP initialization, tool discovery, and shutdown without Reddit credentials.

### Build the Claude Desktop extension from source

The pre-built extension is in [Quick Start](#quick-start). To build it yourself:
```bash
git clone https://github.com/karanb192/reddit-mcp-buddy.git
cd reddit-mcp-buddy
./scripts/build-mcpb.sh
```

## Troubleshooting

### Common Issues

**"Reddit ended logged-out RSS access on 2026-11-13"**
- The server has no credentials, and it reads nothing from Reddit without them. Reddit set 2026-11-13 as the end of its RSS feeds ([changelog](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026)), which were the only logged-out route. The subreddit, post, or user you asked for is not the problem
- Add your approved app's credentials (see [Authentication](#authentication)). Reddit stopped accepting new API access requests on 2026-10-31, so this only helps people who already hold access

**"Cannot create an app" or "API approval required"**
- Reddit stopped accepting new requests for public API access on 2026-10-31 ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)); this project cannot approve an app or remove Reddit's restrictions
- Use credentials only for an app and use case Reddit has approved

**"Command not found" error**
```bash
# Ensure npm is installed
node --version
npm --version

# Try the full global-bin path
$(npm prefix -g)/bin/reddit-mcp-buddy
```

**Rate limit errors, or fewer requests per minute than the cap**
- The caps under [Modes and local request caps](#modes-and-local-request-caps) are this server's own. Reddit applies its own API limits on top, and user credentials do not raise them
- The server retries transient failures, but sustained throttling can still fail
- If an error says `Retry in Ns`, wait that long before retrying. The server returns long upstream waits immediately instead of sleeping through the client's request timeout.

**Write tools don't show up**
- All of these must hold: `REDDIT_BUDDY_WRITE=true`, client credentials plus a refresh token or username/password via environment variables, stdio transport, a verified user identity, and granted `identity`/`read`/`submit`/`flair` scopes
- The startup log (stderr) names exactly which condition failed
- `--auth` file setups cannot write: the password is never saved, so restarts fall back to app-only tokens. Move credentials into your MCP client config's `env` block
- HTTP mode never registers write tools, by design (the HTTP endpoint has no authentication)

**"Subreddit not found"**
- Ask the assistant to check the name with `find_subreddits`. It lists names Reddit does not know in `not_found` and names that are private, quarantined or banned in `unavailable`
- Subreddit names are not case-sensitive

**Connection issues**
- Reddit may be down (check https://www.redditstatus.com)
- Firewall blocking requests
- Try restarting the MCP server

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

# Type check
npm run typecheck
```

Rate-limit checks, local credential setup with `--auth`, and the private sandbox posting test are in [CONTRIBUTING.md](CONTRIBUTING.md#-testing).

### Requirements
- Node.js >= 20.0.0
- npm
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

## Related Resources

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

## License

MIT - Use it however you want!

---

Made with ❤️ for the MCP community. No venture capital, no tracking, just a good MCP server.

Built by [Karan Bansal](https://karanbansal.in) (Head of AI at ArmorCode). I write about Claude Code, MCP, and production agentic AI at [karanbansal.in/blog](https://karanbansal.in/blog/).
