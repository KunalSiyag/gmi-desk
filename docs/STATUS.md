# Status — GMI Desk

_Last updated 2026-11-27. Update this file whenever the status changes._

## Timeline

| Date | What happened |
|---|---|
| 2026-10-31 | Research workflow: 6 researchers + 6 adversarial verifiers on GMI Cloud APIs/SDKs/auth, T3 Code, Factory Droid SDK, agent runtimes → docs/RESEARCH.md. User chose: build a new GMI-only app in the T3 Code style. |
| 2026-10-31 | Foundation built by the lead agent (scaffold, contracts, core, IPC, UI kit, shell, screenshot tooling, 37 tests). |
| 2026-10-31 → 11-01 | 5 parallel slice agents built auth, catalog, chat, media, usage (interrupted once by a usage limit; resumed). Integrated: 489 tests. |
| 2026-11-01 | 4-lens adversarial review (security, GMI integration, reliability, UX) → 56 findings → per-area verifiers: 36 confirmed, 17 partially, 3 refuted. |
| 2026-11-01 | 5 parallel fixers fixed all 53 with regression tests; integrator wired cross-area follow-ups → 683 tests, 3 typecheck projects clean, build OK, live signed-out check OK. |
| 2026-11-01 07:08 UTC | First real-mode run (`npm run dev`): the user signed in with GMI; MCP catalog loaded (257 models); one empty chat thread created; no inference key added, nothing paid. The real profile `~/.config/GMI Desk/` now holds the user's OAuth tokens. |
| 2026-11-01 | **Connect chat** (user: "people have to manually put API keys"): OAuth inference probe (chat switches to the GMI sign-in by itself the day GMI accepts it), every advertised scope requested at sign-in, clipboard key detection, and a guided 3-step Connect chat dialog that every "add a key" entry point now opens (D14). Verified offline: 747 tests, 3 typecheck projects, build, offscreen screenshots of every state in both themes. |
| 2026-11-01 | **Connect chat review fixes** (design + security review, 26 findings; D15): a 403 (insufficient_scope) from chat/router for the sign-in now flips it back to "needs a key", and the probe no longer flips it to "supported" again while the granted scopes are unchanged; clipboard detection only offers HS256 JWTs without a foreign issuer, never hangs on a clipboard read, and stops when the window closes/reloads/crashes; sign-in asks only for advertised inference / key-read scopes and falls back to the six known ones if GMI refuses them; probe re-checked daily while the app is open and after a keychain unlock. Dialog: anchored near the top (no jumping), opens with focus on the next action, one active step, one heading per view, 2.4 s success hold (paused under the pointer), plain "API key" copy. Verified offline: 780 tests, 3 typecheck projects, build, screenshots of every Connect state in both themes. |
| 2026-11-02 | **GMI brand pass** (user: "use GMI's colours, green and black; a loading screen with their mascot Dino; polish as much as possible"; D16, D17): GMI lime #DDEA4D on true black (tokens from gmicloud.ai's stylesheet), olive ink on light, Geist Mono micro-labels; Dino as an original animated vector (moods idle/loading/happy/sleep) on a boot splash painted before any script, page-level loaders, empty states, success moments, the sidebar mark and the window icon (`build/icon.png`); Welcome takes over from the splash with one gliding Dino. Then 6 parallel area polishers → cross-app review (19 findings) → shared kit (ActiveBar, MicroLabel, DiscountBadge, NativeSelect chevron, Plates) + 5 area fixers → re-review (14) → 3 final fixers. Verified offline: 948 tests, 3 typecheck projects, build, screenshots of every screen and state in both themes, boot splash rendered offscreen. The user hit "appIconPath is not defined" in their running `npm run dev` while the main process was mid-edit (fixed; restart dev). |
| 2026-11-02 | **Real Dino + GMI logo** (D18): user said the mascot was wrong ("it's a dino skeleton") and asked for GMI's logo. Found GMI's Dino in GMI's MCP launch film, redrew him as animated vector art (skull head, purple robot body, GMI chip heart, lime sticker outline); GMI's official logo now in the sidebar, splash, Welcome and on Dino's chip; icon regenerated. User also reported the composer's effort picker ignoring the theme (native `<select>` popups are drawn by the OS) → themed Base UI Select replacing every native select. |
| 2026-11-02 | **Compute + harness design** (D19–D25): research workflow (Cluster Engine, Agentbox, harness options → `docs/research/`), then one architect wrote `docs/design/compute.md` and `docs/design/harness.md`, two adversarial reviewers attacked them (66 findings; reproduced here: a bwrap sandbox escape via the Docker socket, code execution through a redirected worktree `.git` during `git add -A`, `rg --pre`, a ledger that counts agent spend as media, no fsync in `atomicWriteFile`, compaction that would wait until ~743k tokens), and the architect folded every finding in. Defaults chosen for the open questions are listed in D19–D25. Nothing created or billed on GMI. Next: shared foundation F0. |
| 2026-11-02 | **F0 shared foundation** (compute.md §21.0): all contracts for both designs (`compute.ts`, `code.ts`, `gateway.ts` + additive auth/usage/errors/app changes), ledger kinds `agent`/`compute` (not counted as media), `BudgetSources` + `statusSnapshot()`, `durableWriteFile` (fsync file + directory), `installId`, quit checks (a cancelled quit with no window reopens one), Platform pickers + `safeSaveName`, Diagnostics registry, slice stubs in `src/main/slices/` (composition: auth → catalog → usage → gateway → chat → media → compute → computer → harness → code), harness bundle entry, Code (Ctrl+6) and Compute (Ctrl+7) placeholder pages. Reviewed on 2 lenses (7 findings, all fixed). Verified: 1056 tests, typecheck, build, screenshots both themes. Then the Compute core (C1) and gateway (H1) tracks started in parallel. |
| 2026-11-02 | **H1 GMI gateway** (D22, harness.md §4): every model call (chat now; agents later) goes through `src/main/services/gateway/` — request bodies per family (`context_length_exceeded_behavior:"error"` on Chat Completions, stripped and remembered per model if GMI rejects it; Responses `store:false`), metering with cached/cache-write tokens, worst-case reservations computed in main (≥ 2.5 chars/token, calibration never below 1), the first budget-waiting request holds its amount back, persisted per-thread ledger, one TPM scheduler, retries only where GMI cannot have billed, 429 requeue, offline gate bounded at 20 cycles, breakers on 5xx/timeouts, Gateway card on Usage. Chat migrated onto it (old stream files deleted; a `stream-router.ts` shim re-exports `ROUTER_URL`). Reviewed on 2 lenses: 11 findings, all fixed. |
| 2026-11-02 | **C1 Compute core** (D19–D20, compute.md §4–§9): Connect Compute + Settings › Compute key (key stays in main), public catalog + sanitiser, CE + Sandbox v2 clients (POSTs never retried; v2 create retried only with the same Idempotency-Key), fsynced create journal + reconcile by listing, install-tagged names, EIP/firewall saga with native dialogs for anything wider than /32, cost guard (leases, idle pause on user input, required daily budget, committed burn, clock-gated catch-up, alarms incl. other installs and an org billing banner, quit check), Compute page (Resources · Launch · Network · Snapshots), mock simulators + `GMI_DESK_MOCK_COMPUTE` flags. Reviewed on 2 lenses: 25 findings (24 distinct), all fixed — notably a container missing from one list poll was tombstoned while still billing, agent sandboxes could be created with open egress, and unknown prices showed $0.00. Verified: `npm run check` 125 files / 1955 tests, build; screenshots of every page state in both themes. |
| 2026-11-02 | **C2 computer panel** (D21, compute.md §8): the dock beside any page (TopBar toggle) for a running sandbox — Terminal (xterm over the v2 shell socket via `ws`; ordered input, debounced resize, flow control that never stalls the socket, ring replay with seq de-dup, attached-elsewhere / Take over, 409 retried 10 s), Files (tree, preview, native-picker upload/download with `.part` + Range resume), Ports and services, port previews in a separate partition (`WebContentsView`, navigation lock, private/loopback/rebinding blocks that fail closed, no popups/downloads/client certificates, "untrusted content" strip, bounds follow app zoom; a renderer reload or crash closes every preview), status bar with $/h and pause timers; main owns the 5-minute warm close; idle clock counts from app start. New deps `ws@8.22.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` (MIT). Container (CE) shell still gated on probe P-CE. Reviewed on 2 lenses (security/isolation, reliability/UX): 16 findings, all fixed — notably an exec slot leaked forever when a cancel failed, previews stayed over trusted UI after a reload, and client certificates would have gone to any preview host. Verified by the fixer: `npm run check` 3349 tests (incl. the parallel H2 track), build; mock end-to-end screenshots in both themes (`.agent-builds/c2/all/`). |
| 2026-11-03 | **H2 harness core** (D23–D24, harness.md §5–§16): `src/harness/` runs as an Electron utilityProcess with a scrubbed env — `node:sqlite` event store (WAL, synchronous=FULL, migrations with `.bak`, online backup), the agent loop (byte-stable prefix with a golden test, 160k default window, caps, doom-loop guard, steering, approvals through main's broker), layered compaction (cost trigger waits for a cached price, a real saving and a doubled context), file tools (read/grep/edit/apply_patch with read-dedupe), shell in a bubblewrap sandbox (no host sockets, seccomp keyring block, a launcher that closes inherited descriptors, proxy refuses the host's own addresses, read-only hooks dir; macOS seatbelt written but not run), permissions, git worktrees + snapshot-repo checkpoints via `git-safe`. Diagnostics action `harness.mock-turn` runs a full turn (read ∥ grep → edit → apply_patch → approved bash → checkpoint → compaction) against a scripted model in a throwaway repo, also verified in a real Electron utilityProcess. Reviewed on 2 lenses with working exploits (sandbox/git escapes: 10, loop/money: 13): 23 findings, all fixed — notably a nested repo ran host code, a planted symbolic ref made the host delete `main`, and a malformed tool name bricked a thread. The integrator was interrupted once (laptop shut down) and resumed. |
| 2026-11-03 | **Check made reliable + sandbox default (D26)**: with 3398 tests the full suite loads the machine; fixed two real races it exposed (the shell tool resolved before its spill file was on disk — a 300k-line spill read back as 67k lines; the store's online backup failed with SQLite's "not an error" when a write landed between steps → one-step copy, 0600 from creation, 2 retries) and test-only timing (1000×-clock breaker test, sign-in event read between two updates, fixed sleeps, 1 s `vi.waitFor` default → `test/setup.ts`, `hookTimeout` 60 s). Sandboxes now default to the cheapest size with ≥ 8 GiB (medium), preselected and marked Recommended on the Size step (D26). Verified: `npm run check` 187 files / 3398 tests green 6 runs in a row under load average 10–12; screenshots of the Size step (both themes) and Review. |
| 2026-11-07 | **H3 Code tab** (harness.md §9–§12, §14; D27–D28): the Code slice is real on both sides. Protocol/host: `StoredMcpServer` + `mcp.upsert`/`mcp.remove` + a `projects` query; thread create/update/archive/delete (root, worktree, existing-worktree strategies), timeline/diff/file-diff/spill queries, permission rules, git (commit/merge/discard/restore/export patch), sandbox self-test. Main: project trust over the instruction/MCP/permission files (re-hashed on every read), every widening through a native dialog, caps mirrored into the H1 gateway, commit-message suggestion through H1 with a local fallback, MCP config CRUD with an unpinned-command warning, and the GMI MCP bridge (free tools direct; `submit_generation`/`upload_media`/`create_support_request` need a one-shot approval token + budget check). Renderer: Code page (project/thread rail, timeline with tool cards, approval cards, composer, Review/Todo/Context panel, diff/commit/new-thread dialogs, trust banner, Demo badge) and Settings › Code (sandbox, projects, rules, MCP + add dialog). Third-party MCP transports and OAuth remain config-only (D28). Mock mode serves a demo project and threads without spawning the host. Verified offline: `npm run check` (full suite, 3 typecheck projects, build) and mock screenshots of Code and Settings › Code in both themes. |
| 2026-11-27 | **Design polish + public-repo prep** (D29; user: "Let's perfect this. Use emil design skill. We will publish this repo on our github"). Three parallel area polishers applied Emil Kowalski's rules (shell/kit/Usage/Settings/Welcome; Chat/Models/Create/Docs; Code/Compute/dock): new `rowPressMotion` (full-width rows press with a deeper background, no scale, no fade trail behind keyboard selection), press feedback on every small control, one lime action per view on the Code tab (the full-width lime "New thread" bar became a quiet icon in the project row), raw amber/emerald/sky colours on Code/Compute replaced by tokens (legible in light), kit `TabStrip`/`Dialog`/`Badge` in the Code right panel and diff view (Escape, focus trap), launch-step row alignment, sandbox sizes in sentence case, toast focus ring, reduced-motion fades for Dino loaders. Bugs found and fixed: disabled Base UI switches looked enabled (`<span role=switch>` never matches `:disabled`), the dark "Jump to latest" pill was see-through (outline buttons now tint through `--outline-fill` so a `bg-*` override wins), keyboard focus on gallery tiles was invisible, `.gmi-markdown` loose lists ran together. An undocumented 2026-11-08 change had left typecheck red (a Code test importing harness fakes) and 3 tests failing (mock budget seeding moved into the usage slice): fixed, the unused compute `mockBudgetOverlay` removed. Repo prep: MIT LICENSE, README with demo-data screenshots (`docs/screenshots/`), CONTRIBUTING, SECURITY, CI (`npm run check` on ubuntu-latest; not yet run on GitHub), package.json repository metadata; personal context moved to the gitignored `CLAUDE.local.md`, `docs/history/` gitignored. Verified: `npm run check` (3 typecheck projects, 193 files / 3437 tests, build), screenshots of every page in both themes. Nothing committed or pushed. |
| 2026-11-27 | **Leftovers + publish** (user: "do all"): keyboard-opened dock sheet appears without its slide-in (⌘/Ctrl+J or Enter on the top-bar button; `sheetInstant` read once at mount), `Badge size="sm"`, Code tab text sizes on the type scale (no half-pixel sizes), Compute browse cards share rows (subgrid) so prices line up, the Size step no longer repeats the title, resource detail shows the size in words (SKU as hint), diff rows keep the file name visible (folders truncate first), the demo thread waiting for approval says so ("Waiting for you", "1 approval"), dock deep links documented (`computer=terminal…`). Then the first commit, the public repo github.com/kunalsiyag/gmi-desk, CI, private vulnerability reporting. |

## What works (verified offline: unit tests + offscreen screenshots in both themes)

- **Shell:** T3-style sidebar (nav, "New chat", recent chats, account footer, theme toggle), top bar (page title,
  page actions slot, balance chip, sign-in/key prompts), command palette (Ctrl/⌘+K: pages, actions, console links,
  chats, page commands), shortcuts (⌘/Ctrl+N new chat, +B sidebar, +1..5 pages, +, settings), toasts, error boundary.
- **Welcome:** first-run screen; sign-in with waiting/cancel/reopen states; "Browse models first".
- **Settings:** account (status, org, scopes, reconnect), inference key ("Connect automatically" + paste → verify with
  GMI → keychain; status, org match, re-verify, remove; "Chat with your GMI sign-in" probe status + Check now),
  security (storage backend, locked-keychain retry), appearance, catalog, chat defaults, media, about.
- **Connect chat** (`components/connect/`, D14, D15): one dialog opened from the top bar (not on Chat, where the composer offers it), the chat composer, key errors,
  RequireInferenceKey, the palette ("Connect chat"), Settings and Welcome (after sign-in: "Connect chat — takes 30
  seconds" / "Later"). Steps: signed in → open GMI Console's API keys page → the app watches the clipboard (only while
  the dialog is open, 10-minute cap) and shows "Found a key ending ••abcd" → [Use this key] validates + stores it and
  clears the clipboard if it still holds the key → "Chat is ready". "Paste it instead" keeps the manual path. When
  GMI accepts the sign-in for chat (probe), the dialog says no key is needed and chat/router/catalog use the OAuth
  access token while no key is stored; a 401/403 from chat, router or the models API for that token takes it back
  (remembered for the granted scopes, D15).
- **Models:** merged live catalog (MCP + /v1/models with key + public feeds), kind tabs, filters (New, Featured,
  Discounted), provider/sort, detail panel (list vs your price, long-context tiers, params, benchmarks), leaderboard,
  New badges + desktop notification, "Export for OpenCode / T3 Code" (writes `exports/opencode-gmi.json`), source
  status line, signed-out banner with public prices.
- **Chat:** threads (persisted per file), streaming (chat completions, Responses API, GMI Router Auto mode with
  routing metadata), reasoning blocks, `<think>` splitting, per-message tokens/cost (estimated flag when the router
  sends no usage), stop/regenerate/retry, rename/delete, drafts kept, budget warnings, key notice when no key.
- **Create:** model list per kind (image/video/audio/workflows), form generated from the parameter schema (client-side
  validation, uploads → public URL), live estimate with discount + budget, cost-confirmation dialog, submit, polling,
  downloads to `media/` (served via `gmi-media://`), gallery merged with GMI history, retake with a new nonce.
- **Usage:** balance, promotion credit (separate pool), LLM spend/tokens/requests by period, top models, media
  activity counts, this-device spend ledger, budgets (daily/monthly, confirm-above, enforce; loosening needs a native
  confirmation), console links.
- **Docs:** GMI docs search (cleaned excerpts), support ticket form with confirmation.
- **GMI brand** (D16, D17): lime-on-black theme in both light and dark (contrast-tested tokens), Dino the mascot
  (boot splash → Welcome hand-over, `DinoLoader` for page waits, sleeping Dino in empty states, happy Dino on Connect
  success / export, still Dino as the sidebar mark, Dino window icon), one design language (ActiveBar navigation,
  accent + bar selection, one micro-label / select / discount badge / Plates working signal, lime fill once per screen).
- **Code** (D27, D28): projects (native folder picker, git checks, trust with a config hash), thread rail with per-project
  filter and archived toggle, timeline (user/assistant with reasoning, tool cards with live args/output, notices,
  checkpoints, compactions, subagents), approval cards (allow once / thread / always, deny, stop run, answers, cost),
  composer (send, steer while running, stop, mode + model), Review/Todo/Context panel (diff list, per-file dialog,
  todo, context meter), commit dialog with an H1-suggested message, merge/patch export, new-thread dialog
  (root/worktree/existing worktree), trust banner when project files changed, and Settings › Code (sandbox self-test,
  projects, permission rules, MCP servers). Third-party MCP servers are configured but not started yet (D28).
- **Security hardening:** `app://gmi-desk` origin (no file:// privileges), CSP, IPC sender check, contextIsolation +
  sandbox, permission handler denies all but clipboard-sanitized-write, https-only external links, click-to-load images in Markdown, no DevTools /
  reload / close accelerators in production, dev env vars stripped when packaged, secrets only in safeStorage
  (unreadable ones kept), redacting logger, guarded downloads (https, manual redirects re-validated, size caps).

**Live check done (2026-11-01):** real (non-mock) code path signed out, against GMI's live public feeds: 266 models
(23 LLMs from public feeds, 243 media), public prices/promotions, sign-in prompts. Screenshots: `.agent-builds/live/shots/` (git-ignored, this machine only; a re-run with `--name live` deletes them —
regenerate with the `--live` command in AGENTS.md under another `--name`).

## Not yet verified against the real account (needs the user)

| Item | Why it matters |
|---|---|
| OAuth sign-in (DCR → browser consent → token exchange → MCP calls) | **Worked once for real** on 2026-11-01 07:08 UTC (`npm run dev`, user approved in the browser): `auth.json` `signedInAt`, `secure/oauth.client.bin` + `oauth.tokens.bin` written, catalog `sources.mcp` ok (257 rows → 84 LLMs, 18 with the org's discount), org id learned via `get_account_summary`, no warnings/errors in `main.log` (checked by the integrator from non-secret files). MCP tool responses were not captured (the app logs only failures). |
| OAuth token refresh and revoke (sign out) | Built and tested against fake servers only; never run for real. |
| Inference key validation live (`/me/api-keys/current`) and `/v1/models` with a key | Response shape of `/v1/models` beyond the documented fields is assumed from an earlier GMI integration. |
| Live chat stream incl. `reasoning_content` and the final usage chunk | Parsers tested on synthetic streams only. |
| GMI Router stream: does it include a usage chunk? exact `routing_metadata` event form? | If no usage, replies are costed by an estimate (`usageEstimated`). |
| `submit_generation` / `upload_media` response shapes; PUT to the upload slot | Parsers are tolerant but untested live (agents were not allowed to spend money). |
| Responses API on GMI for codex/pro models | Documented by GMI, untested. |
| OAuth inference probe live (`GET api.gmi-serving.com/v1/models` with the sign-in's access token) | Free GET, runs after sign-in, at startup and once a day while open; expected answer today is 401 → `unsupported`. Never run against the real account (agents may not run real mode). If GMI answers 200, chat uses the OAuth token; a 401/403 from chat/router then takes it back (D15). The token's audience is the MCP resource: an audience-checking GMI would answer 401 (docs/GMI-ASK.md › audience caveat). |
| Clipboard key detection on the user's desktop (Electron 45 async `clipboard.readText`, Wayland focus rules, clearing CLIPBOARD + PRIMARY) | Tested with a fake platform and a fake Electron clipboard (`src/main/core/clipboard.ts`) only. Wayland answers only while the window is focused: detection checks on focus and every second while focused; a read that does not answer in 2 s is abandoned. Only HS256 JWTs are offered (GMI keys per RESEARCH.md): if real keys differ, detection stays silent and "Paste it instead" still works. |
| Connect dialog focus and the success hold in the real window | `initialFocus` (next action, not the X) and the pointer hold are not covered by unit tests (react-dom/server runs no effects; no DOM test environment) nor by the offscreen screenshots (no input). Check by hand with the user: Enter on Welcome → Enter opens GMI Console; hovering the success view keeps it open. |
| GMI brand pass in the real window (D16/D17) | Checked in offscreen screenshots and an offscreen splash render only. Not seen live: the splash → Welcome glide, hover/focus/press states, toasts, the Dino animations at real frame rates, and the taskbar icon (on Wayland, GNOME/COSMIC take the icon from a `.desktop` file matching the app id, not from `BrowserWindow.icon`, so it may only appear once packaging adds one). Check with the user in `npm run dev`. |

## Known limitations (accepted for now)

- Signed out with no key, the LLM list is GMI's public featured list + leaderboard (includes `anthropic/*` that the
  org's MCP catalog does not list); it corrects itself after sign-in or a key.
- GMI reports no per-job media cost; media spend shown is the app's own estimates (this device only).
- Chat replies without a usage chunk (stopped, timed out, or the GMI Router sent none) are costed from a text estimate and
  flagged `usageEstimated` on the message. Spend-ledger entries (`SpendEntry`, `contracts/usage.ts`) have no such flag, so
  Usage › This device shows those amounts as exact (chat fixer follow-up 1, not applied yet).
- Discounts: an MCP/models-API LLM price without `discount_to_user` is treated as no discount.
- Coding Plan / Studio subscription status is not shown (no API outside the console session).
- Background catalog refresh relies on timers plus a 5-minute wall-clock check and `powerMonitor` resume/unlock.
- Mock mode only: prompts containing "simulate an error" trigger a demo 429; placeholder media say "DEMO".
- No packaging, auto-update, code signing or app icon yet. Fixed 1360×880 screenshot window. Narrow layouts: the Models page
  has a manual CDP check (`node test/catalog/models-layout.cdp.mjs .agent-builds/<name>` after a screenshot build;
  980–1360 px; not in vitest; leaves `/tmp/gmi-desk-shots-<pid>` profiles to delete); other pages were reasoned from
  CSS and checked with temporary overrides.

## Review outcome (2026-11-01)

| Area | Confirmed/partial findings | Outcome |
|---|---|---|
| foundation | 18 | 14 fixed by the foundation fixer; foundation-34 (temp-file sweep) finished by the media fixer; foundation-40/41 (sign-in feedback) and foundation-54 (contrast tokens) finished by integrator follow-ups |
| auth | 5 (+ keychain-locked adaptation, budget confirm) | all fixed |
| catalog | 12 | all fixed |
| chat | 10 | all fixed |
| media | 7 | all fixed (media-4 split between foundation and usage) |
| usage | 1 | fixed |

Full findings, verifier reasoning and fix notes are in the maintainer's local run archive (`docs/history/`, not in
the repo).

## Backlog (priority order)

**User decision (2026-11-02):** next build **Compute** (GMI Cluster Engine containers + Agentbox sandboxes managed in
the app, with a live side-by-side "computer" panel: terminal, files, ports, usable by the user or an agent), then the
**Code tab** (T3-style parallel repo threads on git worktrees) on a **real coding harness** (OpenCode/Droid-like:
tool loop, compaction, caching, permissions, MCP) so GMI models are used efficiently — "production grade, used at
scale, audited for security, proper loop engineering, MCP integrations". Research in `docs/research/`
(cluster-engine, agentbox, harness), design in `docs/design/`. Items 3–4 below are superseded by that plan; the live
test session (1) and packaging (2) still apply.

1. **Live test session with the user** (see table above). Needs the user at the machine; if they are not available,
   do item 2 first.
   - **Prep (no user needed, free):** the app logs only failures. After the real sign-in on 2026-11-01, `main.log`
     held just the startup line, so a paid test would capture nothing. First change: a dev-only trace switch, added to
     `DEV_ENV_VARS` in `src/main/core/dev-env.ts` (so packaged builds strip it), that appends raw responses (never
     headers, tokens or keys) to `<userData>/logs/trace-*.jsonl` from `callTool` in
     `src/main/services/auth/mcp-gateway.ts`, `readStreamParts` in `src/main/services/chat/stream-common.ts` (chat,
     Responses and router streams) and the `/v1/models` fetch in `src/main/services/catalog/sources.ts`. Test it in
     mock mode; `npm run check`.
   - **Session:** `npm run dev` with the trace on. The user is already signed in (Settings → Account; if it asks to
     reconnect, the user approves in the browser). Before any paid call, set Usage → Budgets (e.g. daily $1, enforce).
     The user adds an inference key themselves with **Connect chat** (top bar): Open GMI Console → create + copy →
     "Use this key" (validation is a free GET); the paste path is the fallback (never into the chat or your shell).
     Check Settings › API key › "Chat with your GMI sign-in" shows `Not yet` (the probe's 401) or `Available`. Then, each with the
     user's explicit OK in the conversation: one chat on a cheap model, one Auto (router) reply, one cheap image (the
     estimate is free; show it first). Optional: one upload (`upload_media`: the file becomes a **public** URL, so use
     a throwaway image). Sign out at the end only if the user wants to (this tests revoke).
   - **After:** compare the trace with `normalizeModelsApi` (`catalog/normalize.ts`), `stream-router.ts`,
     `stream-chat.ts` / `stream-responses.ts` and `parseGeneration` / `parseUploadSlot` (`media/parse.ts`); fix
     differences with regression tests; add sanitised fixtures under `src/main/mock/fixtures/<slice>/` (ground rule 6);
     update the tables above and the Timeline.
2. **Packaging:** electron-builder (AppImage + deb first; the user runs Linux), app icon, `@electron/fuses` per the
   checklist in docs/ARCHITECTURE.md, then auto-update (electron-updater) once there is a release channel. Can run
   without the user except for two decisions: the deb maintainer (deb builds fail without an `author` email in
   package.json or `linux.maintainer`; none is set, so don't invent one or use GMI's name) and the icon (no GMI logos).
   - **First change:** `electron-builder` as a devDependency + `electron-builder.yml` (or a top-level `build` key in
     package.json): `appId: ai.gmidesk.app` (= `APP_ID` in `src/shared/app.ts`, also the OAuth `software_id`),
     `directories.output: release` (the default `dist/` is Vite's output; `release/` is already gitignored),
     `files: [dist/**, dist-electron/**, package.json, "!**/*.map"]`, asar on, fuses in an `afterPack` hook; script
     `dist:linux` = `npm run build && electron-builder --linux AppImage deb`. Main/preload are fully bundled by esbuild
     (only `electron` is external), so runtime `dependencies` need not ship in the asar.
   - **Verify:** `npm run check`, build, `npx @electron/fuses read --app <binary>`. Launching the package needs the
     user's OK: a packaged build strips `GMI_DESK_USER_DATA`/`GMI_DESK_MOCK`, so it opens the user's real signed-in
     profile `~/.config/GMI Desk/` (only `GMI_DESK_LOG_LEVEL` still works). Check that app:// loads from the asar, the
     sign-in survives, and Settings → Security shows the OS keyring.
3. **Agents tab (GMI Agentbox):** list templates/sandboxes, launch with cost estimate, logs, exec, terminal (WebSocket
   proxied through main to xterm.js), pause/resume/delete. Needs a Compute (`ce_resource`) key until GMI adds an
   OAuth scope. APIs: Agentbox v1 `https://api.gmi-serving.com/v1/agents/*` (Python/Go SDKs, beta) or Sandbox v2
   `https://console.gmicloud.ai/api/v2` (stable OpenAPI spec).
4. **H4 sandbox MCP + agent-driven computer** (harness.md §10.4): expose the compute broker to the host RPC so an
   agent can create/use a sandbox and drive the computer panel, then the H4-B/C work. The Code tab itself is built
   (H3); the remaining H3 items are the paid-tool spend ledger and MCP transports (D27, D28).
   Factory Droid only as an optional "bring your Factory account" agent (closed source, needs a Factory login).
5. **"GMI" agent for the ACP Registry** so T3 Code / Zed / JetBrains users get GMI in one click.
6. **Smaller items:** thread title in the top bar's left side (chat), app-wide palette command slot, chat search in
   the sidebar, export/import of chats, i18n, a DOM test environment (e.g. happy-dom) for renderer effects (Connect
   dialog start/stop of key detection, initial focus), an inference-audience token once GMI publishes protected-resource
   metadata for api.gmi-serving.com (docs/GMI-ASK.md).
7. **Publishing follow-ups (2026-11-27):** after the first push, watch CI on GitHub. Small polish left: the
   leaderboard's narrow column headings sit tight; `.gmi-markdown` is unlayered CSS (overrides need `!`), moving it into
   `@layer components` would touch every Markdown consumer.
