# GMI Desk — agent handoff (start here)

This file is the single entry point for any coding agent (Claude Code, Codex, OpenCode, Droid, Cursor, …) picking up
this project. It replaces the original chat: everything needed to continue is in this repo.

**Read in this order:** this file → [docs/STATUS.md](docs/STATUS.md) (what exists, what is verified, what is next) →
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the code is organised) → [docs/DECISIONS.md](docs/DECISIONS.md)
(why it is built this way) → [docs/RESEARCH.md](docs/RESEARCH.md) (verified facts about GMI Cloud, T3 Code, Droid,
agent runtimes) → [docs/research/](docs/research/) and [docs/design/](docs/design/) (Compute and harness research and
reviewed designs).

**Start sessions in the repo root** and run every command from there. On the maintainer's machine a gitignored
`CLAUDE.local.md` holds maintainer-only context (local folders, extra secrets, tool setup); if it exists, read it too.
The raw outputs of the research, build, review and fix runs (`docs/history/`) are kept locally, not in the repo.

## What this is

**GMI Desk** (working name) is a desktop client exclusively for **GMI Cloud** (gmicloud.ai), styled after
**T3 Code** (Theo Browne's agent GUI, github.com/pingdotgg/t3code). Goal from the user: *people never have to leave
the app* — no hunting for API keys, no searching for the latest models, usage in one place, GMI products (model
catalog, GMI Router, media generation, Studio workflows, later Agentbox) in one window.

**The user** (the maintainer; Linux desktop, Wayland) chose: a new app in the T3 Code style (not a fork), Electron,
the phased plan in docs/STATUS.md. They prefer concise, direct communication and want agents to proceed autonomously
within the ground rules below.

**State (2026-11-27):** prepared for publishing at github.com/kunalsiyag/gmi-desk (MIT, D29; not committed or pushed
yet) after a design-polish pass with Emil Kowalski's rules; `npm run check` green: 3 typecheck projects, 3439 tests,
build. First version complete and verified offline — Welcome, Chat, Models, Create, Usage, Docs, Settings, Code,
Compute. Earlier milestones: the first version was reviewed by a 4-lens adversarial review (53 verified findings, all fixed with regression tests). **Real account:**
the user signed in once with `npm run dev` (2026-11-01 07:08 UTC): DCR → browser consent → token exchange → MCP catalog
worked (on disk: `~/.config/GMI Desk/data/auth.json` has `signedInAt`; catalog cache `sources.mcp` ok, 257 models;
no inference key saved, nothing paid). **Connect chat** (D14) replaced "paste a key in Settings": a guided dialog
that picks the key up from the clipboard, and an OAuth inference probe that makes chat key-less by itself the day
GMI accepts the sign-in. **GMI brand (2026-11-02, D16/D17):** lime #DDEA4D on true black, GMI greys, Geist Mono
micro-labels, GMI's official logo in the sidebar / splash / Welcome, and GMI's mascot Dino (the skull-headed robot
T-rex with a chip heart, redrawn as animated vector art in `components/brand/`) on the boot splash, page-level
loaders, empty states, success moments and the window icon; one design language (docs/ARCHITECTURE.md › Style). **Never exercised yet:** token refresh, revoke/sign-out, inference key
validation, the OAuth inference probe and clipboard detection on the real desktop, live chat / GMI Router, paid
media generation. That is the next step and needs the user (an inference key +
explicit approval of each paid call). Details: docs/STATUS.md. **Compute + harness (2026-11-02, D19–D25):** research in `docs/research/`, reviewed
designs in `docs/design/{compute,harness}.md` (phased plans with file ownership: F0 → {C1 → C2} ∥ {H1 → H2 → H3} → H4).
Built and verified offline: F0 foundation, H1 GMI gateway (chat now runs on it), C1 Compute core (Compute page,
Connect Compute, cost guard; mock simulators), C2 computer panel (terminal, files, ports, previews in a dock beside any
page), H2 harness core (`src/harness/`, utilityProcess, bubblewrap sandbox, event store, loop, compaction, git
checkpoints; Diagnostics `harness.mock-turn`), H3 Code tab (projects/threads/timeline/approvals/review/composer,
Settings › Code, GMI MCP bridge; third-party MCP transports config-only) — full suite green (D27–D28, 2026-11-07).
Sandboxes default to ≥ 8 GiB (D26). Next: H4 sandbox MCP + agent-driven computer; the live steps (Compute key, paid
probes ≈ $0.02–$0.05 each, a real agent turn) need the user. Tests share one machine
with heavy harness tests: wait by polling (never fixed sleeps), `vi.waitFor` defaults to 15 s (`test/setup.ts`).

## Ground rules (must follow)

1. **No git commits, pushes or branches unless the user asks.** Default branch `main`.
2. **Never spend the user's GMI money or create GMI resources without explicit approval in the current conversation.**
   Allowed freely: public GETs (curl with `-A "gmi-client-research/0.1"`), read-only GMI MCP tools (`search_models`,
   `get_model`, `list_generations`, `get_generation`, `get_account_summary`, `search_docs`, `estimate_generation` —
   free). Needs approval: `submit_generation`, `upload_media`, `create_support_request`, any inference/chat/router
   call with a real key, OAuth client registration or authorization against GMI.
3. **Never read, print or copy secrets:** `.env*`, the app's `<userData>/secure/*.bin`, other tools' credentials in
   the home folder (`~/.claude.json`, `~/.factory/auth*`, …), other projects' env files, API key values in any config
   (print key *names* only).
4. **Never spoof a browser User-Agent.** Cloudflare in front of GMI blocks Python urllib's default UA (error 1010);
   use a descriptive UA. The app sends `GMI-Desk/<version>` via `ctx.http`.
5. **Before handing back:** `npm run check` (typecheck + tests + build) must pass. For UI changes, render screenshots
   in both themes (see Commands: add `#light` to a page spec; dark is the default) and look at them.
6. **Fixtures/tests must stay sanitised:** organisation ids → `00000000-0000-0000-0000-000000000000`, no real media
   output URLs (they are public GCS URLs containing the org id), fake balances.
7. **Publishing:** do not post or announce anything about this app (DEV, LinkedIn, GitHub, X), push, or cut a
   release without the user's OK. The source is public (github.com/kunalsiyag/gmi-desk, MIT): keep personal details
   (names beyond the LICENSE line, roles, home paths, other projects, account data) out of every tracked file; they
   belong in the gitignored `CLAUDE.local.md`. "GMI Desk" is an unofficial working name. The app uses GMI Cloud's
   official logo (`components/brand/gmi-logo.ts`, from docs.gmicloud.ai) and GMI's mascot Dino (a vector redraw of
   GMI's own Dino) with GMI's permission (D18, D29); don't alter the logo's shapes. Both stay GMI's: the README's
   License section excludes them from the MIT grant.
8. **Keep contracts backward compatible** (`src/shared/contracts/*`): additive changes only unless you update every
   caller. Respect slice ownership when several agents work in parallel (docs/ARCHITECTURE.md › File ownership).
9. **Real mode is the user's live account.** `npm run dev`, `npm start` and any packaged build use `~/.config/GMI Desk/`,
   which holds the user's real OAuth tokens (signed in since 2026-11-01). Run them only with the user present and
   agreeing; for your own checks use `npm run dev:mock` or `scripts/screenshots.mjs` (throwaway profiles). Never delete,
   reset or copy that folder. Never ask the user to paste a key into the conversation or to export `GMI_API_KEY` in your
   shell: the user pastes it into Settings themselves.
10. **Hand off when you stop.** The next agent has no chat history: update docs/STATUS.md (timeline row, verified /
   not-verified tables, backlog), add a D-entry to docs/DECISIONS.md for every new decision, and keep this file's
   "State" paragraph and Next steps true.

## Commands

```bash
npm install                 # Node >= 22.12 (machine has 22.22 via nvm); no pnpm/bun needed
npm run dev:mock            # Vite + Electron with demo data (no GMI account needed)
npm run dev                 # REAL account: the user's signed-in profile ~/.config/GMI Desk/ — only with the user (rule 9)
                            # Vite is pinned to 127.0.0.1:5199 (strictPort): only one dev/dev:mock run at a time
npm run check               # typecheck (3 projects) + vitest + production build — must pass
npm test                    # vitest only (test/**/*.test.ts and *.test.tsx)
npm run build && npm start  # production build, then run it — also the REAL profile; use start:mock for your own checks
npm run start:mock          # run the existing build with demo data
npm run typecheck           # only the 3 tsc projects (tsconfig.node / .web / .test-web)
node scripts/screenshots.mjs --name <x> --pages "models,chat?thread=<id>#light~2500"
                            # builds into .agent-builds/<x>/, renders pages OFFSCREEN with mock data, prints PNG paths
env -u GMI_API_KEY node scripts/screenshots.mjs --name live-check --live --pages "models~9000"
                            # real code path, signed out, live public feeds (GETs only). Each run first deletes
                            # .agent-builds/<name>/shots, so `--name live` would wipe the evidence STATUS.md cites;
                            # an exported GMI_API_KEY would be used for /v1/models, hence `env -u`.
```

```bash
node --experimental-strip-types scripts/make-icon.mjs   # regenerate build/icon.{svg,png} (Dino tile) from the Dino art; needs ffmpeg+librsvg
```

The boot splash is static HTML (it shows before React), so the screenshot script cannot capture it: load a built
`dist/renderer/index.html` in an offscreen Electron window without the preload (React then never starts and the
splash stays), with `nativeTheme.themeSource` set for the light variant.

Screenshot spec: `page[?k=v&k2=v][#light|#dark][~waitMs]` (any suffix order; default dark, 1800 ms); pages: `chat models
create usage docs settings welcome`. Output: `.agent-builds/<name>/shots/<page>[-light][-n].png`. Params the pages read:
chat `thread model new`, models `model tab filter q export`, create `kind model focus`, usage `days section`, docs
`q section`, settings `section`, welcome `step=connect` (the after-sign-in offer); any page `connect=1` opens the
Connect chat dialog (`connect=success` previews its success moment in mock mode); chat, code and compute
`computer=terminal|files|ports|logs|preview` open the computer dock (`computerResource=cr_mock_sb1` picks the demo
sandbox, `computerPort=<n>` a preview; needs `GMI_DESK_MOCK_AUTH=compute_key`). Mock thread ids: `5eed0000-0000-4000-8000-000000000001` … `-000000000004`
(`src/main/mock/fixtures/chat/demo-threads.json`). `--skip-build` reuses the existing `.agent-builds/<name>` build.
Read the PNGs with your image-viewing tool. The window is fixed at 1360×880; narrow Models layouts are checked by
`node test/catalog/models-layout.cdp.mjs .agent-builds/<name>` (980–1360 px, exits 1 on failure; not part of vitest).

## Architecture in one screen

Electron 45 main process (Node) + sandboxed renderer (React 19.3, Tailwind 4.3, Base UI 1.9, TanStack Query 5, zustand,
cmdk, sonner) talking over a typed IPC bridge. TypeScript **7.0.2** (the native Go compiler, `tsc`). Vite 8, esbuild,
vitest 5. The renderer never touches the network or any secret.

- `src/shared/contracts/*` — the API between renderer and main, one file per slice (`GmiApi`, `GmiEvents`).
  Errors are `GmiError(code, message)`; codes survive IPC (`IpcResult`).
- `src/main/index.ts` — composition root: context → slices (auth → catalog → usage → chat → media) → IPC → window.
- `src/main/core/*` — `ctx.http` (fetch wrapper → GmiError, UA; opt-in `retries` (default 0) and `redirect: 'manual'` (default `'follow'`; used by media downloads)), JSON stores (atomic),
  `ctx.secure` (Electron safeStorage; unreadable secrets are kept, `getWithStatus`), events, settings, app origin
  (`app://gmi-desk`), dev-env stripping when packaged, menu, quit guard, notifications.
- `src/main/services/<slice>/` — auth (OAuth + MCP gateway + inference key), catalog, chat, media, usage (+docs,
  support, BudgetGuard). Slices talk only through `src/main/core/services.ts` interfaces.
- `src/main/mock/` — `GMI_DESK_MOCK=1` mock MCP tools (catalog, media, usage; merged in `mcp.ts`) + sanitised recorded
  fixtures (`fixtures/<slice>/`). Auth and chat mocks live in `services/auth/mock.ts` (incl. `GMI_DESK_MOCK_AUTH`) and
  `services/chat/mock.ts` (demo threads, simulated streams).
- `src/renderer/` — `lib/` (typed `gmi` proxy, query keys `qk`, hooks), `components/ui` (design system),
  `components/shell` (sidebar, top bar, command palette), `pages/<page>/`.

| Slice | Main | Renderer |
|---|---|---|
| auth | `services/auth` (oauth, loopback, session, tokens, mcp-gateway, keys, org, mock) | `pages/settings`, `pages/welcome` |
| catalog | `services/catalog` (sources, normalize, merge, seen, cache, schedule, opencode) | `pages/models` |
| chat | `services/chat` (service, store, stream-chat/-responses/-router, think-parser, cost) | `pages/chat` |
| media | `services/media` (estimate, parse, poller, outputs, uploads, jobs-store) | `pages/create` |
| usage | `services/usage` (summary, activity, budget, ledger, docs, support) | `pages/usage`, `pages/docs` |

## GMI facts the code depends on (details + sources in docs/RESEARCH.md)

- **Two credentials.** (1) "Sign in with GMI" = OAuth 2.1 at `https://mcp.gmicloud.ai` (PKCE S256, public client,
  dynamic client registration, refresh, revocation; loopback redirect `http://127.0.0.1:<port>/callback`; resource
  `https://mcp.gmicloud.ai/mcp`). Scopes: `models:read generation:read generation:write billing:read profile:read
  support:write` — **no inference scope** (the app also requests advertised inference / key-read scopes, D14/D15). (2) An **inference
  API key** (`ie_model` scope, a JWT `eyJ…`) for chat and GMI Router, validated with
  `GET https://console.gmicloud.ai/api/v1/me/api-keys/current`. The app probes `GET /v1/models` with the OAuth token
  and uses the sign-in instead of a key if GMI ever accepts it (`services/auth/inference.ts`).
- Chat: `https://api.gmi-serving.com/v1/chat/completions` (SSE, `reasoning_content`, usage in the final chunk; GMI's
  documented default `max_tokens` is 2000 — the app always sends one). `/v1/responses` for Responses-only models (`*-codex`, `gpt-5.4-pro`, `bytedance/seed-2.0-mini`; chosen in `services/catalog/text.ts`, fallback `guessApi` in `services/chat/service.ts`).
- GMI Router: `POST https://console.gmicloud.ai/api/v1/ie/recommendation/autoroute` `{messages, mode, stream}` —
  plain chat only (tools/temperature ignored), streams chunks then a `routing_metadata` event then `[DONE]`.
- MCP tools give the catalog with the org's discount, balance/promotion credit/LLM spend (not media spend), media
  estimate/submit/poll/upload, docs search, support tickets. Charged = list × (1 − `discount_to_user`).
- Public key-less (undocumented) feeds: `console.gmicloud.ai/api/v1/billing/model_prices`,
  `/ie/requestqueue/models`, `/ie/app/featured-models/active`, `/ie/recommendation/leaderboard`.
- **A negative balance does not block generation** → the app enforces budgets itself. Media outputs and uploads are
  public, unsigned URLs.
- Subscriptions exist (Coding Plan early access; Studio plans) but are readable only through console-session APIs.

## Environment variables (all except `GMI_DESK_LOG_LEVEL` are ignored in packaged builds; see `src/main/core/dev-env.ts`)

| Var | Effect |
|---|---|
| `GMI_DESK_MOCK=1` | demo data, mock MCP/inference, separate userData (`<appData>/GMI Desk Mock`) |
| `GMI_DESK_MOCK_AUTH=<flags>` | comma-separated mock auth states, e.g. `signed_out,no_key` (mock mode only; defined in `src/main/services/auth/mock.ts`): signed_out, signing_in, reconnecting, reauth, partial_scopes, error, org_pending, org_unknown, no_key, invalid_key, unverified_key, env_key, other_org_key, basic_text, unavailable, keychain_locked, sign_in_fails, oauth_inference (GMI accepts the sign-in for chat; no key saved), key_candidate (Connect chat's clipboard watcher has found a key ending `Q7fA`; mock mode never reads the real clipboard) |
| `GMI_DESK_MOCK_USAGE=<flags>` | comma-separated mock account states, e.g. `negative,no_promo` (mock mode only; `src/main/mock/usage.ts`): negative, unlimited, no_promo, unmeasured, empty, truncated, error, media_error |
| `GMI_DESK_SHOTS=<dir>` / `GMI_DESK_SHOTS_PAGES` / `GMI_DESK_SHOTS_LIVE=1` | offscreen screenshot run (used by scripts/screenshots.mjs). `GMI_DESK_SHOTS` implies mock mode unless `GMI_DESK_SHOTS_LIVE=1`; without `GMI_DESK_USER_DATA` it uses a throwaway profile |
| `GMI_DESK_USER_DATA=<dir>` | override Electron userData (e.g. pre-seed a budget for screenshots) |
| `GMI_API_KEY` | dev-only inference key override (shown as "unverified"); also ignored by the auth slice itself when `process.defaultApp` is not true (`services/auth/keys.ts` `envKeyFromEnvironment`) |
| `GMI_DESK_ALLOW_ENV_KEY=0` | ignore `GMI_API_KEY` even in development (`src/main/services/auth/keys.ts`) |
| `GMI_DESK_OUT_DIR=<dir>` | build-time only: Vite and `scripts/build-electron.mjs` write `dist/renderer` and `dist-electron` under `<dir>` (set by scripts/screenshots.mjs) |
| `GMI_DESK_LOG_LEVEL=debug` | verbose logs (the only override also honoured in packaged builds) |
| `GMI_DESK_DEVTOOLS=1` | unpackaged production build only: allow DevTools and keep Electron's default menu (reload / DevTools accelerators) |
| `VITE_DEV_SERVER_URL` | set by `npm run dev`; only `http://127.0.0.1|localhost:<port>` accepted |

App data (real mode, Linux): `~/.config/GMI Desk/` (mock: `~/.config/GMI Desk Mock/`) → `data/` (`settings.json`,
`auth.json`, `catalog-cache.json`, `catalog-details.json`, `catalog-seen.json`, `chat/` = `index.json` + one file per
thread, `media-jobs.json`, `budget.json`, `spend-ledger.json`), `secure/` (`<name>.bin`, encrypted tokens/key — never
read), `media/` (downloaded outputs, `uploads/`), `logs/main.log`, `exports/opencode-gmi.json`.

## Gotchas learned the hard way

- Brand colours: `bg-primary` (lime) is a fill with black text; brand-coloured text/icons are `text-primary-ink`
  (`text-primary` no longer exists in the code). `test/core/contrast.test.ts` checks the tokens in both themes.
- The boot splash (`#gmi-boot` in `src/renderer/index.html`) gets Dino's SVG and `styles/dino.css` inlined by
  `bootSplashPlugin` in `vite.config.ts`; `lib/boot-splash.ts` hides it (≥ 650 ms, 8 s safety net). Welcome's first-run
  hand-over measures `.gmi-boot-dino` and watches `data-done`: keep those names stable.
- Dino gradient ids are per instance (`dinoSvg(prefix)`); duplicate ids break gradients in Chromium once one copy is
  hidden or removed.
- Base UI 1.9 marks the active tab with `data-active` (not `data-selected`).
- Electron 45: use the async `safeStorage` API (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
  `decryptStringAsync` → `{result, shouldReEncrypt}`).
- The renderer origin is `app://gmi-desk` (custom privileged scheme), not `file://`. Local media is `gmi-media://local/…`.
- The renderer only hears settings changed in main through the `app:settings` event (`useSettings` subscribes).
- The always-mounted listener in `App.tsx` is the only place that invalidates the catalog query on `catalog:updated`.
- Offscreen screenshots need `webContents.invalidate()` before `capturePage()`; the scripts handle it.
- `.tsx` tests are typechecked by `tsconfig.test-web.json` (part of `npm run typecheck`).
- `vite/bin` is not exported; build programmatically (`scripts/screenshots.mjs`).
- Workflow/sub-agents: give each parallel agent disjoint file ownership (list in docs/ARCHITECTURE.md › File ownership).
- Scratch space: `.agent-builds/<name>/` (isolated builds + screenshots) and `.review/` are gitignored leftovers of
  earlier runs; put throwaway files there, never in `src/`, `test/` or `docs/`.
- `APP_NAME` (`src/shared/app.ts`, same as package.json `productName`) also names the profile folder
  `~/.config/GMI Desk/`: renaming the working name without a migration loses the user's sign-in, chats and budgets.
  `APP_ID` is sent as the OAuth `software_id`.
- Models page narrow-window check (not in `npm run check`): `node scripts/screenshots.mjs --name layout --pages models`,
  then `node test/catalog/models-layout.cdp.mjs .agent-builds/layout` (exit 1 = layout broke).

## Next steps (priority order; details in docs/STATUS.md)

0. **Publish** (the user commits and pushes; docs/STATUS.md › Backlog 7): then watch the first CI run and enable
   GitHub's private vulnerability reporting.
1. **Live test with the user** (needs the user at the machine; if they are not available, do 2 first). The app logs
   only failures, so first add a dev-only response trace (docs/STATUS.md › Backlog 1). Then `npm run dev` (already
   signed in), set a budget, the user pastes an inference key in Settings, and, each one approved: one chat, one Auto
   (router) reply, one cheap image. Confirm unverified shapes (router usage chunk, `submit_generation`/`upload_media`
   responses, `/v1/models` with a key), token refresh and sign-out.
2. **Packaging**: electron-builder AppImage/deb (+ dmg/exe later) into `release/`, with the fuse checklist in
   docs/ARCHITECTURE.md; needs the user's choice of deb maintainer/author and icon (docs/STATUS.md › Backlog 2).
3. **Agents tab** (GMI Agentbox: list/launch/terminal/logs; needs a Compute `ce_resource` key until GMI adds OAuth).
4. **H4 sandbox MCP + agent-driven computer** (the Code tab is built; wire the compute broker into the host RPC).
5. **"GMI" agent in the ACP Registry** (one-click GMI inside T3 Code, Zed, JetBrains).
6. **Asks to GMI** (README "What would make it fully key-less") — the user decides whether/how to raise them.
