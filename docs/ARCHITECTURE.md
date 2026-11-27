# GMI Desk — architecture

A desktop client for GMI Cloud in the style of T3 Code. Electron 45 + React 19 + Tailwind 4 + Base UI.

## Credentials (the core constraint)

| Credential | Obtained by | Unlocks |
|---|---|---|
| **GMI sign-in** (OAuth 2.1 on `mcp.gmicloud.ai`: PKCE, dynamic client registration, refresh tokens) | "Sign in with GMI" in the system browser | Model catalog with the org's discount, balance + LLM spend, image/video/audio generation, Studio gallery workflows, docs search, support tickets — all through GMI's MCP tools |
| **Inference API key** (`ie_model` scope) | Pasted once, validated with `GET /api/v1/me/api-keys/current`, stored in the OS keychain | Chat (`api.gmi-serving.com/v1`), GMI Router (`/ie/recommendation/autoroute`), `/v1/models` |
| Compute key (`ce_resource`) | Later (Agentbox tab) | Agentbox sandboxes |

GMI's OAuth server has no inference scope today, so chat still needs one key. The Connect chat dialog
(`renderer/components/connect/`) makes that one click: it opens GMI Console's API keys page and picks the copied key
up from the clipboard (`services/auth/key-detection.ts`, only while the dialog is open, confirmed by the user before
anything is sent). `services/auth/inference.ts` probes whether GMI accepts the sign-in for inference; while it does
and no key is stored, `KeyProvider` returns the OAuth access token instead, so the key step disappears without an
app update (D14). Everything else is key-less.

## Layout

```
src/
  shared/              # imported by main AND renderer (no Node/DOM APIs)
    app.ts             # APP_NAME, GMI URLs, console deep links, URL allow-check
    contracts/         # THE API between renderer and main, one file per slice
    lib/               # sse parser, money (unit conversion, discounts), formatting, parameters (MCP + feed schema normaliser)
  main/                # Electron main process (Node)
    index.ts           # composition root: context → slices → IPC → protocols → menu → window
    core/              # context, http (fetch wrapper → GmiError), JSON stores, secure store, events, settings, clipboard,
                       # app-origin (app:// scheme, IPC sender check), dev-env, app-menu, shutdown, notifications
    ipc/registry.ts    # exposes each slice's API object as gmi:invoke:<ns>:<method>
    services/<slice>/  # one folder per slice; exports create<Slice>Slice(ctx, deps)
    mock/              # GMI_DESK_MOCK=1: mock MCP tools (one file per slice) + recorded fixtures
    dev/screenshots.ts # offscreen screenshot runner
  preload/index.ts     # contextBridge: window.gmi = { invoke, on, platform }
  renderer/            # React app
    lib/               # gmi client proxy, react-query setup + keys, hooks, zustand UI store
    components/ui/     # design system (button, input, select, badge/DiscountBadge, active-bar, card, dialog, popover,
                       # tooltip, tabs, switch, menu, command, micro-label, misc: EmptyState/MicroLabel/Skeleton/Kbd…)
    components/brand/  # Dino (mascot art: dino-art.ts, one SVG string; Dino.tsx: <Dino mood>, <DinoLoader>), Plates
    styles/            # index.css (GMI tokens, Tailwind theme, global CSS), dino.css (Dino motion + boot splash; plain
                       # CSS inlined into index.html by vite.config.ts bootSplashPlugin)
    index.html         # CSP placeholder + the boot splash (#gmi-boot), painted before any script
    components/        # PageHeader/PageBody, ErrorNotice, RequireAuth/RequireInferenceKey, ModelPicker, Markdown, shell/*,
                       # connect/ (Connect chat dialog, mounted once in App, opened with useUi().openConnect())
    pages/<page>/      # one folder per page
test/                  # vitest: core/ + one folder per slice; helpers/ (test context, fake fetch, SSE responses)
                       # *.test.tsx render components with react-dom/server (node environment, no DOM)
```

## Slices

| Slice | Main | Renderer | Contract |
|---|---|---|---|
| auth | `services/auth` (OAuth, MCP gateway, inference key) | `pages/settings`, `pages/welcome` | `contracts/auth.ts` |
| catalog | `services/catalog` (live catalog, New badges, leaderboard, OpenCode export) | `pages/models` | `contracts/catalog.ts` |
| chat | `services/chat` (threads, streaming, GMI Router auto mode) | `pages/chat` (+ `ChatSidebar`) | `contracts/chat.ts` |
| media | `services/media` (estimate → approve → submit → poll, uploads, gallery) | `pages/create` | `contracts/media.ts` |
| usage | `services/usage` (account summary, media activity, budgets, docs, support) | `pages/usage`, `pages/docs` | `contracts/usage.ts` |
| gateway | `services/gateway` (every model request: bodies, metering, reservations, TPM scheduler, retries, breakers) | `pages/usage/GatewayCard.tsx` | `contracts/gateway.ts` |
| compute | `services/compute` (Compute key via auth, catalog, CE + Sandbox v2 clients, journal, lifecycle, cost guard, sweep) | `pages/compute`, `components/connect/ConnectComputeDialog.tsx` | `contracts/compute.ts` |
| computer | `services/compute/computer/` (shell-v2, flow, ring-buffer, exec, files, transfers, ports, services, preview, session, parts) | `components/computer/*` (dock, terminal, files, ports, preview pane, status bar) | `contracts/compute.ts` (`ComputerApi`) |
| harness | `src/harness/` (utilityProcess: host, host-runtime, protocol, store, loop, tools, sandbox, perm, git, worker) + `services/harness/` in main (supervisor, broker, GMI MCP bridge `mcp-bridge.ts`, `harness.mock-turn` Diagnostics) | `pages/code` (shared types), Settings › Code | `contracts/code.ts`, `contracts/gateway.ts`, internal `src/harness/types.ts` |
| code | `services/code/` (service, projects trust, loosening, mcp configs) + mock `src/main/mock/code.ts` | `pages/code` (page, components, settings) | `contracts/code.ts` |

Slices talk to each other only through the internal interfaces in `src/main/core/services.ts`
(`McpGateway`, `KeyProvider`, `AuthService`, `CatalogService`, `BudgetGuard`), wired in `src/main/index.ts` (order: auth → catalog → usage → gateway → chat → media → compute → computer → harness → code; each new feature registers through one file in `src/main/slices/`). Design + phased plan with per-slice file ownership for Compute and the harness: `docs/design/compute.md` §21, `docs/design/harness.md` §24.

### File ownership (when several agents work in parallel)

A single agent may edit anything (contracts stay additive, AGENTS.md rule 8). With parallel agents:

- **Slice agent** owns `src/main/services/<slice>/`, `src/main/mock/<slice>.ts` and `src/main/mock/fixtures/<slice>/`
  (where they exist), its pages from the table above, and `test/<slice>/`.
- **Foundation** (one owner at a time, the lead/integrator; slice agents send it requests instead of editing):
  `src/shared/**` (all contracts), `src/main/index.ts`, `src/main/window.ts`, `src/main/core/**`, `src/main/ipc/**`,
  `src/main/services/app/`, `src/main/dev/`, `src/main/mock/{mcp,types}.ts`, `src/preload/**`,
  `src/renderer/{App,main}.tsx`, `src/renderer/index.html`, `src/renderer/{lib,components,styles}/**` (incl. the Dino
  art and `dino.css`), `src/renderer/pages/{registry.ts,StubPage.tsx}`, `build/` (icon),
  `scripts/**`, `test/core/**`, `test/helpers/**`, and the root config files (package.json, tsconfig*, vite/vitest config).
- Packaging (backlog 2) is foundation work. A new tab = new contract file + `services/<slice>/` + `pages/<page>/`,
  registered by the foundation owner in `pages/registry.ts` and `src/main/index.ts`.

## Conventions

- **Errors**: throw `GmiError(code, message)` (`src/shared/contracts/errors.ts`). The IPC layer serialises it; the renderer
  rethrows it with the same `code`. `<ErrorNotice error={e} />` shows the right fix (sign in, add key, budget...).
- **HTTP**: use `ctx.http` (sets the User-Agent — Cloudflare blocks some defaults — maps statuses to codes, retries).
  Streams: `ctx.http.request(url, { timeoutMs: 0, signal })` then `readSse(res.body)`.
- **Persistence**: `openJsonStore` / `atomicWriteFile` under `ctx.paths.data`. Secrets only via `ctx.secure`.
  Keys and tokens never cross IPC; the renderer gets metadata (last 4 chars, scope, status).
- **Events**: main → renderer with `ctx.events.emit(name, payload)` (names in `GmiEvents`); renderer uses `useGmiEvent`.
- **Money**: normalise with `src/shared/lib/money.ts`. Charged price = list × (1 − discount). GMI does not stop
  spending at a negative balance, so every paid action goes through `BudgetGuard`. Media jobs are estimated first and need
  a cost confirmation above `confirmAboveUsd` (default 0 = every priced job). Chat is only checked before sending
  (`budget.check(null, 'chat')`: no estimate or confirmation), so one reply can overshoot a limit. Its cost is recorded
  afterwards from usage, or from an estimate when usage is missing.
- **Renderer data**: TanStack Query with keys from `lib/query.ts` (`qk`); shared hooks in `lib/hooks.ts`
  (`useAuth`, `useCatalog`, `useBudget`, `useSettings`...). Navigation: `useUi().navigate(page, params)`.
- **Mock mode** (`GMI_DESK_MOCK=1`): services serve recorded fixtures; mock MCP tools live in `src/main/mock/{catalog,media,usage}.ts` (merged in `mock/mcp.ts`); auth and chat mocks are
  `src/main/services/auth/mock.ts` and `src/main/services/chat/mock.ts`.
  Fixtures are sanitised (no real org ids, no real media URLs).
- **Security**: contextIsolation + sandbox, CSP built by `csp()` in `vite.config.ts` (injected into the `__GMI_CSP__` placeholder of
  `src/renderer/index.html`; the dev variant also allows 127.0.0.1:5199), only https links open externally, every web permission except `clipboard-sanitized-write`
  denied, IPC accepts calls from the app's own frame only, local media served through `gmi-media://` with path checks.
  Details in [Security](#security) below.

## Style (T3 Code density, GMI brand — D16, D17)

Dense and quiet: 14px body text with 13px controls and buttons, `text-2xs`/`text-3xs` (11/10px) for meta, 52px top bar
(`h-topbar`), 46rem chat column (`max-w-chat`), 17.5rem detail panel (`w-details`). Keyboard first: ⌘/Ctrl+K palette,
+N new chat, +B sidebar, +1..5 pages.

GMI brand: true black (dark, default) / near-white (light), GMI's neutral greys, lime #DDEA4D, 6px radius, Geist Mono for
micro-labels and code, Inter for text. Rules every screen follows (tests in `test/core/{contrast,shell-brand,ui-kit}`):

1. **Lime is a fill** (`bg-primary`, always `text-primary-foreground` = black on it). Brand-coloured text/icons use
   `text-primary-ink` (lime on dark, olive #5c6a00 on light). Never lime text, borders or glows on light surfaces.
2. **One accent green.** OK / verified / deal / done = `Badge variant="primary"` / `text-primary-ink` / `<DiscountBadge>`.
   `success` (hue 135) is for rare verification states only; red = failure, amber = warning.
3. **Lime fill once per screen**, on the action that can be taken now (forms keep submit outline until they can submit).
4. **Navigation vs selection:** nav items (sidebar, Settings sections) = `<ActiveBar>` + ink icon, no slab; selected list
   rows = `bg-accent` + inner `activeBarBefore`; both change instantly.
5. **One of each:** `microLabel` / `<MicroLabel>` (mono, uppercase, 0.16em), `<Select>` (Base UI; field or ghost trigger
   with a quiet ChevronDown, themed popup with a brand-ink check; never a native `<select>`: its OS-drawn list ignores the theme),
   `<Plates>` (the "working" signal in chips/badges/rows; buttons keep a small Spinner), `<DinoLoader>` (page-level
   waits only), `EmptyState dino="sleep"` for "nothing yet", happy Dino for success moments. Dino never appears in
   high-frequency spots.
6. **Motion** (Emil Kowalski): occasional UI only, transform/opacity, ease-out, ≤ 250 ms, exits faster, popovers from
   their trigger, nothing from scale(0), press = scale .97 for buttons and small controls (`pressMotion`), a deeper
   background with no transition for full-width rows and list items (`rowPressMotion`: no scale, no fade trail behind
   keyboard selection), large tiles dim instead of scaling, instant on keyboard/high-frequency UI, reduced motion
   respected (fewer, gentler animations: fades stay, movement goes). Exceptions: the boot splash (≥ 650 ms visible)
   and Welcome's one-time hand-over from it (~600 ms). Recipes and their tests: `components/ui/motion.ts`,
   `test/core/ui-motion.test.tsx`.

## Security

- **Renderer origin.** Production loads `app://gmi-desk/index.html`, a privileged standard scheme served by
  `protocol.handle` from `dist/renderer` next to the main bundle (`core/app-origin.ts`: GET/HEAD only, no traversal or
  encoded separators, files only, MIME types from `net.fetch` on the file URL, 404 otherwise). Never `file://`: a file
  page gets Electron's extra file privileges and its CSP `'self'` matches every local file. `app://` and `gmi-media://`
  are registered in one `protocol.registerSchemesAsPrivileged` call (the API may only be called once).
- **IPC trust** (`makeAppUrlCheck`): exactly the `app://gmi-desk` origin, plus the Vite dev server only when not packaged
  and only for `http://127.0.0.1:<port>` / `http://localhost:<port>`. The check no longer depends on the install path.
- **Packaged builds ignore developer overrides.** `core/dev-env.ts` deletes `VITE_DEV_SERVER_URL`, `GMI_DESK_MOCK`,
  `GMI_DESK_MOCK_AUTH`, `GMI_DESK_MOCK_USAGE`, `GMI_DESK_SHOTS*`, `GMI_DESK_USER_DATA`, `GMI_DESK_DEVTOOLS` and
  `GMI_API_KEY` from `process.env` at startup when `app.isPackaged`, before any slice reads them. New dev-only
  variables belong in `DEV_ENV_VARS`.
- **DevTools / menu.** `webPreferences.devTools` is on only with the dev server or `GMI_DESK_DEVTOOLS=1` (unpackaged).
  Otherwise the application menu is `productionMenuTemplate()`: no reload, force reload, close-window or DevTools
  accelerators (Ctrl+R / Ctrl+W lost drafts; Ctrl+Shift+I invited self-XSS); Edit, zoom, full screen and Quit stay.
- **Model/feed Markdown** never loads remote images on its own: `![](https://…)` renders a "click to load" placeholder
  naming the host (an image URL can carry the conversation to any host). Loaded images send no Referer. The CSP keeps
  `img-src https:` because model icons, generated outputs and user-pasted media links come from many hosts.
- **Shutdown.** `before-quit` waits (up to 3 s, `core/shutdown.ts`) for every slice's `dispose()` before quitting.
  At startup, `sweepStaleTempFiles` removes `*.tmp-<pid>-<n>` files older than 10 minutes that an interrupted
  `atomicWriteFile` left under `data/`, `secure/` and `exports/`.
- **Notifications** (`core/notifications.ts`) stay referenced until clicked or closed; a click with no window (macOS)
  reopens it and runs the action once the page has loaded.

### Packaging checklist (not set up yet)

When packaging is added, flip these Electron fuses with `@electron/fuses` (they cannot be set at runtime):

| Fuse | Value | Why |
|---|---|---|
| `GrantFileProtocolExtraPrivileges` | `false` | the app never needs file:// pages (renderer is app://) |
| `RunAsNode` | `false` | `ELECTRON_RUN_AS_NODE` would turn the signed binary into a Node runtime |
| `EnableNodeOptionsEnvironmentVariable` | `false` | `NODE_OPTIONS=--require …` injection |
| `EnableNodeCliInspectArguments` | `false` | `--inspect` debugger attach to the main process |
| `OnlyLoadAppFromAsar` | `true` | no loading a replacement `app/` folder |
| `EnableEmbeddedAsarIntegrityValidation` | `true` | refuse a modified `app.asar` (the packager must embed the asar integrity hash) |

Also: keep `app.isPackaged` true for release builds (it gates the rules above), and ship `dist/renderer` inside the asar
next to `dist-electron/`.

## Commands

```
npm run dev          # Vite + Electron with reload
npm run dev:mock     # same, with demo data (no GMI account needed)
npm run check        # typecheck + tests + build
npm test             # vitest
node scripts/screenshots.mjs --name x --pages "models,chat#light"   # offscreen PNGs → .agent-builds/x/shots/
```
