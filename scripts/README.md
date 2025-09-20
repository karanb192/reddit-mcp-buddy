# Reddit MCP Buddy - Development Scripts

This folder contains development and testing scripts for contributors to validate and troubleshoot the three-tier authentication system.

## Quick Start

1. **Copy the example environment file:**
   ```bash
   cp scripts/.env.example scripts/.env
   ```

2. **Edit `.env` with your Reddit credentials:**
   ```bash
   # Edit scripts/.env and add your credentials
   REDDIT_CLIENT_ID=your_client_id
   REDDIT_CLIENT_SECRET=your_client_secret
   REDDIT_USERNAME=your_username      # Optional for 100 rpm
   REDDIT_PASSWORD=your_password      # Optional for 100 rpm
   ```

3. **Test your rate limits:**
   ```bash
   npm run test:rate-limit             # Test with your credentials
   npm run test:rate-limit:anon        # Test anonymous (10 rpm)
   npm run test:rate-limit:app         # Test app-only (60 rpm)
   npm run test:rate-limit:auth        # Test authenticated (100 rpm)
   ```

## Available Scripts

### rate-limit-tester.cjs

Interactive rate limit testing tool that verifies the three-tier rate limiting system:
- **Anonymous**: 10 requests/minute (no credentials required)
- **App-only**: 60 requests/minute (Client ID + Secret only)
- **Authenticated**: 100 requests/minute (all 4 credentials required)

The tool automatically loads credentials from:
1. `scripts/.env` file (if exists)
2. Environment variables

#### Usage

```bash
# Test with your credentials (from .env or environment)
node scripts/rate-limit-tester.cjs

# Test specific modes
node scripts/rate-limit-tester.cjs anonymous 15    # Test 15 requests in anonymous mode
node scripts/rate-limit-tester.cjs app-only 70     # Test 70 requests in app-only mode
node scripts/rate-limit-tester.cjs auth 120        # Test 120 requests in authenticated mode

# Or use npm scripts
npm run test:rate-limit         # Current environment
npm run test:rate-limit:anon    # Anonymous (15 requests)
npm run test:rate-limit:app     # App-only (70 requests)
npm run test:rate-limit:auth    # Authenticated (120 requests)
```

#### Features

- Real-time progress bar with color-coded output
- Automatic server startup and shutdown
- Detailed rate limit analysis
- Response time tracking
- Clear success/failure indicators

#### Environment Variables

The script respects these environment variables when testing:

```bash
export REDDIT_CLIENT_ID="your_client_id"
export REDDIT_CLIENT_SECRET="your_client_secret"
export REDDIT_USERNAME="your_username"      # For authenticated mode
export REDDIT_PASSWORD="your_password"      # For authenticated mode
```

#### Port Configuration

The test script uses port 3002 by default. If this port is in use, you can modify the `REDDIT_BUDDY_PORT` value in the script.

## Security Best Practices

⚠️ **NEVER commit credentials!**
- Use the `.env` file for local credentials (automatically gitignored)
- Copy `.env.example` to `.env` and fill in your values
- The `.env` file is in `.gitignore` and won't be committed
- Never hardcode credentials directly in scripts
- If creating custom test scripts with credentials, add them to scripts/.gitignore

## Contributing

When adding new scripts:
1. Use `.cjs` extension for CommonJS scripts (due to package.json "type": "module")
2. Add documentation to this README
3. Consider adding npm scripts in package.json for common operations
4. Include clear error messages and usage instructions
5. Test thoroughly with all three authentication tiers
6. Never commit scripts with hardcoded credentials