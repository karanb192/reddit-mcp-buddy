# Contributing to Reddit MCP Buddy

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/reddit-mcp-buddy.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run locally: `./deploy-server.sh` (for development/testing)

## Making Changes

1. Create a feature branch: `git checkout -b feature/your-feature-name`
2. Make your changes
3. Test locally with `./deploy-server.sh`
4. Commit with clear messages
5. Push and create a Pull Request

## Development Scripts

- `npm run build` - Compile TypeScript
- `npm run dev` - Watch mode for development
- `./deploy-server.sh` - Run server locally (port 35000)
- `./deploy-server.sh --mode docker` - Test Docker deployment
- `./deploy-server.sh --terminate` - Stop running server

## Pull Request Guidelines

- Keep changes focused and atomic
- Update README.md if adding new features
- Test with both authenticated and anonymous modes
- Ensure TypeScript builds without errors

## Ideas for Contribution

- Add more Reddit API endpoints
- Improve error handling
- Add retry logic for failed requests
- Optimize caching strategies
- Add support for Reddit OAuth
- Improve TypeScript types

## Questions?

Open an issue for discussion before making large changes.