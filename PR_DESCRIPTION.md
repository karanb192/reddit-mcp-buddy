## 🚀 Version 1.1.0 - Major Update

This PR includes critical authentication fixes and a complete package rename for better SEO and discoverability.

## 🔧 Authentication System Fix

### Problem
- Environment variables were being ignored
- Authentication wasn't working as documented
- Rate limiting was stuck at 10 req/min even with credentials

### Solution
Implemented proper three-tier authentication system:
- **Anonymous Mode** (10 req/min): No credentials needed
- **App-Only Mode** (60 req/min): Client ID + Secret only
- **Authenticated Mode** (100 req/min): All 4 credentials including username/password

### Changes
- ✅ Added `loadFromEnv()` method to read credentials from environment
- ✅ Fixed OAuth flow for Reddit script apps (password grant type)
- ✅ Proper rate limit detection based on auth level
- ✅ Clear error messages indicating auth mode
- ✅ Updated documentation with correct setup instructions

## 📦 Package Rename: `reddit-mcp-buddy`

### Rationale
- **Better SEO**: Users search for "reddit mcp" - now we match
- **Unscoped Package**: Simpler installation (`npm install reddit-mcp-buddy`)
- **Brand Differentiation**: "buddy" suffix adds personality vs technical competitors

### Before → After
- Package: `@karanb192/reddit-buddy-mcp` → `reddit-mcp-buddy`
- GitHub: `reddit-buddy-mcp` → `reddit-mcp-buddy`
- MCP Registry: `io.github.karanb192/reddit-buddy-mcp` → `io.github.karanb192/reddit-mcp-buddy`
- Command: `reddit-buddy` → `reddit-mcp-buddy`

## 📝 Complete Change List

### Core Functionality
- ✅ Fixed environment variable authentication
- ✅ Implemented OAuth password grant for script apps
- ✅ Added proper rate limiting (10/60/100 req/min)
- ✅ Fixed cache TTL based on auth level
- ✅ Added auth mode detection and reporting

### Package Updates
- ✅ Renamed to unscoped `reddit-mcp-buddy` package
- ✅ Updated all documentation references
- ✅ Fixed all command references
- ✅ Updated GitHub repository URLs
- ✅ Updated MCP registry configuration

### Documentation
- ✅ Updated README with correct auth setup
- ✅ Added clear rate limit table
- ✅ Moved interactive auth to testing section
- ✅ Added warning that interactive auth doesn't work with Claude Desktop
- ✅ Updated all "Reddit Buddy MCP" → "Reddit MCP Buddy"

### CI/CD
- ✅ Updated GitHub Actions for unscoped package
- ✅ Fixed MCP registry publishing
- ✅ Added `.mcpregistry_*` to gitignore

### Testing
- ✅ Created rate limit test scripts (not committed)
- ✅ Verified all three auth modes work correctly
- ✅ Build and typecheck pass

## 🧪 Testing Instructions

1. **Test Anonymous Mode**:
```bash
# Clear all env vars
unset REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD
npm run build && npm start
# Should show: "Mode: Anonymous (10 req/min)"
```

2. **Test App-Only Mode**:
```bash
export REDDIT_CLIENT_ID="your_id"
export REDDIT_CLIENT_SECRET="your_secret"
unset REDDIT_USERNAME REDDIT_PASSWORD
npm run build && npm start
# Should show: "Mode: App-only (60 req/min)"
```

3. **Test Authenticated Mode**:
```bash
export REDDIT_CLIENT_ID="your_id"
export REDDIT_CLIENT_SECRET="your_secret"
export REDDIT_USERNAME="your_username"
export REDDIT_PASSWORD="your_password"
npm run build && npm start
# Should show: "Mode: Authenticated (100 req/min)"
```

## 🚢 Release Plan

1. Merge this PR to main
2. Create tag `v1.1.0`
3. GitHub Actions will automatically:
   - Publish to NPM as `reddit-mcp-buddy`
   - Publish to MCP Registry
   - Verify publication

## 📊 Impact

- **10x more requests** for authenticated users
- **Simpler installation** with unscoped package
- **Better discoverability** with improved naming
- **Clear documentation** on authentication setup
- **Proper error messages** for troubleshooting

## Breaking Changes

⚠️ Package name change requires users to update:
- `npm uninstall @karanb192/reddit-buddy-mcp`
- `npm install reddit-mcp-buddy`
- Update Claude Desktop config to use `reddit-mcp-buddy`

---

Fixes #3 (authentication issues)