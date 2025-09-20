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
   # For higher rate limits (60-100 req/min instead of 10)
   export REDDIT_CLIENT_ID="your_client_id"
   export REDDIT_CLIENT_SECRET="your_client_secret"
   export REDDIT_USERNAME="your_username"  # Optional, for 100 req/min
   export REDDIT_PASSWORD="your_password"  # Optional, for 100 req/min
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
npm run lint          # Run ESLint

# Testing
npm run test:rate-limit         # Test rate limiting
npm run test:rate-limit:anon    # Test anonymous mode (10 req/min)
npm run test:rate-limit:app     # Test app-only mode (60 req/min)
npm run test:rate-limit:auth    # Test authenticated mode (100 req/min)

# Run server modes
npm start             # Run in stdio mode (for Claude Desktop)
npm run start:http    # Run in HTTP mode (for web clients)
```

## 🧪 Testing

### Rate Limit Testing

Test the three-tier rate limiting system:

```bash
# Test current environment settings
node scripts/rate-limit-tester.cjs

# Test specific modes with custom request counts
node scripts/rate-limit-tester.cjs anonymous 15    # Test 15 requests in anonymous mode
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

## 🔑 Authentication Setup

### Creating a Reddit App

1. Go to https://www.reddit.com/prefs/apps
2. Click "Create App" or "Create Another App"
3. Fill in the form:
   - Name: `reddit-mcp-buddy-dev`
   - App type: Select **"script"**
   - Description: `Development instance of Reddit MCP Buddy`
   - About URL: (leave blank)
   - Redirect URI: `http://localhost:8080` (required but not used)
4. Click "Create app"
5. Note your credentials:
   - Client ID: The string under "personal use script"
   - Client Secret: The secret string

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