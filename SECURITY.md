# Security Policy

## Supported Versions

Only the latest published version receives security fixes.

| Version | Supported |
|---------|-----------|
| 1.1.x (latest) | ✅ |
| < 1.1.0 | ❌ |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub Private Vulnerability Reporting](https://github.com/karanb192/reddit-mcp-buddy/security/advisories/new) to report security issues privately. This keeps the details confidential until a fix is released.

You can expect:
- Acknowledgement within 48 hours
- A fix or mitigation within 7 days for critical issues
- Credit in the release notes if you'd like

## Known Security Considerations

**HTTP mode has no authentication.** When running with `REDDIT_BUDDY_HTTP=true`, the MCP server accepts requests from any client on the interface it binds with no auth. It therefore binds `127.0.0.1` by default, and rejects browser requests whose `Origin` is not listed in `REDDIT_BUDDY_ALLOWED_ORIGINS`. Setting `REDDIT_BUDDY_HOST` to another interface (as the Docker image does) exposes an unauthenticated server to that network - only do so on a network you trust, and never on a public one.

**Reddit credentials** (client ID, secret, password) should be passed via environment variables, not committed to config files.
