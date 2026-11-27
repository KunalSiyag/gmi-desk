# Contributing

Thanks for helping. GMI Desk is a small project; issues and focused pull requests are both welcome.

## Setup

Node 22.12+ and git.

```bash
npm install
npm run dev:mock   # demo data: no GMI account, nothing billed
```

Use `npm run dev:mock` (or `npm run start:mock` after a build) for your own checks. `npm run dev` and `npm start`
use your real GMI account and profile.

## Before you open a pull request

- `npm run check` passes (typecheck of 3 projects, the vitest suite, the production build).
- UI changes: screenshots in both themes, for example
  `node scripts/screenshots.mjs --name my-change --pages "models,models#light"` (PNGs land in
  `.agent-builds/my-change/shots/`). Attach the relevant ones to the PR.
- New behaviour has a test; a bug fix has a regression test.
- Contracts in `src/shared/contracts/` change additively, or every caller is updated in the same PR.

## Ground rules

- **No secrets, no personal data** in code, fixtures, tests, logs or screenshots. Fixtures are sanitised: organisation
  ids become `00000000-0000-0000-0000-000000000000`, balances are fake, and real media output URLs (public GCS URLs
  that contain an organisation id) never go in.
- **Nothing that costs money in tests.** Tests and mock mode never call paid GMI endpoints. Public GETs need a
  descriptive User-Agent (never a browser one).
- The renderer never touches the network or a secret; that stays in the main process.
- Motion follows the kit (`src/renderer/components/ui/motion.ts`): only occasional UI animates, `opacity` and `scale`
  only, ease-out, under 300 ms, nothing on keyboard-driven actions, and reduced motion respected.

Where things live and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md).
Coding agents should start with [AGENTS.md](AGENTS.md).

## Security issues

Please don't open a public issue; see [SECURITY.md](SECURITY.md).
