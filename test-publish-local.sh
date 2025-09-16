#!/bin/bash

# Local test script for publishing pipeline
# This simulates what the CI will do without actually publishing

set -e  # Exit on error

echo "🧪 Testing Publishing Pipeline Locally"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test function
test_step() {
    echo -n "  $1... "
}

pass() {
    echo -e "${GREEN}✅${NC}"
}

fail() {
    echo -e "${RED}❌${NC}"
    echo "  Error: $1"
    exit 1
}

echo "📦 1. Checking package configuration"
echo "------------------------------------"

test_step "Checking package.json"
if [ -f "package.json" ]; then
    pass
else
    fail "package.json not found"
fi

test_step "Validating package.json fields"
node -e "
const pkg = require('./package.json');
if (!pkg.name) throw new Error('Missing package name');
if (!pkg.version) throw new Error('Missing package version');
if (!pkg.mcpName) throw new Error('Missing mcpName field');
if (pkg.mcpName !== 'io.github.karanb192/reddit-buddy-mcp') {
  throw new Error('Invalid mcpName: ' + pkg.mcpName);
}
" 2>/dev/null && pass || fail "Invalid package.json"

test_step "Checking server.json"
if [ -f "server.json" ]; then
    pass
else
    fail "server.json not found"
fi

test_step "Validating server.json"
node -e "
const fs = require('fs');
const server = JSON.parse(fs.readFileSync('./server.json', 'utf8'));
const required = ['name', 'version', 'description', 'deployment'];
for (const field of required) {
  if (!server[field]) throw new Error('Missing field: ' + field);
}
" 2>/dev/null && pass || fail "Invalid server.json"

echo ""
echo "🔨 2. Building the project"
echo "-------------------------"

test_step "Installing dependencies"
npm ci > /dev/null 2>&1 && pass || fail "npm ci failed"

test_step "Running build"
npm run build > /dev/null 2>&1 && pass || fail "Build failed"

test_step "Checking dist directory"
if [ -d "dist" ]; then
    pass
else
    fail "dist directory not created"
fi

test_step "Checking CLI executable"
if [ -f "dist/cli.js" ]; then
    pass
else
    fail "dist/cli.js not found"
fi

echo ""
echo "📝 3. Testing NPM publish (dry run)"
echo "----------------------------------"

test_step "Running npm publish --dry-run"
npm publish --dry-run --access public > /tmp/npm-dry-run.log 2>&1
if [ $? -eq 0 ]; then
    pass
    echo "  Package size: $(grep 'package size:' /tmp/npm-dry-run.log | cut -d: -f2 || echo 'unknown')"
    echo "  Files included: $(grep 'files:' /tmp/npm-dry-run.log | cut -d: -f2 || echo 'unknown')"
else
    fail "npm publish dry run failed (this is normal if not logged in)"
fi

echo ""
echo "🔧 4. Checking MCP Publisher"
echo "---------------------------"

test_step "Checking if MCP Publisher is installed"
if command -v mcp-publisher &> /dev/null; then
    pass
    echo "  Version: $(mcp-publisher --version 2>/dev/null || echo 'version command not available')"
else
    echo -e "${RED}❌${NC}"
    echo "  MCP Publisher not installed globally"
    echo "  Install with: npm install -g @modelcontextprotocol/mcp-publisher"
fi

echo ""
echo "📊 5. Version Consistency Check"
echo "------------------------------"

PACKAGE_VERSION=$(node -e "console.log(require('./package.json').version)")
SERVER_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('./server.json', 'utf8')).version)")
CODE_VERSION=$(grep "SERVER_VERSION = " src/mcp-server.ts | cut -d"'" -f2)

test_step "Checking version consistency"
if [ "$PACKAGE_VERSION" = "$SERVER_VERSION" ] && [ "$PACKAGE_VERSION" = "$CODE_VERSION" ]; then
    pass
    echo "  Version: $PACKAGE_VERSION"
else
    fail "Version mismatch: package.json=$PACKAGE_VERSION, server.json=$SERVER_VERSION, code=$CODE_VERSION"
fi

echo ""
echo "=================================="
echo "🎉 All tests passed!"
echo ""
echo "📋 Checklist for actual publishing:"
echo "  1. ✅ All tests pass"
echo "  2. ⚠️  Add NPM_TOKEN to GitHub Secrets"
echo "  3. ⚠️  Update version in all 3 places"
echo "  4. ⚠️  Create and push a version tag:"
echo "       git tag v$PACKAGE_VERSION"
echo "       git push origin v$PACKAGE_VERSION"
echo ""
echo "💡 To test the GitHub workflow without publishing:"
echo "   Push this test workflow and manually trigger it from GitHub Actions"