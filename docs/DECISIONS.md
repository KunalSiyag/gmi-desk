# Decisions — GMI Desk

Short ADR-style log. Each entry: decision, why, alternatives rejected. Evidence for the facts cited is in
docs/RESEARCH.md (the raw run outputs are kept by the maintainer, not in the repo).

## D1 — New app in the T3 Code style, not a fork of T3 Code (2026-10-31, user approved)
**Why:** T3 Code (MIT, v0.1.6) is ~1M lines, gets 1,000+ commits a week, its maintainers do not accept outside
features, and it has no model engine of its own (it drives Codex/Claude Code/OpenCode/Pi/ACP agents). A fork would
cost 1–3 engineer-days a week just to keep up, and a GMI-only product needs pages T3 does not have (catalog, media,
usage). We copy the *look* (layout, density, tokens, shortcuts), not the code. **Rejected:** fork (maintenance);
upstream GMI provider (maintainers won't take it; GMI already works in stock T3 via OpenCode/Codex config).

## D2 — Electron, not Tauri
**Why:** same as T3 Code; a Node main process lets us use the MCP TypeScript SDK, fetch/SSE, keychain via
`safeStorage`, and later bundle OpenCode/node-pty without a Rust sidecar; identical Chromium rendering across OSes.
**Cost accepted:** larger install and memory than Tauri.

## D3 — Credentials: GMI OAuth sign-in for everything it covers + one pasted inference key
**Why:** GMI's MCP server is a full OAuth 2.1 server (PKCE, DCR, refresh, revoke) whose scopes cover models (with the
org's discount), billing summary, media generation, docs and support — so most of the app needs no key. It has **no
inference scope**, and chat/GMI Router only accept API keys. So chat needs one `ie_model` key, validated with
`/me/api-keys/current` and stored in the OS keychain. **Rejected:** minting keys through GMI's IAM session API (needs
the user's GMI password + OTP inside a third-party app, Cloudflare Turnstile on console sign-in, no Google/GitHub
path, org key cap — only with GMI's blessing); scraping the console session in a webview (fragile, ToS risk).
**Ask to GMI:** an inference (and compute) OAuth scope would make the app fully key-less.

## D4 — Factory Droid SDK is not the agent runtime
**Why:** `@factory/droid-sdk` is a thin Apache-2.0 wrapper around the proprietary `droid` CLI, which requires a
Factory login even with BYOK keys, meters BYOK usage past an allowance, and whose terms forbid redistribution,
serving third parties and publishing benchmarks. **Plan:** open runtimes (OpenCode MIT, Pi MIT, Codex Apache-2.0) for
the future Code tab; Droid at most as an optional "bring your Factory account" agent (T3 Code already supports it via
the ACP Registry).

## D5 — First version scope: Welcome, Chat (+ Router Auto), Models, Create, Usage, Docs, Settings
**Why:** these map 1:1 to "no keys, latest models, usage" and to GMI products reachable with OAuth + one key. Agentbox
(needs a Compute key) and a coding agent (big surface) come next.

## D6 — GMI Router only for plain chat ("Auto")
**Why:** `/autoroute` accepts only `messages`, `mode`, `stream`; tools, temperature and max_tokens are silently ignored,
so it cannot drive tool-calling agents. The documented non-stream body is `{model, message, routing_metadata}`, not
OpenAI `choices`; streamed chunks look OpenAI-style but are only partly documented (unverified live).

## D7 — Catalog = MCP + `/v1/models` (with key) + public console feeds, merged; "New" = first-seen diff
**Why:** no single source is complete: MCP lacks dates and omits some families; public feeds are undocumented (may
change) and include test rows; `/v1/models` needs a key. Feed dates are price timestamps, not release dates, so New
badges come from the app's own first-seen record (seeded from creation dates on first run so a fresh install does
not flag everything). Every source is optional; a failed source keeps its last good data.

## D8 — The app enforces budgets and asks before every paid job
**Why:** GMI keeps generating below a zero balance and its balance lags. Media jobs show an estimate (list price ×
(1 − discount)) and need approval; budgets (daily/monthly, confirm-above, enforce) live in main
(`BudgetGuard`); loosening them needs a native confirmation dialog from main, so a compromised renderer cannot.

## D9 — Vertical slices with fixed contracts, built by parallel agents
**Why:** one agent built the foundation and every contract first; five agents then built auth/catalog/chat/media/usage
in parallel with strict file ownership; slices interact only via `src/main/core/services.ts`. This kept 5 agents from
colliding and made review/fixes parallelisable by area.

## D10 — Mock mode + offscreen screenshots as the test harness
**Why:** agents may not use the user's account or money. `GMI_DESK_MOCK=1` serves sanitised recorded fixtures for
every MCP tool and simulates streams/jobs; `scripts/screenshots.mjs` renders pages offscreen (Electron
`offscreen: true`) so UI can be reviewed as PNGs without a display, in isolated build folders per agent.

## D11 — Security posture
Renderer on a custom `app://gmi-desk` scheme (no file:// privileges), CSP, sandbox + contextIsolation, IPC accepts
only the app origin, every web permission denied except clipboard-sanitized-write, https-only external links, Markdown never renders raw HTML and
remote images load only on click (prompt-injection exfiltration), no DevTools/reload in production, dev env vars
stripped when packaged, secrets only via `safeStorage` and never sent to the renderer or logs, undecryptable secrets
kept (not deleted), downloads re-validate every redirect. Packaging must flip the Electron fuses listed in
docs/ARCHITECTURE.md.

## D12 — TypeScript 7 (native), Vite 8, React 19, Tailwind 4, Base UI
Latest stable at build time (2026-10-31). Base UI because T3 Code and GMI's console both use the shadcn
"base-mira" family — the app looks native next to both.

## D13 — No commits until the user asks
The repo is initialised but nothing is committed; the user decides branch and timing.

## D14 — Connect chat: key-less the day GMI allows it, a guided clipboard flow until then (2026-11-01)
**Why:** the user asked why Droid needs no key. Factory is a reseller (its backend holds the provider keys and meters
plans in 5-hour/7-day/30-day windows); GMI runs both the OAuth server and the inference API, so it *could* accept the
sign-in for chat (docs/GMI-ASK.md). **Built:** (1) after sign-in, at startup (at most once per 24 h) and on demand,
`GET /v1/models` with the OAuth access token (10 s, no retries, never logged): 200 + `data` → `supported`,
401/403 → `unsupported`, else `error` (a blip never downgrades `supported`); persisted in auth.json, reset at sign-out.
While `supported` and no key is stored, the KeyProvider hands chat/router/catalog the access token (GMI hosts only);
a 401 for that token flips the probe to `unsupported` instead of marking a key invalid. A stored key always wins.
(2) Sign-in requests the six known scopes plus every `scopes_supported` entry (validated, deduplicated, max 32
extra), so a future inference or key-provisioning scope is granted without an app update. (3) Clipboard detection
runs only while the Connect dialog is open (start/stop from the renderer, 10-minute auto-stop): on start, on window
focus, every ~1 s while focused. Candidates: one token, 20–4096 chars, JWT-shaped (three base64url segments, header
JSON with `alg`), not the stored key, not dismissed. The renderer sees only `{last4, detectedAt}`; nothing goes to GMI
until the user clicks "Use this key" (same validate + store path as pasting); then the clipboard is cleared only if
it still holds that key. (4) One Connect chat dialog replaces every "go to Settings" key prompt. **Rejected:**
validating candidates automatically (would send whatever the user copied to GMI without consent); watching the
clipboard in the background (privacy; Wayland would not allow it anyway); minting keys via the console session
(D3).

## D15 — Connect chat hardening after review (2026-11-01)
**Why:** a design + security review of D14 found (repros in `.review/connect/`): GMI could accept the sign-in on
`/v1/models` (`models:read`) but refuse it on chat/router with 403 `insufficient_scope`, leaving chat stuck while the
app said "no key needed"; a later probe flipped a refusal back to `supported` every day; the clipboard detector
offered any JWT (incl. the GMI sign-in's own ES256 token); a hung clipboard read disabled detection for the app run;
and the scope union asked for whatever GMI advertised. **Built:** (1) `credentialRefused` (401, or a non-Cloudflare
403) decides when chat, router and the catalog call `KeyProvider.reportInvalidKey(reason, key, status)` (additive
`status`): for the sign-in's token it marks the probe `unsupported` and records `rejectedForScope` (the granted
scopes); a probe `supported` answer is ignored while the scopes are the same; a 403 for a real key is not a dead key.
(2) The probe joins only a probe for the same session epoch, re-runs after a keychain unlock and every 6 h checks the
24 h limit while the app is open. (3) Clipboard candidates must be HS256 JWTs whose payload names no non-GMI URL
issuer; reads time out after 2 s; a run counter reset by stop() abandons stale reads; the main process stops watching
when the window closes, reloads or its renderer crashes. (4) Sign-in requests only advertised scopes matching
inference/chat/router/ie_model (+ `:sub`) or `(api_)keys:read`; if GMI refuses them (`invalid_scope` /
`invalid_client_metadata`), registration retries at once with the six known scopes and a refused authorization makes
the next attempt known-only; saved registrations compare scopes as sets. (5) Dialog: anchored at
`max(3rem, 50vh − 15rem)` instead of centred (height changes no longer move the title/X), Base UI `initialFocus` on
the view's next action (`data-autofocus`), signed-out sign-in is an optional, non-active step, success stays 2.4 s and
pauses while the pointer moves over it, copy says "API key" like GMI Console. **Rejected:** animating the dialog's
height (only transform/opacity animate in this app; the top anchor already removes the jump); requesting `keys:write`
for a future key-minting scope (minting needs new code anyway; least privilege); keeping the rejection across
sign-out (the answer belongs to the session; a new sign-in costs at most one refused chat).

## D16 — GMI brand: lime on black, Dino the mascot, boot splash (2026-11-02)
**Why:** the user: "Use colour scheme of gmi. They prefer green and black. Also have a loading with their mascot dino.
Let's try to polish it as much as possible." **Sources:** gmicloud.ai's stylesheet (`--brand-primary: #ddea4d`,
`--brand-secondary-01: #99a22f`, `--brand-secondary-02: #4a4f17`, greys `--gray-01…09` = #fff…#000, 0 radius,
Geist Mono) and a GMI promo reel (black canvas, lime grid
floor, mono micro-labels, a green Dino with lime back plates). GMI describes Dino as its developer mascot whose
"heart is a chip". **Built:** (1) Tokens (`styles/index.css`): true black / GMI greys, lime `--primary` as a *fill*
with black text, a separate `--primary-ink` for brand-coloured text and icons (lime on dark, olive #5c6a00 on
light, because lime on white is 1.3:1; enforced by `test/core/contrast.test.ts`), `--brand-lime/olive/moss` for
charts, 6 px radius, Geist Mono for mono text (JetBrains Mono dropped). (2) **Dino**: an original vector drawing
(not GMI artwork) in `components/brand/dino-art.ts` — one SVG string used by `<Dino mood>` / `<DinoLoader>` and the
boot splash; moods idle (blink), loading (bob + back plates light up tail → head + chip heart pulse), happy (hop),
sleep (closed eyes, breathing, drifting "z"); `data-still` for the brand mark. Motion in `styles/dino.css`
(transform/opacity only; reduced motion keeps only the plate/heart pulse). Gradient ids are unique per instance.
(3) **Boot splash**: static markup in `index.html` (Dino + "GMI Desk" on a faint grid floor); `vite.config.ts`
(`bootSplashPlugin`) inlines the SVG and `dino.css` as a `<style>` so it paints before any script (CSP allows inline
styles, not scripts). It follows `prefers-color-scheme`, which Electron derives from the theme setting. `App.tsx`
hides it once auth + settings are known (`lib/boot-splash.ts`): at least 650 ms after navigation start, 220 ms fade,
8 s safety net. (4) Brand mark = still Dino; window/taskbar icon `build/icon.png` (Dino on a black tile,
`node --experimental-strip-types scripts/make-icon.mjs`). (5) Dino appears only where it adds warmth: boot,
page-level waits (`DinoLoader`, fades in after 160 ms so fast loads never flash it), empty states (`EmptyState
dino="sleep"`), success moments (happy); never in high-frequency spots (inline spinners, rows, per-message chrome).
**Rejected:** copying GMI's own Dino artwork (not public as a file; an original drawing is ours to animate and
ship); a Lottie/video loader (dependency, CSP, size); lime text on light surfaces; animating the splash on every
navigation. **Open:** "GMI Desk" stays an unofficial name; before any public release the user should get GMI's OK
to use Dino (ground rule 7: still no GMI logos).

## D17 — One design language across the app (2026-11-02)
**Why:** after six parallel area agents restyled the app in GMI colours (D16), a cross-app review found it read as
GMI but spoke several dialects: two greens (mint `success` next to lime), lime fills competing on one screen (the
sidebar's solid New chat next to every page's own call to action), four selection styles, three select styles, four
copies of the micro-label, spinners + pulses + clocks moving at once on running jobs. **Built:** a shared kit first,
then every area adopted it, then a re-review: (1) one accent green — brand-positive states (signed in, valid key,
discounts, copied, done) use the lime tint + ink (`Badge primary`, `DiscountBadge`, `text-primary-ink`); `success`
retuned to hue 135 and kept for rare verification states; (2) lime fill once per screen, only for the action that can
be taken (New chat is outline; Create's Run, Usage's Save limits, Docs' Send, Rename's Save stay outline until they can
act; "new" badges and done step markers are tints, not fills); (3) navigation = `<ActiveBar>` + ink icon, no slab;
list selection = `bg-accent` + inner bar; instant; (4) one `microLabel`/`<MicroLabel>` (`components/ui/micro-label.ts`),
one `NativeSelect` (appearance-none + quiet ChevronDown; ModelPicker uses the same chevron), one working signal
`<Plates>` (`components/brand/Plates.tsx`: three of Dino's plates, opacity-only so it survives reduced motion) used by
status chips, badges, DinoLoader's caption and chat's "working" line; (5) `PageHeader` no longer repeats the top-bar
title (visually hidden h1 + one description line); (6) the top bar hides its own Sign in / "Open again · Cancel" while
the page shows the same call to action (`useUi` counters registered by the gate, the Models banner and Settings);
(7) lime glows behind Dino are dark-only (olive at 6% on light, also in the boot splash). **Rejected:** a lime wash
for selected rows (a highlighter band on light, competes with the call to action); solid lime "New" chips;
keeping the platform select arrow; Dino as a per-message or per-row indicator (seen too often).

## D18 — GMI's real Dino and GMI's official logo (2026-11-02)
**Why:** the user: "the mascot is not correct. it's a dino skeleton. Get the correct one. Also use gmi cloud logo
too." D16's Dino was an invented green dinosaur. GMI's Dino (seen in GMI's own MCP launch film,
`gmicloud.ai/videos/mcp/launch.mp4`, and described by GMI as the developer mascot whose "heart is a chip") is a
little T-rex with a bone-white skull for a head (black eye sockets, nostrils, toothy grin), a translucent purple
robot body, a black chip with the GMI mark on the chest, dark limbs with purple hands and feet, all outlined like a
sticker in lime. **Built:** (1) `components/brand/dino-art.ts` redrawn after GMI's frames (front view, 128-unit view
box): sticker outline pieces share their part's class so head, arms and legs move with their outline
(`transform-box: view-box`, fixed pivots). Moods in `styles/dino.css`: idle (eye-socket blink), loading (bob + nod,
chip mark glows, five status lights blink in turn), happy (hop + wave), sleep (head drooped, closed eyes, dim
lights, drifting "z"). (2) GMI's official logo (mark + GMI wordmark, path data from
`docs.gmicloud.ai/logo/gmi-logo-white.svg`) in `components/brand/gmi-logo.ts` + `<GmiLogo variant>`; used in the
sidebar header ("[GMI logo] Desk"), the boot splash, Welcome (top left), `BrandMark` (the pixel mark), and on
Dino's chip. (3) `build/icon.png` regenerated. (4) The `Plates` working signal became three of GMI's logo pixels
(no rotation). **Supersedes** D16's Dino art and ground rule 7's "no GMI logos" (the user asked for the logo).
**Open:** the user should get GMI's OK before any public release; a GMI-supplied vector of Dino would replace the
redraw one-for-one (same class hooks).
(5) Selects: the user reported the composer's effort picker ignoring the theme — a native `<select>` popup is drawn
by the OS. Every select is now the kit's `Select` (`components/ui/select.tsx`, Base UI Select; `field` and `ghost`
variants; lime check on the selected item, accent highlight, popup motion). `NativeSelect` is gone and
`test/core/ui-kit.test.tsx` fails if a native `<select>`/`<option>` comes back (supersedes D17 point 4's select).

## D19–D25 — Compute, the computer panel, the GMI gateway, the harness and the Code tab (2026-11-02)
**Why:** the user: make the app usable without GMI Studio ("setup cluster engine… T3code style parallel repo… we
don't want to burn tokens… show the container side by side as a grok bot computer"), then "an opencode or droid like
harness… compaction… production grade… used at scale… audit for security, proper loop engineering, mcp
integrations". Research in `docs/research/` (cluster-engine, agentbox, harness); design in `docs/design/compute.md`
and `docs/design/harness.md`, written by an architect, attacked by two adversarial reviewers (security + cost;
reliability + scale + loop engineering; 66 findings, several reproduced on this machine, all folded in; review logs
in compute.md §23 and harness.md §26). The full rationale is in those sections; the summary:
- **D19 Compute slice** (compute.md §3, §22): the Compute key (`ce_resource`) is owned by auth and added with a
  Connect Compute dialog; sandboxes use the Sandbox API v2 only; Cluster Engine create is never retried (fsynced
  write-ahead journal, install-tagged names `gmid-<inst6>-…`, reconcile by listing); every action that starts or
  extends billing needs a native confirmation from main.
- **D20 Compute cost guard** (compute.md §9): leases (containers deleted at expiry, sandboxes paused), idle pause on
  user input only, compute spend in the existing budgets with committed burn, a daily budget required before the
  first container or GPU sandbox, destructive catch-up only on GMI's clock, orphan/EIP/other-install alarms, quit
  check; network exposure beyond one /32 needs a native dialog; only EIPs the app created are released.
- **D21 The computer panel** (compute.md §8): v2 data plane over `ws` in main, xterm.js with acknowledged flow
  control (only while visible); previews in an isolated `WebContentsView` with exact-host token injection; the
  container shell transport decided by a paid probe (P-CE).
- **D22 GMI gateway in main** (harness.md §4): all model traffic including chat; metering with cached / cache-write /
  tier prices; worst-case reservations computed by main; persisted per-thread spend, tighten-only caps from the
  host; one TPM scheduler; retries only where GMI cannot have billed; `context_length_exceeded_behavior: "error"`.
- **D23 Own harness** in a `utilityProcess` (not OpenCode or Pi; a runtime adapter keeps OpenCode possible):
  `node:sqlite` event log, byte-stable prompt prefix for caching, **160k default working window** with layered
  compaction, caps and doom-loop guard, no automatic resume after a crash.
- **D24 Agent safety**: permission modes (default: auto-accept edits in the worktree, ask for shell); loosening only
  through native dialogs; bubblewrap on an allowlisted root (no host sockets — Docker's socket was reachable in the
  first draft), network only through the app's proxy, git metadata read-only except the thread's own refs; every host
  git call through `git-safe`; MCP trust with config/description/package pinning; paid tools only with one-shot
  tokens minted by main.
- **D25 Code tab**: T3-style projects and parallel threads on locked git worktrees, branches `gmi/<id6>/<slug>`,
  per-turn checkpoints in a separate snapshot repo, review/commit/merge with native confirmations, per-thread model,
  caps and token/context meter; H4 adds a sandbox MCP so an agent can drive the computer through scoped grants.

**Defaults chosen for the open questions** (the user asked for autonomous progress; each is a one-line change if
they disagree): 160k working window (raising it per thread shows the cost per step in a native dialog); a daily
budget is required before the first container or GPU sandbox, with no amount pre-filled; agent sandboxes start with
all outbound traffic blocked and npm/PyPI are added per thread; the org-wide billing banner shows counts and $/h only,
never colleagues' resource names; branches `gmi/<id6>/<slug>`; nav Code = Ctrl/⌘+6, Compute = Ctrl/⌘+7; no tray icon
yet (leases are enforced while the app runs and caught up at start); "Detect my IP" calls a public echo service only
when clicked, and says which; default container lease 4 h, then delete; TPM tier unknown → conservative default,
editable. **Build order:** shared foundation F0 → {C1 → C2} ∥ {H1 → H2 → H3} → H4 (compute.md §21, harness.md §24).
Paid live probes (≈ $0.02–$0.05 each; model-default eval ≤ $6) wait for the user's explicit approval each time.

**Built so far (2026-11-02) — deviations from the design docs, accepted:** F0: `openConnect` also takes a click event
(anything but `'compute'` means inference); quit checks have no timeout, a throwing check counts as "quit", and a
second quit request during checks quits; a first-run `installId` write failure does not block startup. H1: reserved
prompt = max(display estimate, chars/2.5, raw × max(1, k)); offline waits count toward the 20-cycle bound and chat
gives up after 60 s with "Could not reach GMI"; a router-host connect failure no longer closes the global gate;
output is clamped only to a known model cap (no blanket 32k); the chat ledger row is written by the meter before the
reservation is released (ref = message id); the gateway disposes before usage. C1: record field `eipIntervals` (EIP
accrues from allocation to release); `releaseEip` accepts the container's `cr_` id; agent sandboxes are refused if
any egress host/CIDR is given at create; a container missing from a list is tombstoned only after a 404 on
`getContainer`; startup waits ≤ 8 s for the public price feed when a Compute key exists; mock mode's cost guard sees
a $25 daily budget by default. **Contract additions requested (next integrator sync):** `GatewayRequest.forceBreakerProbe`,
`AppSettings` TPM tier, Responses encrypted-reasoning on `GwMessage`, `ComputeKeyInfo.sessionOnly`, `listSshKeys()`,
alarm kind `network_degraded` + `retryNetwork`, `getLogs` `autoPoll`/`totalBytes`, `ComputeState.budgetLeftTodayUsd`,
a three-button `Platform.choose`.

**C2 computer panel (2026-11-02) — deviations, accepted:** Electron 45 does not enforce Local Network Access, so main resolves preview hosts itself and blocks private/loopback/IPv6-embedded addresses (fails closed on DNS errors); a synchronous `stop()` inside `did-start-navigation` crashes Electron 45, so it runs on the next tick; main (not the renderer) owns the 5-minute warm close of shell sessions, and a renderer reload or crash closes all previews; Take over / resume retry a 409 for 10 s and the reconnect backoff resets only after a socket stays up 10 s; the idle-pause baseline is max(last activity, app start, running since); screenshot runs (`GMI_DESK_SHOTS`) skip the compute quit dialog. Open: `@types/ws` not added (two `@ts-ignore`s remain); the sidebar auto-collapse below 1,200 px (F0 shell) is unchanged. **Contract additions requested:** `close(sessionId, {now})`, terminal state `unavailable`, `listPreviews` (or preview ids in session info), a Ports-tab-visible signal (or a `computer:ports` event), `portReady` in `startService`'s result. **C-live-2 must verify:** traffic-token header and `{port}-{key}.{domain}` routing incl. WS/HMR; preview bounds at 125 % zoom; the shell's binary protocol, resize, keepalive, stale attach after a network drop and how long a 409 lingers after a control close; the 10-exec cap, wait timeouts, cancel 404 vs 409; cold resume, token re-sign, auto-reattach; snapshots; egress enforcement; the list `state` filter.

## D26 — Sandboxes default to at least 8 GiB (2026-11-03)

The user reported that GMI's small sandbox cannot handle real work, and gave the real sizes: **medium = 2 vCPU /
8 GB, large = 4 vCPU / 8 GB** (the public billing feed has prices but no specs: small $0.0911/h, medium $0.18/h,
large $0.36/h list, Iowa 2 and Iowa 16, checked 2026-11-03). The Launch wizard now pre-selects the cheapest sandbox
size with at least 8 GiB (`SANDBOX_DEFAULT_MIN_GIB` in `pages/compute/launch/state.ts`); it falls back to the
cheapest priced size if no such size is listed, and the user can still pick small. Mock fixtures were corrected to
the real specs (earlier guesses were medium 4/8 and large 8/16). Agent sandboxes (H4) should use the same rule. On the Size step a sandbox size is preselected and marked "Recommended" (GPU containers are not preselected); only the per-data-centre pass of the wizard preselects, because two catalogs picking in turn looped (React #185, caught by the screenshot).
The small size's own specs are still unverified (fixtures say 2 vCPU / 4 GiB): C-live-1 reads them from
`/sandbox` products with the user's Compute key.

**H2 harness core (2026-11-03) — deviations, accepted:** the Diagnostics mock turn uses its own supervisor and a scripted gateway (not main's gateway; no network, key or money); requests refused locally fail with `internal`, so the run stops and can be continued instead of failing; the shell's sensitive-file notice is part of the tool result; the project setup command is not run at thread creation yet; the sandbox's git identity is `agent@gmi-desk.invalid`; subagent compactions are charged to the parent run; a money refusal during compaction stops the thread (cost cap / budget) instead of failing it. Contract additions: none to frozen contracts; additive in `src/harness/types.ts` (`ToolRunContext.askUser`, `sensitiveWrites`, `effects.readRange`, `sensitiveChanged`, `GitService` extras). **Open for H3:** give the host model info (window, prices; the compaction cost trigger is dormant until then), run the setup command, per-run ref-guard snapshots, MCP bridge + `consumeToken`, `extraConfirmation`, record the worktree before creating it, hide allow-thread/allow-always when there is no suggested rule, cost of failed title requests, a macOS live run.

## D27 — H3 Code tab: main owns trust and widening, the host owns the thread (2026-11-07)

**Why:** the Code tab is the first place where a model can edit a repository and run commands on the user's machine,
so the trust boundary matters more than the UI. Decisions:

- **Project trust is main's.** `projects.ts` hashes `AGENTS.md`, `CLAUDE.md`, `.gmi-desk/instructions.md`, `.mcp.json`,
  `.gmi-desk/mcp.json` and `.gmi-desk/permissions.json` (SHA-256, 256 KiB cap per file, empty still hashes). The hash
  shown in the native trust dialog is the one stored; every later read re-hashes, so a changed file shows `changed`
  and the next turn asks again. The host never decides that a project is trusted.
- **Every widening is a native dialog.** `describeLoosening` (one implementation in main, shared by create and update)
  reports mode, context window, shell network, web fetch, computer attach/detach and budget widenings; the dialog's
  body comes from `looseningMessage`; declining throws `cancelled` and nothing reaches the host. Caps are mirrored
  into the H1 gateway (`setThreadCaps` for tightening, `approveThreadCaps` only after that dialog), so main's caps
  cannot be bypassed by a host bug.
- **One default settings shape** lives in `src/shared/contracts/code.ts` (`defaultCodeThreadSettings`): main, host and
  renderer agree on the mode, 160k window, budgets and web defaults. Settings patches carry a **partial budget** and
  the host merges it (`thread.update`), so the UI can change one budget field without restating the others.
- **Commit messages use H1.** `suggestCommitMessage` sends the file summary to the thread's side-task model through
  the gateway (`purpose: 'commit_message'`, background priority, 80 output tokens, no retries) and falls back to a
  local "Update N files" line on any failure; it never blocks the commit dialog.
- **Destructive git is confirmed in main**: commit discard, checkpoint restore, merge, archive-with-removal and
  delete each show a native dialog (`confirmLabel` required); the host's git service enforces the same ref guards
  from H2. Merge never pushes.
- **GMI MCP tools go through main** (`mcp-bridge.ts`). Free GMI tools (`search_models`, `get_model`, …) are called
  directly with the OAuth token that never enters the host. The paid one-shot tools (`submit_generation`,
  `upload_media`, `create_support_request`) require a request id whose one-shot approval token matches the tool and
  the canonical args (`consumeToken`), then pass `budget.check(null, 'agent')` before the call. **Accepted gap:** the
  spend of those paid calls is not written to the H1 ledger yet (media spend is also outside the MCP balance
  summary); the budget check is the guard for now.
- **Third-party MCP transports are deferred** (D28): Settings › Code can create, edit, enable and remove stdio/http
  servers (env values only as names; values in the OS keychain under `mcp.<id>.env`), but the host does not start
  them, so they report `stopped` until the MCP transport milestone. OAuth token requests throw `not_implemented`.
- **Mock mode never spawns the host.** `src/main/mock/code.ts` serves a demo project (`gmi-desk`), two threads (one
  awaiting approval, one running), diffs, rules and MCP rows, so screenshots and `dev:mock` exercise the whole UI
  without an agent process or network.

Verified offline: `npm run check` (full suite, 3 typecheck projects, production build) and mock screenshots of Code
and Settings › Code in both themes. Not yet exercised against the real account: a real host turn, worktree creation,
approvals, MCP transport startup.

## D28 — Third-party MCP servers are config-only for now (2026-11-07)

**Why:** H3-D's first milestone is discovery/trust/config, not running foreign code. `@modelcontextprotocol/sdk` is
installed and the stored server rows already carry `transport`, `command`/`url`, `env` names, `toolHashes` and
`resolvedVersion` plus the trust hash, so enabling transports later is additive (no contract rewrite). Until then the
host reports configured servers as `stopped`, `authorizeMcpServer` throws `not_implemented`, and the UI says so in
one line. The alternative — shipping a half-working stdio spawner — would have put unpinned `npx -y` packages on the
user's machine without a review path; the unpinned-command warning and the trust hash are in place to make that
review meaningful when it lands.

## D29 — Public repository: MIT code, GMI brand assets excluded, maintainer context kept local (2026-11-27, user approved)

**Decision:** the source goes public at github.com/kunalsiyag/gmi-desk under the MIT license (© 2026 Kunal Siyag).
GMI approved the use of its official logo and the Dino mascot (user confirmed 2026-11-27); the README's License
section keeps both, and the app icon, out of the MIT grant and asks forks to replace them. Personal context (the
maintainer's role, home paths, other projects, local tool setup) moved from AGENTS.md/CLAUDE.md into a gitignored
`CLAUDE.local.md` (Claude Code loads it automatically; AGENTS.md tells other agents to read it when present), and the
raw run archive `docs/history/` (local paths, session ids) is gitignored. CI runs `npm run check` on ubuntu-latest;
tests that need bubblewrap, ripgrep or OpenSSL skip themselves there. Security reports go through GitHub's private
vulnerability reporting (SECURITY.md).
**Why:** the user: "We will publish this repo on our github", and chose "scrub personal bits" over publishing the
handoff files as they were or leaving all agent docs out. Keeping AGENTS.md, the design docs and DECISIONS public keeps
the repo workable for any coding agent; only what identifies the maintainer stays local.
**Rejected:** publishing the history (paths, session ids); code-only (loses the design record that explains the
security-sensitive harness and compute code).
