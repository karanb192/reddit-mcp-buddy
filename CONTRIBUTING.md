# Contributing to Reddit MCP Buddy

Thank you for your interest in contributing to Reddit MCP Buddy! This guide will help you get started with development.

## 🚀 Quick Start

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/[your-username]/reddit-mcp-buddy.git
   cd reddit-mcp-buddy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up authentication (optional)**
   ```bash
   # With approved API access, local caps are 60-100 req/min instead of 10
   export REDDIT_CLIENT_ID="your_client_id"
   export REDDIT_CLIENT_SECRET="your_client_secret"
   export REDDIT_USERNAME="your_username"  # Optional, for a local cap of 100 req/min
   export REDDIT_PASSWORD="your_password"  # Optional, for a local cap of 100 req/min
   ```

4. **Run in development mode**
   ```bash
   npm run dev
   ```

## 📁 Project Structure

```
reddit-mcp-buddy/
├── src/                  # Source code
│   ├── index.ts         # Entry point
│   ├── mcp-server.ts    # MCP server implementation
│   ├── core/            # Core utilities (auth, cache, rate-limiter)
│   ├── services/        # Reddit API client
│   ├── tools/           # MCP tool implementations
│   └── types/           # TypeScript types
├── scripts/             # Development scripts
│   └── rate-limit-tester.cjs # Rate limit testing tool
├── dist/                # Built JavaScript (generated)
├── CLAUDE.md           # AI assistant documentation
└── CONTRIBUTING.md     # This file
```

## 🛠️ Development Commands

```bash
# Development
npm run dev           # Run with hot reload
npm run build         # Build TypeScript
npm run typecheck     # Type checking

# Testing
npm run test:rate-limit         # Test rate limiting
npm run test:rate-limit:app     # Test app-only mode (60 req/min)
npm run test:rate-limit:auth    # Test authenticated mode (100 req/min)

# Run server modes
npm start             # Run in stdio mode (for Claude Desktop)
npm run start:http    # Run in HTTP mode (for web clients)
```

## 🧪 Testing

### Rate Limit Testing

Test the app-only and authenticated rate limits:

```bash
# Test current environment settings
node scripts/rate-limit-tester.cjs

# Test specific modes with custom request counts
node scripts/rate-limit-tester.cjs app-only 70     # Test 70 requests in app-only mode
node scripts/rate-limit-tester.cjs auth 120        # Test 120 requests in authenticated mode
```

### Manual Testing

1. **Test with Claude Desktop**
   ```bash
   npm run build
   npm start
   ```

2. **Test with HTTP client**
   ```bash
   npm run build
   npm run start:http
   # Server runs at http://localhost:3000/mcp
   ```

3. **Test individual tools**
   ```bash
   # Use Postman or curl to test the MCP endpoint
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

### Private sandbox posting test

Build the checkout, then print the proposed test without making any requests:

```bash
npm run build
REDDIT_TEST_SUBREDDIT=your_private_sub node tests/live-write.mjs
```

The live run requires an approved app, `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, plus either `REDDIT_REFRESH_TOKEN` or the script-app `REDDIT_USERNAME`/`REDDIT_PASSWORD` pair. The account must moderate the private test subreddit. OAuth validation requires all six scopes: `identity`, `read`, `submit`, `flair`, `history` for recovery, and `edit` for cleanup. The harness checks these before connecting any posting client. Keep credentials outside the repository. On Node versions supporting `--env-file`, a local environment file can supply them:

```bash
RUN_WRITE_TESTS=1 REDDIT_TEST_SUBREDDIT=your_private_sub \
  node --env-file=/path/to/private.env tests/live-write.mjs --run
```

This command performs real writes. It starts actual stdio MCP connections, declines one post request, accepts one test post, and tests comment preview followed by an identical submission from a client without elicitation. The harness supplies the confirmation responses automatically; running it authorizes these test actions. It creates one post and one comment, verifies their content, then attempts deletion of both even after a failure.

The unique marker and any cleanup failures are printed for manual inspection. Lost responses trigger a search of the test user's newest posts and comments; an unresolved outcome or unverified deletion fails the run. Cleanup cannot be guaranteed if the process is killed or Reddit is unavailable. Ordinary unit tests use an offline API fixture, and normal integration runs skip posting unless explicitly enabled.

## 🔑 Authentication Setup

### Using your Reddit app

Live testing needs a Reddit app whose API access Reddit has already approved. Reddit stopped accepting new requests for public API access on 2026-10-31 ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/)), and it set 2026-11-13 as the end of RSS support ([changelog](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026)), so the server reads nothing from Reddit without credentials. Offline unit tests (`npm test`) need no credentials.

1. Go to https://www.reddit.com/prefs/apps and open your approved app
2. Note your credentials:
   - Client ID: The string under the app's name and type
   - Client Secret: The secret string
3. To keep API access past 2027-01-12, the app's owner registers it at https://developers.reddit.com/app-registration ([migration post](https://www.reddit.com/r/redditdev/comments/1wubcvf/moving_data_api_apps_to_the_developer_platform/))

### Interactive Authentication Setup (for local testing only)

For local development and testing, you can set up authentication interactively:
```bash
npx -y reddit-mcp-buddy --auth
```

This will prompt you for Reddit app credentials and save them locally. **Note: This does NOT work with Claude Desktop** - use environment variables in your Claude config instead.

## 📝 Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Run `npm run typecheck` before committing
- Add JSDoc comments for public APIs
- Keep functions focused and small
- Use descriptive variable names

## 🎯 Making Contributions

### Types of Contributions

- **Bug fixes**: Fix issues reported in GitHub Issues
- **Features**: Add new Reddit tools or enhance existing ones
- **Documentation**: Improve README, add examples, fix typos
- **Tests**: Add test coverage
- **Performance**: Optimize caching, rate limiting, or API calls

### Contribution Process

1. **Check existing issues** or create a new one
2. **Fork** the repository
3. **Create a feature branch**: `git checkout -b feature/your-feature`
4. **Make your changes** following code style
5. **Test thoroughly** including rate limits
6. **Commit** with clear messages
7. **Push** to your fork
8. **Open a Pull Request** with description

**Important**: Never push directly to main. Always create a Pull Request for code review.

### Commit Message Format

```
type: description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Test additions/changes
- `chore`: Build process or auxiliary tool changes

Examples:
```
feat: add trending subreddits tool
fix: handle private subreddit errors gracefully
docs: update authentication setup instructions
```

## 🐛 Debugging

### Enable Debug Logging

```bash
# Set debug environment variable
DEBUG=reddit-mcp-buddy:* npm run dev
```

### Common Issues

1. **Rate limiting during development**
   - Use authentication for higher limits
   - Disable cache: `export REDDIT_BUDDY_NO_CACHE=true`

2. **Authentication failures**
   - Verify Reddit app type is "script"
   - Check credentials are correctly set
   - Ensure username/password are for the same Reddit account

3. **TypeScript errors**
   - Run `npm run typecheck` to see all errors
   - Check `tsconfig.json` settings

## 📦 Publishing Process

**Note**: Only maintainers can publish new versions.

1. Update version in:
   - `package.json`
   - `server.json`
   - `src/mcp-server.ts` (SERVER_VERSION)

2. Create and push tag:
   ```bash
   git tag v1.x.x
   git push origin main
   git push origin v1.x.x
   ```

3. GitHub Actions automatically:
   - Publishes to NPM
   - Publishes to MCP Registry

## 🤝 Getting Help

- **Discord**: Join the MCP Discord server
- **Issues**: Open a GitHub issue
- **Discussions**: Use GitHub Discussions for questions

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Thank You!

Your contributions make Reddit MCP Buddy better for everyone. We appreciate your time and effort!
