@AGENTS.md

## Claude Code specifics

- The project instructions above (AGENTS.md) are authoritative. Maintainer-only notes (local folders, tool setup,
  memory) live in the gitignored `CLAUDE.local.md`, which Claude Code loads automatically when it exists.
- GMI MCP server (tools `mcp__gmi__*`, OAuth): `claude mcp add --transport http gmi https://mcp.gmicloud.ai/mcp`, then
  authenticate via `/mcp`. The browser consent is an OAuth registration/authorization with GMI, so only the human does
  it (ground rule 2). Without the tools, use the public GETs. When available, use the read-only tools freely for
  fixtures and API checks; ask before `submit_generation`, `upload_media`, `create_support_request`.
- Look at screenshots with the Read tool (PNG). `node scripts/screenshots.mjs` is the visual test loop.
- For multi-agent work, the pattern that worked: (1) foundation + contracts by one agent, (2) parallel slice agents
  with strict file ownership, (3) multi-lens adversarial review + per-area verifiers, (4) parallel fixers by area,
  (5) integrator runs `npm run check` and screenshots.
