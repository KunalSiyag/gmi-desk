# Compute: Cluster Engine containers, Agentbox sandboxes and the live "computer" (design, 2026-11-02)

**Status:** design, ready to implement as phases **C1** (core) and **C2** (computer panel). Nothing in it has been
built. **Inputs:** [research/cluster-engine.md](../research/cluster-engine.md) (CE),
[research/agentbox.md](../research/agentbox.md) (AB), [research/harness.md](../research/harness.md),
[RESEARCH.md](../RESEARCH.md), DECISIONS D1–D18. The companion design for the GMI gateway, the agent harness and the
Code tab is [harness.md](harness.md). The two documents share the foundation changes in §13.2, built by the shared
slice **F0** (§21.0).

**Revision (2026-11-02, after review).** Two adversarial reviews (lenses security-cost and reliability-loop) of this
document and harness.md produced 66 findings. Each was checked against the research, the code and, where it made a
claim about this machine, by reproducing it. All are folded into the sections below. §23 is the review log for the
findings on this document; harness.md §26 logs the rest.

**User request (2026-11-02):** "Currently no option to setup cluster engine… Why do we have to open gmi studio online…
it would be goated if we could also show the container that we created side by side as a grok bot computer in case
someone wants to use it." The user then asked to "go with items 1 and 2": (1) Cluster Engine containers managed in the
app, and (2) the created container or sandbox shown side by side as a live computer.

**Markers** (same as the research): `[V]` verified (the source is cited in the research doc), `[I]` inferred, `[U]`
unverified. Every `[U]` that the design depends on is listed in §20 with the cheapest probe that settles it.

---

## 0. Summary

1. **New `compute` slice.** It covers GMI Cluster Engine (CE) **containers** (`console.gmicloud.ai/api/v1/containers…`)
   and Agentbox **sandboxes**. Sandboxes use the **Sandbox API v2**: the control plane is `console.gmicloud.ai/api/v2`
   and the data plane is `https://{sandbox_key}.{domain}`. The v1 gateway is not used.
2. **Compute key.** A `ce_resource` key is added through **Connect Compute**, the same clipboard flow as Connect chat
   (D14/D15). The **auth slice** owns it, stores it in `ctx.secure` as `compute.key`, and hands it to other slices only
   through `ComputeKeyProvider`. Neither the renderer, the harness nor any container ever sees it. With a weak keyring
   (`basic_text`) it stays in memory for the session unless the user confirms storing it.
3. **Browsing works signed out.** Data centres, official templates and hourly list prices come from GMI's key-less
   public feeds. Descriptions are dropped and customer-specific SKUs are filtered out.
4. **Paid and risky actions are approved in main.** Anything that starts billing (create, resume, an extension beyond
   the approved lease, an EIP) is priced live and needs a **native confirmation shown by the main process**. So do
   opening a container to more than one IPv4 address, releasing an EIP, and any lease change that makes a delete happen
   sooner.
5. **CE create is never retried.** It goes through a durable (fsynced) **write-ahead journal**, uses a unique name that
   carries an install tag (`gmid-<inst6>-<slug>-<nonce6>`), and is reconciled by listing. Unresolved entries are never
   pruned. Sandbox create carries an `Idempotency-Key`; after a restart, sandboxes are reconciled only by listing.
6. **The cost guard is app-side.**
   - It estimates spend from hourly price × run time and keeps a lease per resource (max lifetime, then delete / pause
     / notify). Lease and budget actions are retried until they succeed, and a destructive catch-up waits for GMI's
     clock.
   - A **daily budget is required before the first container** (or GPU sandbox), and every projection includes the
     burn of what is already running.
   - Sandboxes are paused when idle, where idle means no user input (and no active agent run): output, polling and
     background preview traffic do not count.
   - Compute spend counts toward the existing daily and monthly budgets through a new `SpendSource`.
   - It raises orphan and unattached-EIP alarms, shows what the whole organization is billing, warns on quit, and
     reconciles at startup.
7. **The computer panel.** It is a dock beside Chat, Code and Compute with four parts:
   - a terminal: a binary-frame PTY bridged by `ws` in main (frame size capped), sent over IPC with ack flow control
     while visible, shown in xterm.js;
   - files: listing via exec, read and write through `/files`, uploads and downloads that go through native dialogs;
   - ports and previews: an isolated `WebContentsView` with an in-memory partition, a URL built and host-locked in
     main, and a per-host traffic-token header;
   - a status and cost ticker.
   Exec slots are held until a remote execution ends, and abandoned executions are cancelled.
8. **The agent drives the same computer (H4).** It goes through the same main-process broker with scoped grants. It
   never gets the key, and it cannot create or delete resources without a native dialog.
9. **New dependencies (C2 only):** `ws@8.22.0`, `@xterm/xterm@6.0.0` and `@xterm/addon-fit@0.11.0`, all MIT. `ssh2` is
   added only if the CE shell probe shows the console shell URL cannot be used.

---

## 1. Goals and non-goals

**Goals**
- **G1: never leave the app for compute.** Browse (signed out) → connect → launch → watch → use → tear down, for both
  CE containers and Agentbox sandboxes.
- **G2: cost-safe by construction.**
  - Price shown and approval given before any billing starts.
  - No double create.
  - Every resource has a lease.
  - Budgets include compute.
  - Orphans and silent EIP billing are surfaced.
  - The quit path warns.
- **G3: a live computer next to Chat and Code.** Terminal, files, ports and previews, status and cost. A person uses
  it today; an agent uses the same broker later (harness.md H4).
- **G4: security first.**
  - The compute key and the data-plane and traffic tokens live only in main.
  - Previews are isolated web content.
  - No third-party data reaches fixtures or logs.
  - A compromised renderer cannot spend.
- **G5: works at scale.**
  - Tens of resources, several open computers, and org-wide lists that include other members' resources (read-only).
  - Flaky APIs: backoff, circuit states, reconcile.
  - Long sessions: reconnect, cold resume.

**Non-goals for C1/C2.** Each gets a console deep link or a later phase.
- MGCS / managed clusters, Slurm, prepaid plans and renewals, bare-metal create, persistent filesystem storage, and
  entitlement requests: console only, no public API (CE §6, §10).
- Container **reconfigure** (`PUT`). It wipes all data `[V]`. Deep link only, so nobody loses data by accident.
- Template building (v2 `/templates` builds, Dockerfile builds): planned for **C3**. C1/C2 use official templates, org
  templates and snapshots.
- Live metrics and events: there is no public API `[V]`. The status bar shows an exec snapshot instead
  (`free`, `df`, `nvidia-smi`).
- The Agentbox marketplace and v1 "deployments". These would be a later Agents page; the v1 gateway is not part of
  C1/C2.
- Popping the computer out into its own window, and multi-window. Later.

---

## 2. Architecture

```
┌──────────────────────────── Renderer (sandboxed, app://gmi-desk, no network, no secrets) ─────────────────────────┐
│ pages/compute/   Resources · Launch wizard · Network · Snapshots · alarm banners                                   │
│ components/connect/ConnectComputeDialog          components/computer/ ComputerDock: Terminal(xterm) Files Ports    │
│        │ gmi.compute.*  gmi.computer.*  (invoke)                    ▲ events compute:*  computer:*                  │
└────────┼────────────────────────────────────────────────────────────┼───────────────────────────────────────────────┘
         ▼ typed IPC — sender must be app://gmi-desk (makeAppUrlCheck); GmiError codes survive                         │
┌─────────────────────────────────────────── Main process (trusted) ─────────────────────────────────────────────────┐
│ auth slice ── ComputeKeyProvider (secure 'compute.key', scope ce_resource)      usage slice ── BudgetGuard + sources │
│                                                                                                                    │
│ compute slice (src/main/services/compute/)                                                                         │
│  CatalogService ── public: /api/v1/idcs, /api/v1/public/templates, /api/v1/billing/products  (key-less)            │
│                └── account: /api/v1/containers/products?idc=, /api/v1/templates, v2 /products, v2 /templates        │
│  CeClient ─────── /api/v1/{containers, elastic-ips, firewalls, me/ssh-keys}           (Bearer compute key)          │
│  SandboxClient ── /api/v2/{sandboxes, snapshots}  (+Idempotency-Key)                    (Bearer compute key)          │
│  DataPlane ────── https://{sandbox_key}.{domain}/{executions, files, shell}              (X-Access-Token, memory)   │
│  Registry (data/compute-resources.json) ◄── Supervisor (adaptive polling, reconcile, state machine)                 │
│  CreateJournal (write-ahead) · NetworkSaga (EIP/firewall) · Sweeper (orphans, EIPs) · CostGuard (leases, idle,     │
│  budgets, alarms, SpendSource) · QuitCheck                                                                         │
│  Computer: SessionManager ─ ShellBridge(ws, binary, ack) · FileService(exec+files) · PortScanner · PreviewManager  │
│  ComputeBroker (H4: scoped grants for the harness's sandbox MCP; shares the exec semaphore)                        │
│                                                                                                                    │
│ core/preview-host.ts ── one WebContentsView per preview, in-memory partition, nav lock, header injection          │
│ core/notifications, core/shutdown (quit check), ctx.http (UA, error mapping), ctx.secure (safeStorage)             │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
      │ HTTPS (Cloudflare-fronted, UA GMI-Desk/<v>)                     │ WSS (binary PTY)        │ HTTPS previews
      ▼                                                                 ▼                         ▼
 console.gmicloud.ai/api/{v1,v2}                         {sandbox_key}.{domain}/shell/connect   {port}-{sandbox_key}.{domain}
```

**Main data flows**

1. **Browse.**
   - The renderer calls `compute.getCatalog()`.
   - Main serves the cached catalog right away. Within 6 h and on request it refreshes the public feeds (plus the
     account feeds when a key exists), sanitises them (§5.2) and emits `compute:state`.
2. **Create.**
   1. The renderer calls `quoteCreate(spec)`. Main validates the spec, prices it, checks the budget and returns a
      `CreateQuote`.
   2. The renderer shows the review step and calls `create(quoteId)`.
   3. Main shows the **native** confirmation, writes a journal "intent", then sends the POST exactly once.
   4. Main records the resource in the registry, the supervisor polls, and main emits `compute:resources`.
3. **Use.**
   - The renderer calls `computer.open(resourceId)`.
   - The session manager asks for a data-plane token (`connect`) and opens the shell WebSocket.
   - Output flows as `computer:terminal` chunks; input flows back as `terminalInput` invokes. Files and ports run
     through `exec` and `/files`.
   - User-originated operations record activity with the cost guard (§9.5); app-originated ones do not.
4. **Guard.**
   - Every 60 s and on power resume, the guard works out accrual, leases, idle state and budgets, and applies the
     resulting actions: warn, pause, delete or notify.
   - The sweeper runs at startup and every 10 min.
   - Alarms go out as `compute:alarm` events and desktop notifications.

---

## 3. Decisions (to record as D19–D21, see §22)

| # | Decision | Why | Rejected |
|---|---|---|---|
| DC1 | The **auth slice** owns the compute key. Other slices get it only through `ComputeKeyProvider`. | One reviewed place for every credential: safeStorage, locked-keychain handling, clipboard detection (D14/D15). | A key store inside the compute slice (a second credential code path). |
| DC2 | Sandboxes use **v2 control + data plane** only. | (a) Proper OpenAPI 3.0.3 spec, not labelled Beta. (b) `Idempotency-Key` on create and exec, so retries cannot double-spend. (c) Explicit `timeout`, default 300 s; v1 defaults to a 24 h TTL that renews itself and can bill forever. (d) `secure` port tokens. (e) `egress_control` allowlist. (f) Binary PTY frames that xterm.js reads directly. (g) `metadata[k]=v` list filter for the orphan sweep. (h) Typed failure, pause and deletion reason codes. (i) Range downloads. Prices come from the **public billing feed** (`gmi.sandbox.*` SKUs) because v2 `/products` has no price. | v1 gateway (Beta shell with JSON frames, 24 h auto-renew, no idempotency); running both (two state machines, and whether a v1 task is the same record as a v2 sandbox is unknown `[U]`). |
| DC3 | CE create: **never retried automatically**. A journal entry is written before the POST; the name is unique (`gmid-<slug>-<6 base32>`); `count: 1`; on an unclear outcome the app lists and matches by name. | CE has no idempotency key; `count` is billed per container; a retried POST double-bills `[V]`. | Retrying with backoff; trusting a timeout as "not created". |
| DC4 | Every action that **starts or extends billing** beyond what was approved needs a **native confirmation from main**. The renderer review step is UX only. | Same rule as D8 (loosening needs a native dialog), applied to spend: a compromised renderer cannot launch $28/h hardware. | Renderer-only confirmation (as media does): too weak for compute's blast radius. |
| DC5 | **Leases.** Sandboxes are bounded by the server (`timeout` + `on_timeout`). Containers are bounded by the app (lease, then delete or notify), plus the quit check and a catch-up at startup. | CE has no server-side TTL or stop `[V]`; sandboxes do `[V]`. | No lease (a GPU box left running overnight costs $46.90 per 1×H200); relying only on budgets. |
| DC6 | Compute spend joins budgets through a **`SpendSource`** (live accrual). It does not write ledger entries. | Accrual is continuous. Appending per-hour entries would flood the 20k-entry ledger and evict history. | One ledger row per hour per resource. |
| DC7 | Computer transport: **sandboxes use the v2 data plane**. **CE containers use the console shell `urlPath`** if probe P-CE shows a usable WebSocket; otherwise **SSH (`ssh2`)** through an EIP plus a firewall limited to the user's IP. | The sandbox data plane is fully specified; the CE shell protocol is unknown `[U]`; SSH costs money and opens a port. | SSH for everything (EIP cost and exposure for sandboxes that do not need it). |
| DC8 | Previews run in a **`WebContentsView`** with an **in-memory partition**. It is never an iframe in the renderer. Overlays hide it and show a captured image instead. | Untrusted web content must not share origin, session or IPC with the app; `app://` and `gmi-media://` are not registered on that partition. | `<webview>` (blocked by `will-attach-webview` today); `<iframe>` (CSP `frame-src 'none'`, same renderer process). |
| DC9 | The terminal stream uses the **existing invoke/event IPC** with ack-based flow control. There is no new preload channel in C2. | Keeps the preload surface unchanged (one reviewed bridge). Measured needs, about 5 MB/s of output, fit easily. | A MessagePort per terminal (a possible later optimisation, kept behind the same API). |

---

## 4. Credentials: Connect Compute

### 4.1 Flow (the dialog mirrors Connect chat, D14/D15)

1. **Explain.** "A Compute key lets GMI Desk create and manage containers and sandboxes for your whole organization.
   It stays in your OS keychain; GMI Desk asks before anything that costs money." Recommend a dedicated key named
   `GMI Desk – <hostname>` so it can be revoked on its own.
2. **Open GMI Console** at `consoleUrl('computeApiKeys')` (`/user-setting/ce/access/api-keys`, already in
   `CONSOLE_PAGES`).
3. **Clipboard detection.** It runs only while the dialog is open (`startKeyDetection('compute')`).
   - It uses the same filters as D15: one token, HS256 JWT, no foreign issuer, not the stored inference key, not the
     stored compute key, not dismissed.
   - Compute keys are assumed to be the same JWT type as inference keys `[U]`. If they differ, detection stays silent
     and "Paste it instead" still works.
4. **"Use this key".** Main validates with `GET {consoleApi}/me/api-keys/current`.
   - `scope === 'ce_resource'`: store the key.
   - `scope === 'ie_model'`: say "This is an inference (chat) key" and offer "Use it for chat instead" (the inference
     key path), without storing it as the compute key.
   - Otherwise: show the error.
   - Then clear the clipboard only if it still holds the key (same as D14).
   - **Weak keyring:** when the `safeStorage` backend is `basic_text` (already detected, `src/main/index.ts`), the
     compute key, which carries org-wide spend authority, is kept **in memory for this session only**, unless the user
     confirms in a native dialog that it may be stored under the weak built-in key. Connect Compute says so.
5. **Entitlement probe** (free GETs, 10 s each, no retries):
   - Containers: `GET /api/v1/containers`. 200 → `entitled`; 403 `tenant has no permission` → `not_entitled`;
     401 → key invalid.
   - Sandboxes: `GET /api/v2/sandboxes?page_size=1`, with the same mapping.
6. **Success view.** It shows what is enabled: containers ✓/✗ ("Contact GMI support to enable", with a console
   link) and sandboxes ✓/✗.

### 4.2 Contract changes in the auth slice (all additive)

The changes are in `contracts/auth.ts` (§13.2):
- `AuthState.computeKey?: ComputeKeyInfo`.
- `LockedSecret` gains `'compute_key'`.
- `KeyDetectionState.target?: 'inference' | 'compute'`.
- `AuthApi` gains `setComputeKey`, `removeComputeKey` and `revalidateComputeKey`, and `startKeyDetection(target?)`
  (the default stays `'inference'`). `useDetectedKey()` stores the key for the active target.

`core/services.ts` gains `ComputeKeyProvider` (§13.2), which follows the `KeyProvider` pattern:
- `getComputeKey()`; `requireComputeKey()`, which throws `no_compute_key`.
- `reportInvalidComputeKey(reason, key, status)`:
  - A 401 marks the key `invalid` and raises a `key_invalid` alarm.
  - A 403 is never treated as a dead key: it means `not_entitled` or a permission problem.
- `onChange()`.

**Revalidation.** At startup, at most once every 24 h. A 401 on any compute call is reported. A locked keychain gives
`status: 'unverified'` plus `lockedSecrets: ['compute_key']`. **Removal** deletes the secret and keeps the registry:
resources keep running and billing, which the UI says plainly. Their rows become read-only until a key is added.

---

## 5. Catalog (signed out and signed in)

### 5.1 Sources

| Source | Endpoint | Auth | Refresh | Used for |
|---|---|---|---|---|
| IDCs | `GET /api/v1/idcs` | none `[V]` | 6 h + on open | data-centre picker (`full` and `maintenance` greyed out) |
| Public templates | `GET /api/v1/public/templates` | none `[V]` | 6 h | official container templates (4 `[V]`) |
| Public products | `GET /api/v1/billing/products[?dataCenter=]` | none `[V]` | 6 h | hourly list prices for container, sandbox and EIP SKUs |
| Account products | `GET /api/v1/containers/products?idc=` | compute key | on wizard open, per IDC | **the launchable set** for this org |
| Org templates | `GET /api/v1/templates` | compute key | on wizard open | org-owned container templates (`credential.secret` dropped) |
| Sandbox products | `GET /api/v2/products?idc_name=&resource_type=sandbox` | compute key | on wizard open | sizes and availability (no price `[V]`) |
| Sandbox templates | `GET /api/v2/templates?idc_name=` | compute key | on wizard open | templates the org can launch |
| EIP products | `GET /api/v1/elastic-ips/products?idc=` | compute key | on demand | whether public access is possible in that IDC |

- **Cache:** `data/compute-catalog.json`, written atomically.
- **Each source is optional** and keeps its last good data. This is the D7 pattern; `sources` reports `ok` / `stale` /
  `error` / `skipped` for each one.
- **Never used:** `/api/v1/public/gpu-available` (its 503 leaked internal infrastructure `[V]`) and
  `/billing/retail-prices` (does not match SKU prices `[V]`).

### 5.2 Sanitiser (`services/compute/sanitize.ts`). Every rule has a test.

1. **Descriptions** of public product rows are read in memory **only to filter**. They are never stored, logged,
   emitted or written to fixtures: they name third-party customers `[V]`.
   - A row is dropped when its description or name matches `/\bonly\b|\bfor\b.*\bteam\b|internal|test|poc|trial/i`.
   - A row is also dropped when `valid !== true`.
2. **SKU allowlist** (public feed): `^gmi\.(container\.(nv|intel|amd)\.|sandbox\.|eip\.|sole\.)`. Anything else is
   dropped.
3. **Signed out, offers are aggregated** as `(kind, gpuModel, gpuCount, idc)`, showing the lowest list price as "from
   $X/h". No raw SKU id is shown (`ComputeOffer.sku = null`).
4. **With a key**, offers are exactly the rows returned by `/containers/products?idc=`. These are already filtered by
   entitlement for the org `[I]`. Prices come from the public feed, joined on `name == instanceType` `[I]`. If a SKU
   has no price, the offer shows "price unknown" and **cannot be launched** while budgets are enforced (§9.1).
5. **Templates:** `credential` is removed entirely. Description text is kept only for `official: true`.
6. **Resource responses** (`containersResp`, v2 detail):
   - `envs[].value` → removed. Only names cross IPC.
   - `traces` → logged at debug level only, never shown.
   - The shell `urlPath` → never logged or emitted.

---

## 6. Containers (Cluster Engine)

### 6.1 Launch wizard

The steps are **what → where → size → options → review**:
- **what:** a template (official, org, or a custom image path).
- **where:** an IDC.
- **size:** an offer.
- **options:** name, env, ports, SSH, access, lease.

Validation runs in the renderer for feedback and **again in main**, which is authoritative:
- The name pattern `^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$`. The final remote name is
  `gmid-<inst6>-<slug(displayName, 24)>-<nonce6>`: `inst6` is the first 6 base32 characters of `sha256(installId)`
  (random, not PII), the nonce is lowercase base32. The install tag lets the sweep recognise this install's containers
  without a journal entry (§7.5).
- Env names `^[a-zA-Z_][a-zA-Z0-9_]*$`, at most 64 variables, each value at most 64 KiB (the API allows 1 MiB; this app
  caps lower).
- At most 5 ports, in the range 1–65534.
- The template exists, the IDC is `available`, and the SKU is in the account's product list.

**Secret env values** stay in main memory only. They are attached to the quote, and later to the create request, then
dropped. They are never written to the journal or registry. The **GMI inference key, OAuth tokens and compute key can
never reach a container**:
- after trimming, main rejects any env value, `command`, argument or service command (`startService`) that
  **contains** a stored secret (inference key, OAuth access or refresh token, compute key) as a substring, so
  `Bearer <key>`, `KEY=<key>` and JSON holding the key are refused too. The H4 broker applies the same check to
  `sandbox_exec`, `sandbox_write` and `sandbox_start_service` inputs;
- the wizard warns when a value is JWT-shaped.

### 6.2 Quote → approval → create (write-ahead journal)

```
 quoteCreate(spec) ──► validate ─► price (offer + EIP) ─► budget gate (§9.3) ─► CreateQuote{quoteId, expires 5 min}
 create(quoteId) ──► quote valid? ─► platform.confirm(native: "Create 1×H200 in asia-east-taiwan3 · $3.35/h list ·
                    auto-delete after 4 h (≤ $13.40) · if the budget runs out: keep running and notify ·
                    public SSH: +$0.10/h until released · open to 203.0.113.7/32 on TCP 22")
     declined ─► GmiError('cancelled')
     confirmed ─► journal.append({rid, state:'intent', name, kind, idc, sku, at})
                  (durableWriteFile: write, fsync the file, rename, fsync the directory)
               ─► journal 'sent' ─► POST /api/v1/containers {count:1, name, idc, product, templateId, envs, ports,
                  sshKeyIdList} (ctx.http retries:0, timeout 60 s)
                    200 + body [{id}]                                   ─► 'confirmed' ─► registry.add ─► supervisor.watch
                    400/401/403/404/422 with a parsed GMI error body    ─► 'failed' (definitely not created) ─► GmiError(mapped)
                    anything else: 409, 429 (e.g. Cloudflare), 5xx, timeout, network, an HTML challenge page,
                    a 200 whose body is not [{id}]                      ─► 'unknown' ─► reconcile
 reconcile(rid): GET /api/v1/containers → exactly one item with name == journal.name ─► 'confirmed'
                 none: retry the GET at +5 s, +15 s, +45 s, +120 s ─► still none ─► 'failed_unknown'
                       ─► alarm create_unknown; re-checked on every 10-min sweep until found (adopted) or resolved
                 more than one (impossible by name nonce) ─► adopt all, alarm
 startup: every journal entry in intent | sent | unknown | failed_unknown ─► reconcile before anything else
```

- **"Try again"** after `unknown` or `failed_unknown` first lists the containers, then shows a native dialog: "An
  earlier attempt (`<name>`) may still appear in your organization and bill. Create another one anyway?" A new name is
  used.
- **The journal** is `data/compute-journal.json`, written with `durableWriteFile` (§13.2; today's `atomicWriteFile`
  renames without an fsync, so a power loss after the POST could lose the `sent` entry). Entries in `unknown` and
  `failed_unknown` are **kept until resolved**: found and adopted, or dismissed by the user after a confirmation. Only
  `confirmed` and `failed` entries are pruned, after 7 days. The 200-entry cap never drops an unresolved entry.
- `maxUsd` is the list price × the lease length. With `maxLifetimeMin: null` the check uses 24 h, and the dialog says
  "no automatic limit".

### 6.3 Public access: EIP and firewall saga (optional, priced separately)

**Offered** only when `/elastic-ips/products?idc=` returns a product for that IDC. The public feed lists only 2 EIP
SKUs today `[V]`.

The wizard's **"How will you reach it?"** choices:
- **"In GMI Desk (no public IP)"** (default). Uses the CE shell via `urlPath`, if P-CE confirms it (§8.8), plus logs.
- **"SSH from this computer"**. Needs an EIP and a firewall allowing TCP 22 from `<your IPv4>/32`.
  - The user enters the IPv4 address. The **Detect** button is opt-in: each click makes one call to a public IP echo
    service (third party; disclosed in the UI; never automatic).
  - The "All Open" preset is never the default.
- **"Public HTTP port"**. EIP plus a firewall for the listed ports, with the same CIDR rules and a warning.

**CIDR rules, enforced in main** (create and `updateFirewallCidr`):
- IPv4 CIDRs only. Reserved ranges are rejected (`0.0.0.0/8` other than `/0`, `127.0.0.0/8`, `169.254.0.0/16`,
  `224.0.0.0/4`, `240.0.0.0/4`).
- Any rule broader than `/32` is treated as **open**, whatever `allOpen` says, and `0.0.0.0/0` is labelled "All Open:
  anyone on the internet". An open rule needs a native confirmation in create and in `updateFirewallCidr`.
- The native create dialog always lists every exposed port and CIDR (official templates pre-expose 22 and 8888).

**Saga.** Each step is journaled, never retried automatically, and checked by a GET before it runs:
```
1 create container ─► wait running (poll; 20 min cap ─► alarm)
2 POST /v1/elastic-ips {idc, count:1, name:"<name>-eip", product}      (paid; included in the same approval)
3 POST /v1/elastic-ips/{id}/associate {instanceID, instanceType:"container"}
4 POST /v1/firewalls {idc, name:"<name>-fw", inboundRules:[{protocol:tcp, portRange:{min,max}, remoteIpPrefix}]}
5 POST /v1/firewalls/{fw}/associate {instances:[id], instanceType:"container"}
failure at 3–5 ─► container kept; network:'degraded'; alarm with "Retry network setup" | "Release EIP ($0.10/h)"
```

**Teardown** (`delete` with `releaseEip`), in this order:
1. Disassociate the firewall.
2. Disassociate the EIP.
3. `DELETE` the container.
4. Poll until 404.
5. Release the EIP (only if the app allocated it and the user ticked "release").
6. Delete the firewall (only if managed and nothing else is attached).

An EIP that is kept raises the `eip_unattached` alarm.

**"Update firewall to my current IP"** replaces the rule (`PUT /firewalls/{id}`). A `/32` replacing a `/32` needs only
the renderer confirmation; anything broader is open and needs the native one. It exists because laptops change
networks.

### 6.4 Other container actions

- **Restart:** `POST /restart`. Renderer confirm: "files outside mounted storage may be lost" (`[U]`, P-CE). There is
  no budget check because billing does not change.
- **Delete:** native confirmation (destructive). PAYG only; the console refuses deleting while creating or
  terminating `[V]`, so the button is disabled in those phases.
- **Logs:** `GET /logs` returns the whole text, with no tail option `[V]`.
  - Range support is probed once per resource (`Range: bytes=-1048576`) and cached as `rangeSupported` `[U]` (P-CE).
  - With Range, the Logs tab polls every 10 s while visible and keeps the last 1 MiB.
  - Without Range, the body is read as a stream through a 1 MiB ring buffer and the rest is discarded. When
    `Content-Length` (or the bytes read) exceeds 10 MB, auto-polling stops and the tab offers Refresh or a 60 s poll.
    A training job's multi-GB log never sits in main's memory.
  - "Save full log…" uses a native save dialog (streamed to disk).
- **Console deep links** for reconfigure, renew, monitoring and prepaid use the additive `consoleDeepLink(kind, id)`
  (§13.2): ids are validated as UUIDs and the paths come from a fixed list.

### 6.5 Status mapping (CE → `ComputePhase`)

| CE `status` | Phase | Billed (guard) | Note |
|---|---|---|---|
| `creating` | `creating` | yes `[U]`; conservative | |
| `running` | `running` | yes | |
| `terminating` | `busy` if a restart is pending, `deleting` if a delete is pending, else `busy` ("Restarting…") | yes until 404 | |
| `stopped` | `unknown` + reason "Stopped by GMI" | yes `[U]`; conservative | no API action produces it `[U]` |
| `error` | `failed` (+ `reason`) | yes until deleted | CE keeps the pod; the user must delete it |
| `zombie` | `failed` ("GMI reports this container as orphaned") | yes | |
| `unknown` / anything else | `unknown` | yes | unknown values are accepted |
| 404 | `deleted` | no | |

### 6.6 Supervisor (polling)

- **One list call per backend.** `GET /api/v1/containers` (no pagination `[V]`) and
  `GET /api/v2/sandboxes?metadata[app]=gmi-desk` (paged, 100 per page), plus unfiltered pages when "Show all in
  organization" is on.
- **Cadence:**
  - every 5 s while any managed resource is transitional;
  - 30 s while a computer is open;
  - 60 s otherwise;
  - 120 s while the window is hidden;
  - none while suspended (`powerMonitor`), then an immediate run on resume.
- **Errors.** Jittered exponential backoff on 429 and 5xx: 2 s → 5 min, honouring `Retry-After`. After 5 consecutive
  failures `apiHealth` is `degraded`; after 30 minutes of failures it is `down`, with a banner.
- **Per-resource mutex.** One mutation at a time per resource; `pendingAction` is shown in the UI. Results are
  reconciled against the next poll; a 409 means `conflict` (someone else changed it: refresh and show).
- **Clock skew.** The HTTP `Date` header of GMI responses gives an offset. If it is more than 2 min, leases use
  server time and Diagnostics shows a warning.

---

## 7. Sandboxes (Agentbox, Sandbox API v2)

### 7.1 Create

```
POST /api/v2/sandboxes   Idempotency-Key: <rid>   (rid = app resource id, uuid; GMI remembers it 24 h [V])
{ template_id | snapshot_id, product, idc_name?, timeout: <explicit 60..86400>, auto_pause: onTimeout=='pause',
  secure: true, env_vars: {…secret values from memory…},
  metadata: { app:"gmi-desk", inst:<installId 16 hex>, rid:<rid>, purpose:"computer"|"agent", thr?:<thread id 8 chars> },
  egress_control?: true, egress?: { allowed_hostnames, allowed_cidrs } }
```

- **Retries are allowed only with the same key, in the same process, inside the original 2-minute window:** at most 3,
  for network errors and 503 before any response. `Sandbox.IdempotentParameterMismatch` is a bug (alarm).
  `Sandbox.IdempotentKeyConsumed` → reconcile by `metadata[rid]`.
- **After a restart, sandboxes are reconciled only by listing**, never by re-POSTing (GMI remembers the key for 24 h
  only `[V]`): `GET /sandboxes?metadata[rid]=<rid>` with a `state` filter that includes `deleted` (the default list
  excludes it `[V]`; whether `state` takes several values is `[U]`, else one call per state). A sandbox that was created
  and then expired is found as `deleted` and its accrual closed at `deletion.requested_at`.
- **Journal and native confirmation** work as in §6.2. The price comes from the public feed SKU equal to `product`
  (for example `gmi.sandbox.small` $0.0911/h `[V]`).
- **Defaults for purpose `computer`:**
  - `timeoutSec` 3600, `onTimeout` `pause`, `secure` true, egress open;
  - lease `{maxLifetimeMin: 480, idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause'}`.
- **Defaults for purpose `agent` (H4):** **deny-all egress** (`egress_control: true`, empty allowlist), `idlePauseMin`
  10, `onTimeout` `kill`.
  - Hosts are added per thread, each with a native confirmation that says a host which accepts uploads can receive the
    uploaded worktree.
  - `github.com`, `api.github.com`, `uploads.github.com` and `upload.pypi.org` are never allowed by default. The
    install suggestions (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`) are offered, not pre-set, and the
    dialog notes that `registry.npmjs.org` also accepts `npm publish`.
  - An allowlist only limits where data can go, not what is sent; with attacker-supplied credentials an allowed host
    can still receive data (harness.md H-T2).
- **Metadata is visible to the whole org `[V]`.** It must not contain PII: `inst` is a random install id, not the
  hostname or user name. Metadata limits for v2 `[U]`; we send 5 short keys.
- **429 handling:**
  - `Resource.QuotaExceeded` → `quota_exceeded` (never retried; shows quota, used and requested).
  - `RateLimit.Exceeded` with `Retry-After` → `rate_limited`. The app does not retry it either: it asks the user to
    try again.

### 7.2 Data-plane access (tokens)

- `POST /sandboxes/{id}/connect` → `{sandbox_key, domain, sandbox_access_token, traffic_access_token, end_at}`.
- The result lives in a per-sandbox **in-memory** `TokenCache` and is never persisted or emitted.
- **Refresh**, single-flight: on a data-plane 401, after `resume`, after `timeout` changes, and 60 s before `end_at`.
- `connect` answers 409 while paused or transitional and 404 while provisioning, failed or deleted: the session waits
  for the supervisor.
- **`domain` is never built** by the app; it is taken only from `connect` `[V]`.

### 7.3 Pause, resume, extend, snapshots, delete

**Pause:** `POST /pause` → 202, then poll. Pause is free during Early Access `[V]` and unknown afterwards `[U]`.

**Resume:** `POST /resume {timeout}`, with a native confirmation showing the price and the new end time. Afterwards:
- **always assume a cold resume** `[U]`: processes and `/tmp` may be gone (AB §9);
- re-`connect` for a new token;
- reattach the shell;
- set `coldResumed: true` and offer "Restart services" (§8.3).

**Extend:** `POST /timeout {timeout}`.
- Auto-extend runs when `extendOnActivity` is set, user-originated activity (§9.5) happened in the last 10 min, and
  fewer than 10 min remain: +30 min each time.
- It stays within the approved `maxLifetimeMin` and the remaining budget.
- **Beyond the approved lifetime**, `extend()` needs a native confirmation with the price.
- After an extend, refresh the token (the token is re-signed `[V]`).

**Snapshots:**
- `POST /snapshots {sandbox_id, name}`; only from `running` `[V]`.
- Poll until `ready` or `error`.
- Before snapshotting, offer a **scrub step** (exec `rm -rf ~/.git-credentials ~/.config/gh ~/.npmrc ~/.cache/pip`,
  opt-out).
- Snapshot storage price `[U]`, shown as "storage price unknown".
- Delete answers 409 while live children exist `[V]`.

**Delete:** `DELETE` → 200 `deleted` or 202 `deleting`; it is safe to repeat and never answers 409 `[V]`. Native
confirmation; the registry keeps a tombstone for accrual.

### 7.4 State mapping (v2 → `ComputePhase`)

| v2 state | Phase | Billed |
|---|---|---|
| `provisioning` | `creating` | yes `[U]`, conservative |
| `running` | `running` | yes (per second `[V]`) |
| `updating`, `checkpointing` | `busy` | yes |
| `pausing` | `pausing` | yes |
| `paused` | `paused` | no (Early Access) `[U]` later |
| `resuming` | `resuming` | yes |
| `failed` | `failed` (`failure.code` → user-safe reason) | no |
| `deleting` | `deleting` | until `deletion.requested_at` `[V]` |
| `deleted` / 404 | `deleted` | no |
| SDK extras `ready`, `active` → `running`; `error` → `failed`; `cancelled` → `deleted`; anything else → `unknown` | | |

Pause and deletion codes (for example `Sandbox.BillingInsufficientBalance`, `Expired`, `ProviderGone`) map to plain
sentences in `errors.ts`. `initiator: billing` raises a `budget_exhausted`-style alarm: "GMI paused this because your
balance is low."

### 7.5 Orphan sweep (startup and every 10 min)

1. **List** `GET /sandboxes?metadata[app]=gmi-desk&metadata[inst]=<installId>` (all active states plus `failed`) and
   `GET /api/v1/containers`.
2. **This install's resources** are containers whose name starts with `gmid-<inst6>-` or that match a journal or
   registry entry, and sandboxes tagged with this install. Those missing from the registry → adopted as managed with
   the default lease, and alarm `orphan`: "Found a running sandbox from an earlier session ($x/h)", with actions Keep,
   Pause (sandboxes) and Delete.
3. **Journal entries in `unknown` or `failed_unknown`** are re-checked; a late container is adopted (§6.2).
4. **Billed org containers named `gmid-…` with another install tag** (a reinstall, a lost profile, or a colleague's GMI
   Desk) → alarm `orphan` at `warning` severity, read-only, with **Open in console** and **Adopt** (a native
   confirmation: "This may belong to a colleague's GMI Desk"). They are never acted on without that.
5. **In the registry but 404 remotely** → close accrual at the last-seen time (or `deletion.requested_at`) and keep a
   tombstone.
6. **Paused for more than 24 h** → `paused_long` reminder, once a day.
7. **EIPs** (`GET /v1/elastic-ips`) in state `disassociated` → `eip_unattached` alarm with the hourly price ("bills
   until released" `[V]`). This covers every EIP of the org. The app releases only **managed** EIPs, after the user
   confirms; an unmanaged one gets only the alarm and **Open in console**.
8. **Org-wide billing banner** at startup and after each sweep: "N containers · M EIPs are billing in your organization
   ($X/h list)". It counts every billed container and EIP the key can see, because GMI has no spend API; it is the one
   place where a forgotten resource from any source becomes visible.
9. **Never** act on resources that are not this install's without the user's explicit adoption. Other members'
   resources appear under "Show all in organization" as read-only rows with an "Unmanaged" badge.

---

## 8. The computer panel

### 8.1 Sessions

- **One `ComputerSession` per open resource**, owned by main. It holds:
  - a `TokenCache` (sandboxes);
  - at most one remote shell attachment (v2 allows one per sandbox `[V]`);
  - an exec semaphore with **10 slots per sandbox** (v2 allows at most 10 non-terminal executions `[V]`), shared with
    the agent broker (H4) through `ExecPort.acquire({priority: 'user' | 'agent'})`: the user's actions go first, the
    agent gets at most 6;
    - a slot is held **until the execution reaches a terminal state**, not until the HTTP call returns: a 25 s wait
      that times out leaves the execution running `[V]`, so the slot stays taken while main polls
      `GET /executions/{eid}`;
    - every exec sets `execution_timeout_seconds` explicitly;
    - an abandoned execution (the user cancels, the session closes, an agent run is interrupted or its grant revoked)
      gets `POST /executions/{eid}/cancel`;
    - in-flight eids are persisted in the registry; when a session opens or the app starts, they are polled or
      cancelled before any slot is granted;
    - a 429 `Execution.ConcurrencyLimitExceeded` lowers the local capacity to the observed level, then backs off;
  - a 1 MiB output ring buffer;
  - a list of started services;
  - an activity clock, read by the cost guard.
- **`open(resourceId)`** → state `connecting` → `ready`. In that step main runs `connect`, then one exec:
  `printf '%s\t%s' "$HOME" "$(id -un)"` gives the file browser root and the user name.
- **Close.** Sessions close when the last view unmounts plus 5 min (warm reattach), on resource deletion, and on app
  quit.

### 8.2 Terminal (shell bridge)

**v2 protocol** `[V]`:
1. `POST /shell` → 200 `ready|attached` or 202 `creating` (retry after 1 s; this never duplicates the PTY).
2. `wss://{sandbox_key}.{domain}/shell/connect` with `X-Access-Token`, using the `ws` library in main.
3. Frames are **binary only**: raw input bytes up, raw output bytes down. The bridge **never sends a text frame**; a
   text frame drops the connection `[V]`.
4. Resize: `POST /shell/control {action:"resize", cols, rows}`, debounced to 150 ms, sent only while attached. A
   `Shell.ResizeFailed` 502 is retried once.

**Why `ws`.** The browser-style `WebSocket` cannot set `X-Access-Token` and does not expose the HTTP status of a
refused handshake. The 409 `Shell.AlreadyAttached` at handshake is a state the user must see. `ws` gives
`unexpected-response`, custom headers, `pause()`/`resume()` for backpressure, and ping/pong.

**Socket options.** `new WebSocket(url, {headers, perMessageDeflate: false, maxPayload: 1 << 20,
handshakeTimeout: 10_000, followRedirects: false})`. The sandbox is hostile (boundary 4); `ws`'s defaults (100 MiB
frames, permessage-deflate) would let it put a 100 MiB frame or a deflate bomb into main's memory before backpressure
can act. A test sends an oversized frame from the fake server.

**IPC path and flow control** (DC9):
- **Output.** ws `message` → ring buffer → batched every 16 ms or 64 KiB → event
  `computer:terminal {sessionId, seq, data: Uint8Array}`.
- **Ack.** The renderer writes each chunk with `term.write(data, cb)` and calls `terminalAck(sessionId, seq)` every
  64 KiB once xterm has parsed it.
- **Backpressure only while someone is watching.** The renderer reports `terminalVisibility(sessionId, visible)` on
  mount, unmount and `visibilitychange`.
  - Attached and visible: main calls `ws.pause()` when more than 512 KiB is unacked and `ws.resume()` below 128 KiB,
    so a `cat` of a huge file never floods the IPC or the renderer.
  - Otherwise (dock closed, the 5-minute warm period, window minimised or hidden, renderer reloading): main keeps
    reading into the 1 MiB ring (dropping the oldest bytes), emits nothing and **never pauses the ws**. A remote build
    or training script never stalls because nobody is looking.
  - `terminalAttach` resets the unacked count to 0.
- **Input.** `terminalInput(sessionId, data)`, at most 64 KiB per call (the renderer splits large pastes;
  bracketed paste is kept). Main pushes the bytes into a per-session FIFO **synchronously, before any `await`**, then
  encodes UTF-8 and sends binary frames in order, so invokes are never reordered.
- **Reattach.** `terminalAttach` returns `{replay: ring buffer, seq}`, so remounting the dock or navigating away and
  back keeps the screen. The replay starts with a soft reset (`\x1b[!p`), because the ring can begin inside an escape
  sequence or the alternate screen, and is followed by a resize nudge (cols − 1, then cols, through `/shell/control`)
  so full-screen programs such as vim or htop redraw.

**Shell states:**
```
none ─open─► connecting ─open ok─► attached ─ws close (not by us)─► reconnecting ─backoff 0.5,1,2,4,8…30 s─► connecting
                 │ 409 AlreadyAttached ─────────► attached_elsewhere ─"Take over" (native confirm)─► close + new shell
                 │ 401 ─► token refresh ─► connecting (once; then unavailable)
                 │ sandbox paused/resuming ─► paused (wait for supervisor)                       closed ◄─ user close / delete
```

- **"Take over"** sends `POST /shell/control {action:"close"}`, which is irrevocable `[V]`. It kills the other
  attachment's PTY, so it needs a native confirmation.
- **The app never sends `exit`.** On gateway A that kills the session for good `[V]`; it is avoided everywhere.
- **Keepalive.** A `ws` ping every 25 s and a missed-pong timeout of 60 s. The server-side idle timeout is unknown
  `[U]` (P-SB).

**xterm.js options** (renderer):
- `allowProposedApi: false`, `scrollback: 5000`, `convertEol: false`;
- `windowOptions` left at their safe defaults (all off);
- no clipboard addon, so OSC 52 cannot write the clipboard;
- links through `registerLinkProvider`. A click goes to `app.openExternal` (https only) after a confirmation popover
  that shows the full URL; OSC 8 hyperlinks get the same treatment;
- the title (OSC 0/2) is shown only as plain text, at most 80 characters.

**Theme** from tokens (D16/D17): true black / near-white background, GMI greys, a lime cursor in dark and an olive
cursor in light (never lime on light), Geist Mono 13 px.

### 8.3 Files

- **Listing** uses exec. **Paths are never interpolated into commands**: they go in through the exec `envs`, for
  example
  `{"command":"find \"$GMID_P\" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\0'","envs":{"GMID_P":"/root/app"}}`.
  - If `-printf` fails (busybox), the fallback is a `stat -c` loop.
  - Output is NUL-separated and capped at 5,000 entries (`truncated`).
- **Path rules** (client side as well, AB §15.10): absolute, POSIX-normalised, no NUL, no `.`/`..` segments after
  normalisation, at most 4,096 bytes.
- **Read:** `GET /files?path=`, previewed up to 2 MiB. Binary detection: a NUL in the first 8 KiB, or invalid UTF-8.
- **Write** (the editor saves small text, at most 1 MiB): `POST /files` multipart with part name `file`. **A 200 with
  an empty array is an error** `[V]`.
- **Upload:**
  - main opens a **native multi-file picker**, so the renderer never names a host path;
  - `mkdir -p "$GMID_P"` first (the parent must exist `[V]`);
  - then one POST per file, streamed from disk with `node:https` and a byte counter for progress;
  - at most 500 MB per file (AB limit `[V]`); larger files are refused with a hint (split, or fetch from inside the
    sandbox). Error codes: 507 disk full, 413 too large;
  - at most 2 parallel transfers per session.
- **Download:**
  - a native save dialog in main; the default name is the remote **basename**, with separators and control
    characters stripped;
  - written to `<dest>.part`, then renamed;
  - **resume** only when `Accept-Ranges: bytes` **and** the server answers 206; a 200 to a Range request restarts from
    zero `[V]`;
  - files never get an executable bit and are never opened automatically.
- **mkdir, rename and delete** use exec with env-passed paths. Delete needs a renderer confirmation; it removes
  remote data only, so no native dialog is needed.
- Every file operation takes 1 slot of the session semaphore.

**Services.** `startService(name, command, port?)` runs
`nohup sh -c "$GMID_CMD" > /tmp/gmid-svc-$GMID_NAME.log 2>&1 &`, with the command and name in env vars, then waits up
to 30 s for the port (§8.4). It is recorded in the registry so a cold resume can offer "Restart services". This
follows v2's rule that servers must be detached from stdout and stderr `[V]`.

### 8.4 Ports and previews

**Detection** runs every 5 s only while the Ports tab is visible and the window is not hidden. These execs are
app-originated and never count as activity (§9.5).
- One exec: `cat /proc/net/tcp /proc/net/tcp6`, parsed for `st == 0A` (LISTEN). This works in every image; `ss` may
  be missing.
- Optional `ss -ltnpH` for process names when it exists.
- `previewable` = port above 0, and the bind address is not loopback-only.

**Preview URL:** `https://{port}-{sandbox_key}.{domain}{path}` `[V:S1 description]`. Two things are open `[U]`
(P-SB): whether WebSocket/HMR passes through, and which ports are routable.
- Main builds it with `new URL(path, 'https://' + allowedHost)`. `path` must start with `/` (and not `//`), `port` must
  be an integer from 1 to 65535, and the resulting `url.host` must equal `allowedHost` before `loadURL`. A renderer
  `path` such as `@evil.example/` or `.evil.example/` therefore cannot change the host.

**`PreviewHost`** (core, §13.2) creates **one `WebContentsView` per preview**:
- `webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: none,
  devTools: <dev only>, partition: 'gmi-preview-<random>'}`. There is no `persist:` prefix, so the session is
  in-memory and dies with the view. `app://` and `gmi-media://` are **not** handled in that session (a test asserts
  this).
- **Navigation lock.** Top-level navigation must stay on exactly `<port>-<sandbox_key>.<domain>`
  (`will-navigate`, `will-redirect`, **and `did-start-navigation`**, because loads started from main do not fire
  `will-navigate`). Anything else is blocked and reported as `blocked` so the user can open it externally.
  `setWindowOpenHandler` → deny.
- **Request policy** (`session.webRequest`):
  - `onBeforeRequest` cancels anything that is not http(s) or ws(s), and any host that is loopback, private,
    link-local or `.local` / `.internal`. This protects the user's own localhost services, including the Vite dev
    server and a future loopback gateway, from preview pages.
  - `onBeforeSendHeaders` adds `traffic-access-token: <token>` **only** when the URL host equals the preview host
    exactly. It **never** adds `X-Access-Token`.
  - The token lives in main memory only; when it is refreshed, the injector is updated.
- **Permissions:** `setPermissionRequestHandler` → deny all, `setPermissionCheckHandler` → false, `will-download` →
  cancel plus a hint to use Files › Download. A test checks that this also blocks Chromium's Local Network Access
  from a preview, using a public hostname that the test resolver maps to 127.0.0.1 (DNS rebinding: the webRequest
  filter sees only hostnames).
- **Activity:** only input events in the view (`before-input-event`) count as activity; background requests (HMR,
  polling) do not (§9.5).
- **Placement.** The renderer reports the dock slot's bounds with `setPreviewBounds(previewId, rect)` (via
  `ResizeObserver`, throttled with rAF). `null` hides the view.
- **Overlays.** A native view is always drawn **above** the renderer's DOM. While any dialog, popover, menu or the
  command palette is open (the `useUi().overlayCount > 0` counter: F0 adds it to the store, C2-0 wires it into the
  ui kit), the renderer hides the view and
  shows the image from `capturePreview()` in its place.
- **Frame.** A persistent strip above the view shows "Preview of <host> · untrusted content" plus Reload, Back,
  Forward and Open externally. Open externally needs a confirmation: with `secure:true` the external browser has no
  token and will get 401, which the confirmation says.

### 8.5 Status and cost ticker (bottom of the dock)

- Phase badge: Plates while working; amber for paused or expiring; red for failed.
- `$X.XX/h list`, accrued total, accrued today.
- Countdowns to the server end (`serverEndsAt`), the lease end (`leaseEndsAt`) and the idle pause (`idlePauseAt`).
- Buttons: Extend (+30 min / +1 h / +4 h), Pause/Resume, Snapshot, Delete.
- "Resources" popover: an exec snapshot on demand (`nproc; free -m; df -h /; nvidia-smi --query-gpu=…` when present).
  It is never polled, to save exec slots.

### 8.6 Dock and layout

- **`ComputerDock`** is mounted by `App.tsx` (foundation) to the right of the page area on **chat**, **code** and
  **compute**. Toggle: top-bar "Computer" button and ⌘/Ctrl+J. Width 360–960 px, resizable, saved per page in the UI
  store.
- **Tabs:** Terminal · Files · Ports · Preview (one tab per open preview) · Logs (CE only). A header resource picker
  switches between open sessions.
- **Narrow windows** (below 1,200 px with the dock open): the sidebar auto-collapses. Below 1,060 px the dock overlays
  the page as a sheet with a scrim, and the preview view is hidden while the sheet animates (transform only, ≤ 250 ms,
  ease-out, per D17).
- **Design rules (D16–D18):**
  - lime fill once per screen ("Create" on the review step; "Open computer" in the resource header);
  - selected resource rows: `bg-accent` + inner bar;
  - working state: Plates;
  - `EmptyState dino="sleep"` for "No computers yet";
  - happy Dino only on the first successful create in a session;
  - never Dino inside the terminal or in rows;
  - every select is the kit `Select`;
  - micro-labels through `MicroLabel`.

### 8.7 Reconnect and cold resume

| Event | Behaviour |
|---|---|
| Network drop / sleep | ws close → `reconnecting` with jittered backoff. The v2 PTY survives a disconnect `[V]`; output produced while away may be lost `[U]`; the ring buffer keeps what was seen. |
| Stale attachment after a drop | The handshake 409 may persist until the server notices `[U]`. Retry for 60 s, then show `attached_elsewhere` with "Take over". |
| Token expired / extended / resumed | 401 → single-flight `connect` → reattach (one attempt per 401 burst). |
| Sandbox paused (idle guard or GMI billing) | Session → `paused`. The terminal shows a non-editable banner with a Resume button (price in the native dialog). |
| Resumed | `coldResumed: true`; banner "Processes from before the pause may be gone" with "Restart services (n)". |
| Deleted or expired remotely | Session → `closed` (reason from `deletion.code`); dock shows the EmptyState. |
| App restart | Sessions are not persisted. Reopening needs a click; the registry remembers the last-open resource per page. |

### 8.8 CE containers in the panel

- **Always available:** Logs tab (§6.4), status, network, restart and delete.
- **Terminal, gated on P-CE** (§20):
  - **If** `POST /containers/{id}/shell` returns a `urlPath` whose WebSocket can be driven from main (ttyd-style
    binary or JSON frames), `ShellBridge` gets a `ce` protocol adapter (C2-E).
    - The `urlPath` is treated as a credential: never logged; dropped after the session.
    - The concurrent-session cap `[U]` is shown as "attached elsewhere".
  - **Else**, SSH with `ssh2`:
    - an ed25519 key generated in main (`crypto.generateKeyPairSync('ed25519')`);
    - the private key in `ctx.secure` as `compute.ssh.<rid>`;
    - the public key sent as env `SSH_KEY`, or through `sshKeyIdList` if `/me/ssh-keys` accepts API keys (U4);
    - host keys pinned on first use, per container id, with a re-prompt only after a restart or recreate that the app
      itself saw;
    - PTY → the same bridge; SFTP → `FileService`; local port forwards (`127.0.0.1:<random>`) → previews in the same
      `WebContentsView` policy, with the private-IP block relaxed only for that exact forwarded port.
    - This path needs EIP + firewall (§6.3), so it is offered only when the user chose "SSH from this computer".
- **Files without SSH:** none. CE has no exec API `[V]`. The Files tab says why.

---

## 9. Cost guard (`services/compute/guard.ts`)

### 9.1 Prices

- The **list** price per hour comes from the public billing feed, in micro-USD per hour → USD `[V]`.
- Org discounts for CE are readable only with a console session `[V]`, so the UI always says "list price; your
  organization may pay less" and links `/user-setting/ce/usage-billing/usage`.
- **Freshness.** Under 24 h old → fine. Older → the quote warns ("price from <date>").
- **Unknown price** → the quote has `usdPerHour: null`. With `enforce` on, creating is **refused**
  (`invalid_input`: "GMI Desk cannot verify the price of this size right now"). With `enforce` off, the native dialog
  states "price unknown".

### 9.2 Accrual (estimate, list price)

- The registry keeps billing intervals per resource: `{from, to|null, usdPerHour}`.
- **Opened** on the first observation of a billed phase (§6.5, §7.4). For CE it is backdated to the create request
  time (conservative); for sandboxes to `running_at` / `started_at` when GMI reports it.
- **Closed** on an unbilled phase or deletion, using GMI's timestamps when present (`paused_at`,
  `deletion.requested_at`) and otherwise the last poll time.
- **Today / month** = intervals intersected with local day and month windows (the same local-time rules as
  `BudgetGuard`).
- **While the app was closed:** at startup, a resource that is still billed is assumed to have run the whole time. That
  is exact for containers (they cannot stop) and conservative for sandboxes (the server timeout may have paused them;
  the reconcile then trims to `paused_at`).

### 9.3 Budgets

- **The usage slice adds sources** (F0). `budgetSources.register(source)` lets the compute guard add a `SpendSource`
  (§13.2). `computeBudgetStatus` sums ledger totals and the sources' `totalSince()`, so daily and monthly status,
  Usage's figures and chat's `budget.check` all see compute spend.
- **A daily budget is required** before the first container create and before any GPU-SKU sandbox. `DEFAULT_BUDGET`
  has `dailyUsd: null` (`src/shared/contracts/usage.ts`), so without one the check always passes on a fresh install.
  Main refuses the create (`invalid_input`: "Set a daily budget first") and the wizard offers "Set a daily budget"
  inline. Setting a limit where none exists tightens, so it needs no native dialog (D8). The paid sandbox probe already
  requires a budget.
- **Projections include committed burn.** Before create, resume and extend:
  `projected = usdPerHour × (lease remaining or timeout) + Σ (usdPerHour × remaining lease) of the running managed
  resources` (a resource without a lease counts 24 h). `BudgetGuard.check(projected, 'compute')`: not allowed →
  `budget_exceeded` (with `enforce` on); allowed but over the limit → the warning goes into the native dialog.
- **While running** (60 s tick):
  - **burn** = Σ usdPerHour of billed managed resources;
  - when the remaining daily or monthly budget is ≤ burn × 15 min → `budget_warning` (a notification, at most once per
    resource per hour);
  - when it reaches 0 with `enforce` → each resource's `onBudget` action:
    - sandboxes default to **pause** (reversible);
    - containers default to **notify**, because there is no pause and a delete loses data. They then get critical
      notifications every 15 min, a persistent banner, and the quit check.
- **`onBudget` is an explicit choice** in the wizard and is **stated in the native create dialog**. For a container
  left on `notify`, the dialog says plainly: "Your budget will not stop this container."
- **Changes that delete sooner need a native dialog.** After create, a `setLease` patch that shortens
  `maxLifetimeMin` to less than the time already run plus 15 min, or sets `onExpiry` or `onBudget` to `delete`, shows a
  native confirmation stating what will be deleted and when. The guard never applies a lease-triggered delete within
  15 min of a lease change without the T−15/5/1 notifications.
- **Loosening** a lease (longer lifetime, `notify` instead of `delete`, idle pause off, unlimited) needs a native
  confirmation, the same pattern as D8 budgets.

### 9.4 Leases

- **The lease starts at the first `running`.**
- **Warnings:** desktop notifications at T−15, T−5 and T−1 min with one-click "Extend 1 h" (the notification click
  opens the resource; extending inside the approved maximum needs no new dialog).
- **At expiry**, the `onExpiry` action:
  - `delete`: the default for containers, shown prominently in the wizard; the user changes it there;
  - `pause`: sandboxes;
  - `notify`: a critical alarm every 30 min.
- **Sandboxes are also bounded by the server** (`timeout` + `on_timeout`): the app lease is the outer limit and the
  server timeout the inner one, renewed while active (§7.3).
- **Containers with `maxLifetimeMin: null`** need a native confirmation at create ("No automatic limit: this keeps
  billing $X/h until you delete it").
- **Actions are retried until they succeed.** The registry persists `actionPending {action, dueAt, attempts,
  lastError}`. Every guard tick retries with backoff (1, 2, 5, 10 min…), for example after being offline, a 5xx, or a
  409 while the resource is `creating` or `terminating`. After 3 failures: a critical `lease_action_failed` alarm and a
  notification. The resource keeps showing as billing.
- **Destructive catch-up needs GMI's clock.** At startup, a lease-triggered **delete** is applied only after a fresh
  GMI `Date` (the skew check, §6.6) and fresh remote state from the supervisor confirm the lease really ended. A wrong
  local clock (RTC reset, VM resume) can therefore never delete containers. A pause may proceed on local time.

### 9.5 Idle (sandboxes only)

- **Activity counts only user intent:** terminal input bytes, user-initiated file operations and transfers, input
  events in a preview view (`before-input-event`), user execs (the Resources popover, services the user starts), and
  agent tool calls **during an active run** (H4).
- **Not activity:** terminal output (a dev server logging, `top`, `tail -f`), background preview traffic (HMR,
  polling), app-originated execs (the port scan, usage snapshot, listing refresh), supervisor polls. Code inside the
  sandbox can therefore not keep itself alive.
- **Idle for `idlePauseMin`** (default 20) → pause, with a toast "Paused <name> after 20 min idle — Resume".
- **Containers have no idle action:** a GPU job can run without any interaction. Only leases and budgets apply.
- Test: a dock left open on Ports, with a dev server streaming logs into the terminal and an open preview with HMR,
  pauses after `idlePauseMin`.

### 9.6 Alarms and notifications

`ComputeAlarm` (§13.1) kinds:
- `orphan`, `eip_unattached`;
- `lease_expiring`, `lease_action` (what the guard did);
- `budget_warning`, `budget_exhausted`;
- `paused_long`, `price_unknown`;
- `api_unavailable`, `key_invalid`, `create_unknown`, `lease_action_failed`.

Delivery rules:
- Alarms are deduplicated by `(kind, resourceId)`.
- Notifications are throttled. Critical alarms repeat at a fixed interval until dismissed or resolved.
- The Compute nav item shows a count badge (amber/red; never a lime text badge on light).

### 9.7 Quit, close and sleep

- **Quit check.** It runs as a hook registered with `core/shutdown.ts` (§13.2), before the dispose phase. With any
  billed managed **container** (sandboxes are bounded by the server), a native dialog says "2 containers are still
  running ($6.70/h list). They keep billing after GMI Desk quits." with the buttons **Delete all and quit · Keep
  running and quit · Cancel**.
- **Startup catch-up.** Overdue pauses are applied at once; overdue deletes once GMI's clock and fresh remote state
  confirm them (§9.4). Then the user is told: "Deleted `gmid-a1b2c3-train-x7k2p9`: its 4-hour lease ended while GMI
  Desk was closed."
- **Sleep.** `powerMonitor` `suspend` stops the timers; `resume` runs an immediate guard tick plus a supervisor
  reconcile.
- **Open decision for the user** (§22): keep the app alive in the system tray while containers run, so leases are
  enforced with the window closed. On Linux/Wayland tray support depends on the desktop environment.

### 9.8 Cost model (list prices, 2026-11-02 `[V]`)

| Scenario | Cost |
|---|---|
| Sandbox SMALL, 8 h workday, idle-paused 3 h | 5 h × $0.0911 = **$0.46** |
| Sandbox SMALL forgotten, auto-paused after 20 min idle | ≤ $0.03 per forgotten session, also with a dev server logging into the terminal or an open preview polling (only user input counts as activity); pause is free during Early Access `[U]` later |
| 1×H200 container for a 4 h lease | **$13.40** maximum, then auto-deleted |
| 1×H200 forgotten overnight without a lease (14 h) | $46.90: why leases default on |
| 8×H200 container, 1 day | $643.20. The native dialog plus the budget check are the guard. When the projected cost is above $100, the dialog adds a "more than $100" line and the confirm button repeats the hourly price. |
| EIP left unattached | $0.10/h = **$2.40/day, $72/month**: hence the alarm |
| Polling | GETs are free; at most about 1 request per 5 s per backend while active |

---

## 10. State machines

**Resource (normalised).** Phases from §6.5 and §7.4; `pendingAction` is shown on top of them.
```
            create (journal intent) ─► creating ─► running ◄───────────────┐
                    │ unknown ─► reconcile ─┘  │  │  │ restart (CE)       │
                    ▼                          │  │  └► busy ─────────────┤
              failed_unknown (alarm)           │  └ pause (sb) ─► pausing ─► paused ─resume─► resuming ┘
                                               ├ delete ─► deleting ─► deleted (tombstone; accrual closed)
                                               └ error/failed ─► failed ─delete─► deleting
```

**Create journal entry:** `intent → sent → confirmed | failed | unknown → (reconcile) confirmed | failed_unknown →
(every sweep) confirmed (late adoption) | dismissed (by the user, after a confirmation)`. Only `confirmed`, `failed` and
`dismissed` entries are ever pruned.
Only `intent` is written before any network I/O. `sent` is written right before the fetch, and that write is
synchronous with respect to the request.

**Session:** `connecting → ready → (reconnecting ⇄ ready) → paused → ready → closed`. **Shell:** §8.2.

**Transfer:** `queued → running → done | failed | cancelled`, where cancel aborts the stream and deletes the `.part`
file.

**Lease:** `pending (not yet running) → active → warning (T−15) → expired → action_pending → action_applied |
notified`. `action_pending` retries on every guard tick (after 3 failures it raises `lease_action_failed` and keeps
retrying); a delete waits for GMI's clock at startup (§9.4). An extend goes from `warning` back to `active`.

---

## 11. Failure modes and recovery

| Failure | Detection | Recovery / user sees |
|---|---|---|
| Create POST times out, answers 5xx or 429, an HTML challenge page or an unexpected 200 body | journal `unknown` | Reconcile by name: found → normal; not found after 2 min → `create_unknown` alarm, re-checked on every sweep, never resent; "Try again" lists first and asks natively. |
| App crash between the journal write and the POST | journal `intent` at startup | Reconcile by name (most likely not created) → mark `failed`. |
| Power loss right after the POST | durable journal (`sent` fsynced before the fetch) | Reconcile by name at startup. |
| Container appears late, after a reinstall or with a lost profile | sweep: install tag in the name, or another `gmid-` tag | This install's tag → adopted + `orphan` alarm; another tag → read-only `orphan` alarm with Adopt (native) and Open in console; org-wide billing banner. |
| Sandbox create network error | no response | Retry with the same `Idempotency-Key` (≤ 3 within 2 min) → safe. |
| Compute key revoked | 401 on any call | `reportInvalidComputeKey` → `key_invalid` alarm and Connect Compute; resources keep billing (stated). |
| Org not entitled | 403 "tenant has no permission" | `not_entitled` with the console link "Contact support". |
| Quota or capacity | 429 `Resource.QuotaExceeded` / `RateLimit.Exceeded` | `quota_exceeded` (details) / `rate_limited` with `retryAfterSec`; never retried automatically. |
| IDC under maintenance | 409 `IDC.UnderMaintenance`, IDC `status: maintenance` | Writes disabled for that IDC; reads continue. |
| GMI API down | backoff, `apiHealth: down` | Banner; cached data marked stale; the guard keeps accruing from the last known state. |
| EIP/firewall step fails | saga step error | `network: degraded`, alarm with Retry / Release. |
| Shell stale attach | 409 for more than 60 s | `attached_elsewhere` → Take over (native confirm). |
| Data plane 401 | status | Single-flight `connect`; failing again → session `unavailable` with Reconnect. |
| Exec concurrency | 429 `Execution.ConcurrencyLimitExceeded` | Slots are held until executions end, and leftovers are cancelled at startup; if it still happens, capacity drops to the observed level and backs off. |
| Lease or budget action fails (offline, 5xx, 409) | `actionPending` | Retried every guard tick with backoff; after 3 failures a critical `lease_action_failed` alarm. |
| Local clock wrong at startup | GMI `Date` | Deletes wait for GMI's clock and fresh remote state; pauses proceed. |
| Huge CE log without Range | `rangeSupported: false`, size | Streamed through a 1 MiB ring; auto-polling stops above 10 MB. |
| Upload: 200 with `[]` | response check | `upstream` error "GMI did not store the file". |
| Disk full in the sandbox | 507 | Toast with "free space" hints. |
| Resume was cold | `coldResumed` | Banner + "Restart services". |
| Paused by billing | `pause.code = Sandbox.BillingInsufficientBalance` | Alarm "GMI paused this: balance is low" with a link to credits. |
| Lease expired while the app was closed | startup reconcile | Action applied + notification. |
| Preview loads another origin | `will-navigate` blocked | `blocked` state with "Open externally" (confirm). |
| Preview renderer crash | `render-process-gone` | `failed` with Reload. |
| Renderer slow | unacked > 512 KiB while attached and visible | `ws.pause()`; the UI may lag but never drops data that was acked. |
| Nobody watching (dock closed, window hidden, reload) | visibility | The ring keeps the newest 1 MiB; the ws is never paused, so remote programs never stall. |
| Clock skew > 2 min | HTTP `Date` | Use the server offset; Diagnostics warning. |
| Catalog source changes shape | normaliser rejects rows | Source `error`, last good data kept (D7); logged at warn level without bodies. |

---

## 12. Security model and threat model

### 12.1 Assets and trust boundaries

**Assets:**
- the compute key (spend authority for the whole org: $28/h machines, deletes, firewall changes, reading env secrets);
- data-plane tokens (shell, exec and files of one sandbox);
- traffic tokens (port previews);
- CE shell `urlPath`s;
- SSH private keys;
- the user's GMI inference key and OAuth tokens (must never enter a container);
- the user's local files and money.

**Boundaries:**
1. main (trusted);
2. renderer (untrusted for spending: it may be compromised through XSS in model output);
3. preview views (hostile web content);
4. remote code in containers and sandboxes (hostile: any image, agent-run code);
5. org members (shared visibility);
6. GMI (trusted, out of scope).

### 12.2 Threats → mitigations

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Compute key leaves main (renderer, logs, IPC, crash dumps) | Stored only in `ctx.secure`; `ComputeKeyProvider` is main-only; IPC carries `last4` + metadata; logger redaction (bearer/JWT patterns plus new key names, §17); never placed in envs | Process memory dump by local malware: out of scope |
| T2 | Compromised renderer launches expensive resources | Every billing start needs a native dialog from main (DC4); quotes bind the spec; create rate cap (3 per 10 min, then the native dialog warns); a daily budget is required before the first container or GPU sandbox; projections include the burn of running resources; budgets enforced in main; deleting sooner through a lease change needs a native dialog | A user who clicks through native dialogs |
| T3 | Double billing from retries | DC3 journal + name reconcile; v2 Idempotency-Key | Probe P-CE confirms the list is consistent soon after a create `[U]` |
| T4 | Forgotten resources bill indefinitely | Leases, server timeouts, idle pause on user activity only, budget actions retried until they succeed, durable journal with unresolved entries kept, install-tagged names, sweeps with orphan alarms, the org-wide billing banner, EIP alarm, quit check, startup catch-up | Containers while the app is closed (quit dialog plus a tray option §22) |
| T5 | Preview content attacks the app or the machine (navigate to app://, phishing, CSRF to localhost, downloads) | Separate `WebContentsView` with an in-memory partition, no preload, sandbox; the URL built in main with a host check; nav lock to the exact host (incl. `did-start-navigation`); private/loopback request block; no permissions (also Local Network Access, tested); downloads cancelled; persistent "untrusted" frame; never an iframe | DNS rebinding to private IPs (webRequest sees hostnames), against the user's other local or LAN services as well as the app's own (which require a bearer and reject `Origin`, harness.md §4.9) → Local Network Access denial, tested |
| T6 | Token leakage through previews | Only `traffic-access-token`, only for the exact host (scoped to that sandbox anyway); `X-Access-Token` is never injected | Sandbox code sees its own traffic token (by design) |
| T7 | Terminal escape-sequence abuse (OSC 52 clipboard, OSC 8 links, title spoofing, XTWINOPS) | No clipboard addon; link clicks go through https-only openExternal after a confirmation showing the full URL; title shown as plain text, capped; `windowOptions` off | xterm.js parser bugs → pinned version, updated through releases |
| T8 | Command injection through file paths in exec | Paths only through `envs`, never interpolated; client-side normalisation; quoted `"$GMID_P"` | Remote shell differences (busybox) → fallback paths tested |
| T9 | Path traversal on download (remote names like `../../.bashrc`) | Native save dialog; the default name is the sanitised basename; `.part` + rename inside the chosen folder | None |
| T10 | Secrets in CE responses (env values, registry credentials) reach the UI, logs or fixtures | Sanitiser strips `envs[].value`, `credential`; tests over fixtures; secret env values held only in memory until create | Values the user typed are visible to anyone with console access (said in the wizard) |
| T11 | Third-party data (customer SKUs) surfaces | Descriptions used only as a filter in memory; SKU allowlist; aggregated signed-out offers; synthetic fixtures with a test | Patterns may miss a new naming scheme → re-check when the feed changes |
| T12 | Acting on colleagues' resources | Only resources tagged with this install are managed; others are read-only unless the user adopts one in a native dialog; no bulk action on unmanaged; `releaseEip` only for managed EIPs | Console users can still delete ours (expected) |
| T13 | Org-visible metadata leaks PII | Metadata = `app, inst (random), rid, purpose, thr`; no hostname or user name | None |
| T14 | Network exposure of containers | Never "All Open" by default; /32 rules; anything broader than /32 (and 0.0.0.0/0) needs a native dialog in create and `updateFirewallCidr`, which lists every port and CIDR; reserved CIDRs rejected; SSH key auth only; EIP only on explicit choice; host-key pinning | The user's IP change → "Update to my IP" |
| T15 | GMI keys put into a sandbox by the user or an agent | Main rejects env values, commands, arguments and service commands that contain a stored secret as a substring (also for H4 broker inputs); wizard warning for JWT-shaped values; agent sandboxes (H4) get no GMI keys, and the loop runs locally (harness.md §10.4) | The user pastes a key in the terminal: their choice; an encoded key (base64) is not detected |
| T16 | Snapshot captures credentials | Scrub step offered before every snapshot | User opt-out |
| T17 | Mock or screenshot builds talk to GMI | Mock mode never constructs real clients; tests assert no fetch to GMI hosts in mock | None |
| T18 | Packaged-build env overrides (`GMI_DESK_MOCK_COMPUTE`) | Added to `DEV_ENV_VARS` (stripped when packaged) | None |
| T19 | Tokens in dev traces (`sandbox_access_token`, `traffic_access_token`, `connect_url`, env values, data-plane bodies) | The compute sanitiser, then the logger's key-name `sanitize()`; data-plane bodies never traced (status, sizes and request ids only); traces of a live session deleted when it ends; a test asserts that recorded create and connect responses contain no token value | A traffic token cannot be rotated; traces are dev-only |
| T20 | A hostile sandbox floods main (huge WebSocket frames, deflate bombs, multi-GB logs) | `ws` with `maxPayload` 1 MiB and no permessage-deflate; logs streamed through a 1 MiB ring with auto-polling off above 10 MB; terminal ring capped at 1 MiB | — |
| T21 | The compute key at rest with a weak keyring (`basic_text`) | Session-only unless the user confirms storing it in a native dialog | The user confirms |

---

## 13. Contracts

### 13.1 `src/shared/contracts/compute.ts` (new)

```ts
/**
 * Compute tab and the live "computer": GMI Cluster Engine containers and Agentbox sandboxes (Sandbox API v2).
 * Namespaces `compute` (resources, catalog, cost guard) and `computer` (terminal, files, ports, previews).
 * The compute key and every data-plane/traffic token stay in the main process.
 */
import type { ComputeKeyInfo } from './auth';
import type { GmiErrorShape } from './errors';
import type { BudgetCheck } from './usage';

export type ComputeKind = 'container' | 'sandbox';
/** Which GMI API manages a resource: CE `/api/v1/containers` or Sandbox API v2 `/api/v2/sandboxes`. */
export type ComputeBackend = 'ce' | 'sandbox_v2';

export type ComputeSourceState = 'ok' | 'stale' | 'error' | 'skipped';
export interface ComputeSourceStatus {
  state: ComputeSourceState;
  fetchedAt: string | null;
  error: string | null;
}

export type IdcStatus = 'available' | 'full' | 'maintenance' | 'unknown';

export interface ComputeIdc {
  /** GMI's idcId, e.g. "asia-east-taiwan3". */
  id: string;
  name: string;
  country: string | null;
  status: IdcStatus;
  /** What the catalog offers there. */
  kinds: ComputeKind[];
  /** Whether an EIP product exists there (public access possible). Null: unknown. */
  eipAvailable: boolean | null;
}

/** One launchable size. Signed out, offers are aggregated (no raw SKU). */
export interface ComputeOffer {
  /** Stable key: the SKU when known, else `${kind}:${gpuModel ?? 'cpu'}x${gpuCount}:${idc}`. */
  id: string;
  kind: ComputeKind;
  /** Billing instanceType (containers) / product (sandboxes). Null when aggregated. */
  sku: string | null;
  idc: string;
  gpuModel: string | null;
  gpuCount: number;
  vcpu: number | null;
  memoryGiB: number | null;
  diskGiB: number | null;
  arch: 'x86_64' | 'arm64' | null;
  /** Sandbox size label (SMALL, MEDIUM, ...). */
  sizeLabel: string | null;
  /** List price, USD per hour (lowest in the group when aggregated). Null: unknown. */
  listUsdPerHour: number | null;
  /** True: GMI lists it for this org (needs a Compute key). Null: unknown (signed out). */
  entitled: boolean | null;
}

export interface ComputeTemplatePort {
  port: number;
  protocol: 'TCP' | 'UDP';
  label: string | null;
}

export interface ComputeTemplate {
  id: string;
  kind: ComputeKind;
  name: string;
  official: boolean;
  /** Container image path. Registry credentials never leave main. */
  image: string | null;
  /** Only for official templates. */
  description: string | null;
  defaultPorts: ComputeTemplatePort[];
  /** Official CE templates pre-expose SSH (22). Null: unknown. */
  sshReady: boolean | null;
  /** Sandbox templates belong to one IDC. */
  idc: string | null;
}

export type ComputeCatalogSource =
  | 'idcs'
  | 'publicProducts'
  | 'publicTemplates'
  | 'accountProducts'
  | 'accountTemplates'
  | 'sandboxProducts'
  | 'sandboxTemplates';

export interface ComputeCatalog {
  idcs: ComputeIdc[];
  offers: ComputeOffer[];
  templates: ComputeTemplate[];
  /** `account` once a valid Compute key added the org's own products and templates. */
  scope: 'public' | 'account';
  sources: Record<ComputeCatalogSource, ComputeSourceStatus>;
  fetchedAt: string;
}

export type ComputeEntitlement = 'unknown' | 'checking' | 'entitled' | 'not_entitled' | 'error';

export interface ComputeAccess {
  key: ComputeKeyInfo;
  containers: ComputeEntitlement;
  sandboxes: ComputeEntitlement;
  checkedAt: string | null;
}

/** Normalised lifecycle phase across CE statuses and v2 sandbox states (the raw value is in `rawState`). */
export type ComputePhase =
  | 'creating'
  | 'running'
  | 'busy'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'failed'
  | 'unknown';

export type ComputeAction = 'create' | 'delete' | 'restart' | 'pause' | 'resume' | 'extend' | 'snapshot' | 'network';

/** What the cost guard does at a limit. Containers support 'delete' | 'notify' only (no pause in CE). */
export type LeaseAction = 'delete' | 'pause' | 'notify';

export interface LeasePolicy {
  /** Max lifetime from the first `running`, minutes. Null = no limit (needs a native confirmation). */
  maxLifetimeMin: number | null;
  onExpiry: LeaseAction;
  /** Sandboxes: pause after this many idle minutes. Null = never. */
  idlePauseMin: number | null;
  /** Sandboxes: extend the server timeout while there is activity, up to maxLifetimeMin. */
  extendOnActivity: boolean;
  /** When a budget limit is reached while running (enforce on). */
  onBudget: LeaseAction;
}

export const LEASE_LIMITS = {
  minLifetimeMin: 10,
  maxLifetimeMin: 7 * 24 * 60,
  minIdlePauseMin: 5,
  maxIdlePauseMin: 24 * 60,
  sandboxTimeoutMinSec: 60,
  sandboxTimeoutMaxSec: 86_400,
} as const;

export interface FirewallRuleView {
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  fromPort: number | null;
  toPort: number | null;
  cidr: string;
}

export interface ComputeNetwork {
  publicIp: string | null;
  eip: {
    id: string;
    address: string | null;
    /** Allocated by this app (it may release it). */
    managed: boolean;
    status: 'associated' | 'disassociated' | 'released' | 'unknown';
  } | null;
  firewalls: Array<{ id: string; name: string; managed: boolean; preset: boolean; rules: FirewallRuleView[] }>;
  ports: Array<{ containerPort: number; nodePort: number | null; protocol: 'TCP' | 'UDP' }>;
  /** A step of the EIP/firewall setup failed (see alarms). */
  degraded: boolean;
}

export interface ComputeCapabilities {
  terminal: boolean;
  files: boolean;
  previews: boolean;
  logs: boolean;
  restart: boolean;
  pause: boolean;
  snapshot: boolean;
  extend: boolean;
  network: boolean;
}

export interface ComputeResource {
  /** App handle `cr_<uuid>`, stable across restarts; also the v2 Idempotency-Key. */
  id: string;
  kind: ComputeKind;
  backend: ComputeBackend;
  /** CE container id / v2 sandbox id. Null while a create is pending. */
  remoteId: string | null;
  /** Remote name (containers: `gmid-<inst6>-<slug>-<nonce6>`). */
  name: string;
  displayName: string;
  /** Created or adopted by this install. False: someone else's, read-only. */
  managed: boolean;
  purpose: 'computer' | 'agent' | null;
  /** Code thread served by this resource (harness.md H4). */
  threadId: string | null;
  phase: ComputePhase;
  rawState: string | null;
  /** User-safe explanation (failure, pause or deletion reason). */
  reason: string | null;
  idc: string | null;
  sku: string | null;
  templateName: string | null;
  listUsdPerHour: number | null;
  createdAt: string | null;
  runningSince: string | null;
  /** Sandboxes: GMI's end_at (pause or deletion by the server). */
  serverEndsAt: string | null;
  /** App lease end (first running + maxLifetimeMin). */
  leaseEndsAt: string | null;
  /** Sandboxes: paused_expire_at (deleted by GMI after 7 days paused). */
  pausedExpiresAt: string | null;
  /** When the idle guard will pause it (sandboxes). */
  idlePauseAt: string | null;
  lease: LeasePolicy | null;
  /** Local estimate at list price since creation / today (local day). */
  accruedUsd: number;
  accruedTodayUsd: number;
  /** Containers only. */
  network: ComputeNetwork | null;
  /** Sandboxes: port previews need the traffic token. */
  secure: boolean | null;
  egressLocked: boolean | null;
  capabilities: ComputeCapabilities;
  pendingAction: ComputeAction | null;
  /** A lease or budget action that has not succeeded yet; retried every guard tick (§9.4). */
  actionPending: { action: LeaseAction; dueAt: string; attempts: number; lastError: string | null } | null;
  updatedAt: string;
}

export interface ComputeResourceDetail extends ComputeResource {
  /** Env var names only; values never cross IPC. */
  envNames: string[];
  command: string | null;
  args: string[];
  sshKeyNames: string[];
  /** Snapshot it was launched from. */
  snapshotId: string | null;
  lastError: GmiErrorShape | null;
  /** Last 50 phase transitions, newest first. */
  history: Array<{ at: string; phase: ComputePhase; note: string | null }>;
}

export interface EnvVarInput {
  name: string;
  value: string;
  /** Secret values are kept in main memory until create, never stored or returned. */
  secret: boolean;
}

export interface ContainerCreateSpec {
  kind: 'container';
  /** 1–40 characters; the remote name becomes `gmid-<inst6>-<slug>-<nonce6>`. */
  displayName: string;
  idc: string;
  sku: string;
  templateId: string;
  command?: string | null;
  args?: string[];
  env?: EnvVarInput[];
  ports?: Array<{ containerPort: number; protocol: 'TCP' | 'UDP' }>;
  ssh: { mode: 'none' } | { mode: 'app_key' } | { mode: 'account_keys'; keyIds: string[] };
  /** Main treats any CIDR broader than /32 as open (native confirmation), whatever `allOpen` says (§6.3). */
  access: { mode: 'none' } | { mode: 'public'; allowCidrs: string[]; tcpPorts: number[]; allOpen?: boolean };
  lease: LeasePolicy;
}

export interface SandboxCreateSpec {
  kind: 'sandbox';
  displayName: string;
  /** Null: the org's default IDC. */
  idc: string | null;
  /** e.g. `gmi.sandbox.small`. */
  product: string;
  source: { templateId: string } | { snapshotId: string };
  /** Always sent (GMI's default is 300 s). */
  timeoutSec: number;
  onTimeout: 'pause' | 'kill';
  /** Traffic token on port previews. False needs a native confirmation. */
  secure: boolean;
  egress: { mode: 'open' } | { mode: 'allowlist'; hostnames: string[]; cidrs: string[] };
  env?: EnvVarInput[];
  purpose: 'computer' | 'agent';
  threadId?: string | null;
  lease: LeasePolicy;
}

export type ComputeCreateSpec = ContainerCreateSpec | SandboxCreateSpec;

export interface CostLine {
  label: string;
  usdPerHour: number | null;
  note: string | null;
}

export interface CreateQuote {
  quoteId: string;
  /** As normalised by main; secret env values are replaced by '••••'. */
  spec: ComputeCreateSpec;
  lines: CostLine[];
  /** List total per hour. Null: unknown. */
  usdPerHour: number | null;
  /** If it runs until the lease/timeout ends (list). Null: no limit. */
  maxUsd: number | null;
  priceSource: 'public_feed' | 'cached';
  priceAgeSec: number | null;
  budget: BudgetCheck;
  warnings: string[];
  expiresAt: string;
}

export type SnapshotState = 'creating' | 'ready' | 'error' | 'deleting' | 'delete_failed' | 'unknown';

export interface ComputeSnapshot {
  id: string;
  name: string;
  /** App resource it was taken from, when known. */
  sourceResourceId: string | null;
  sourceRemoteId: string | null;
  idc: string | null;
  state: SnapshotState;
  createdAt: string | null;
  sizeBytes: number | null;
  managed: boolean;
}

export interface ComputeNetworkInventory {
  eips: Array<{
    id: string;
    name: string;
    idc: string;
    address: string | null;
    status: 'associated' | 'disassociated' | 'released' | 'unknown';
    /** App resource id when attached to a managed container. */
    attachedTo: string | null;
    managed: boolean;
    listUsdPerHour: number | null;
  }>;
  firewalls: Array<{ id: string; name: string; idc: string; preset: boolean; managed: boolean; attachedCount: number; status: 'active' | 'building' | 'error' | 'unknown' }>;
  fetchedAt: string;
}

export type ComputeAlarmKind =
  | 'orphan'
  | 'eip_unattached'
  | 'lease_expiring'
  | 'lease_action'
  | 'budget_warning'
  | 'budget_exhausted'
  | 'paused_long'
  | 'price_unknown'
  | 'api_unavailable'
  | 'key_invalid'
  | 'create_unknown'
  | 'lease_action_failed';

export type ComputeAlarmAction = 'open' | 'extend' | 'pause' | 'delete' | 'release_eip' | 'connect_key' | 'open_console' | 'adopt' | 'dismiss';

export interface ComputeAlarm {
  id: string;
  kind: ComputeAlarmKind;
  severity: 'info' | 'warning' | 'critical';
  resourceId: string | null;
  title: string;
  body: string;
  usdPerHour: number | null;
  createdAt: string;
  actions: ComputeAlarmAction[];
}

export type ComputeApiHealth = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ComputeState {
  access: ComputeAccess;
  /** Managed resources billing now. */
  running: { count: number; usdPerHour: number };
  /** Estimated compute spend (list), local day / month. */
  todayUsd: number;
  monthUsd: number;
  alarms: ComputeAlarm[];
  apiHealth: { ce: ComputeApiHealth; sandbox: ComputeApiHealth };
  /** Everything billing in the organization that the key can see (no spend API exists). Null before the first sweep. */
  org: { containers: number; eips: number; usdPerHour: number | null } | null;
  /** True when a daily budget exists (required before the first container or GPU sandbox, §9.3). */
  dailyBudgetSet: boolean;
  lastSweepAt: string | null;
  mock: boolean;
}

export interface ComputeApi {
  getState(): Promise<ComputeState>;
  getCatalog(opts?: { refresh?: boolean; idc?: string | null }): Promise<ComputeCatalog>;
  listResources(opts?: { includeUnmanaged?: boolean }): Promise<ComputeResource[]>;
  getResource(id: string): Promise<ComputeResourceDetail>;
  /** Polls GMI now (both backends). */
  refresh(): Promise<void>;
  /** Validates and prices a spec. Nothing is created. */
  quoteCreate(spec: ComputeCreateSpec): Promise<CreateQuote>;
  /** Native cost confirmation in main, then creates exactly once. Declined: GmiError('cancelled'). */
  create(quoteId: string): Promise<ComputeResource>;
  /** Native confirmation. Containers: optionally release the app's EIP and firewall afterwards. */
  delete(id: string, opts?: { releaseEip?: boolean; deleteFirewall?: boolean }): Promise<ComputeResource>;
  restart(id: string): Promise<ComputeResource>;
  pause(id: string): Promise<ComputeResource>;
  /** Native confirmation with the price. */
  resume(id: string): Promise<ComputeResource>;
  /** Within the approved lease: no dialog. Beyond it: native confirmation with the price. */
  extend(id: string, minutes: number): Promise<ComputeResource>;
  /** Loosening (longer, notify instead of delete, idle off, no limit) needs a native confirmation; so does any change
   *  that makes a delete happen sooner (shorter than run time + 15 min, onExpiry/onBudget → 'delete'). */
  setLease(id: string, patch: Partial<LeasePolicy>): Promise<ComputeResource>;
  getLogs(id: string, opts?: { tailBytes?: number }): Promise<{ text: string; truncated: boolean; fetchedAt: string }>;
  /** Native save dialog; the full log. Null when cancelled. */
  saveLogs(id: string): Promise<string | null>;
  listSnapshots(): Promise<ComputeSnapshot[]>;
  createSnapshot(id: string, opts?: { name?: string; scrub?: boolean }): Promise<ComputeSnapshot>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  getNetwork(): Promise<ComputeNetworkInventory>;
  /** Native confirmation. Only EIPs this app allocated (`managed`); unmanaged ones get the alarm and Open in console. */
  releaseEip(eipId: string): Promise<void>;
  /** Replaces the firewall's source CIDR. A /32 needs only the renderer confirm; broader is "open" (native); reserved CIDRs rejected. */
  updateFirewallCidr(id: string, cidr: string): Promise<ComputeResource>;
  /** Takes over a `gmid-` resource with another install tag (native confirmation: it may be a colleague's). */
  adopt(id: string): Promise<ComputeResource>;
  /** Opt-in: asks a public IP echo service for this computer's IPv4 (one call per click, disclosed in the UI). */
  detectPublicIp(): Promise<{ ip: string | null; service: string }>;
  /** Re-runs the orphan / EIP sweep now. */
  sweep(): Promise<ComputeState>;
  dismissAlarm(alarmId: string): Promise<ComputeState>;
  /** Opens a fixed console page for a resource (validated id). */
  openInConsole(id: string, view: 'detail' | 'logs' | 'monitor' | 'reconfigure' | 'renew'): Promise<void>;
}

export type ComputerSessionState = 'connecting' | 'ready' | 'reconnecting' | 'paused' | 'unavailable' | 'closed';
export type TerminalState = 'none' | 'connecting' | 'attached' | 'reconnecting' | 'attached_elsewhere' | 'closed';

export interface ComputerService {
  name: string;
  command: string;
  port: number | null;
  startedAt: string;
}

export interface ComputerSessionInfo {
  sessionId: string;
  resourceId: string;
  state: ComputerSessionState;
  reason: string | null;
  terminal: { state: TerminalState; cols: number; rows: number; lastSeq: number };
  /** File browser root ($HOME). */
  home: string | null;
  user: string | null;
  /** Resumed after a pause: earlier processes may be gone. */
  coldResumed: boolean;
  services: ComputerService[];
  /** Exec slots in use (of 10 per sandbox). */
  execInUse: number;
}

/** One batch of terminal output. `data` is raw PTY bytes (ANSI). */
export interface TerminalChunk {
  sessionId: string;
  seq: number;
  data: Uint8Array;
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  mtime: string | null;
  /** Octal permission bits, e.g. "644". */
  mode: string | null;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  /** Null when binary or over the limit. */
  text: string | null;
  binary: boolean;
  truncated: boolean;
}

export interface TransferInfo {
  transferId: string;
  sessionId: string;
  direction: 'upload' | 'download';
  /** File name only (never a local path). */
  name: string;
  remotePath: string;
  bytes: number;
  totalBytes: number | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error: GmiErrorShape | null;
}

export interface PortInfo {
  port: number;
  address: string;
  process: string | null;
  previewable: boolean;
}

export type PreviewState = 'loading' | 'ready' | 'failed' | 'blocked' | 'closed';

export interface PreviewInfo {
  previewId: string;
  sessionId: string;
  port: number;
  /** The preview URL without any token (tokens travel in headers only). */
  url: string;
  title: string | null;
  state: PreviewState;
  /** Blocked navigation target or load error, user-safe. */
  detail: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const FILE_WRITE_MAX_BYTES = 1024 * 1024;
export const UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

export interface ComputerApi {
  open(resourceId: string): Promise<ComputerSessionInfo>;
  close(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<ComputerSessionInfo>;
  /** Starts or rejoins the shell; returns what was already on screen (ring buffer) and its last seq. */
  terminalAttach(sessionId: string, size: { cols: number; rows: number }): Promise<{ replay: Uint8Array; seq: number }>;
  terminalInput(sessionId: string, data: string): Promise<void>;
  terminalResize(sessionId: string, size: { cols: number; rows: number }): Promise<void>;
  /** Flow control: the renderer has written everything up to `seq`. */
  terminalAck(sessionId: string, seq: number): Promise<void>;
  /** Ack backpressure applies only while a view is attached and visible (§8.2). */
  terminalVisibility(sessionId: string, visible: boolean): Promise<void>;
  /** Closes the remote shell (irrevocable) and starts a new one. Native confirmation in main. */
  terminalTakeOver(sessionId: string): Promise<void>;
  listDir(sessionId: string, path: string): Promise<DirListing>;
  readFile(sessionId: string, path: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  writeFile(sessionId: string, path: string, text: string): Promise<void>;
  makeDir(sessionId: string, path: string): Promise<void>;
  movePath(sessionId: string, from: string, to: string): Promise<void>;
  removePath(sessionId: string, path: string): Promise<void>;
  /** Native multi-file picker in main, then uploads into `remoteDir`. Null when cancelled. */
  upload(sessionId: string, remoteDir: string): Promise<TransferInfo[] | null>;
  /** Native save dialog in main. Null when cancelled. */
  download(sessionId: string, remotePath: string): Promise<TransferInfo | null>;
  cancelTransfer(transferId: string): Promise<void>;
  listPorts(sessionId: string): Promise<PortInfo[]>;
  startService(sessionId: string, svc: { name: string; command: string; port?: number | null }): Promise<ComputerSessionInfo>;
  restartServices(sessionId: string): Promise<ComputerSessionInfo>;
  /** Snapshot of CPU/memory/disk/GPU via one exec (never polled). */
  getResourceUsage(sessionId: string): Promise<{ text: string; at: string }>;
  /** `path` must start with '/'; main builds the URL and checks its host (§8.4). */
  openPreview(sessionId: string, port: number, path?: string): Promise<PreviewInfo>;
  /** Null hides the native view (e.g. while a dialog covers it). */
  setPreviewBounds(previewId: string, bounds: PreviewBounds | null): Promise<void>;
  previewCommand(previewId: string, command: 'reload' | 'back' | 'forward' | 'stop'): Promise<void>;
  /** Native confirmation; opens the preview URL in the system browser (it gets no token). */
  openPreviewExternally(previewId: string): Promise<void>;
  closePreview(previewId: string): Promise<void>;
  /** PNG data URL of the preview, shown while an overlay hides the native view. */
  capturePreview(previewId: string): Promise<string | null>;
}
```

**Events** (added to `GmiEvents` and `EVENT_NAMES`):

```ts
'compute:state': ComputeState;          // access, alarms, totals (throttled ≤ 1/s)
'compute:resources': ComputeResource[]; // managed + visible unmanaged, after every poll/mutation that changed something
'compute:alarm': ComputeAlarm;          // new alarm (also in compute:state)
'computer:session': ComputerSessionInfo;
'computer:terminal': TerminalChunk;     // ≤ 64 KiB, batched every 16 ms
'computer:transfer': TransferInfo;      // throttled to 4/s per transfer
'computer:preview': PreviewInfo;
```

### 13.2 Additive changes outside `compute.ts` (foundation; shared with harness.md; built by F0, §21.0)

| File | Change |
|---|---|
| `contracts/errors.ts` | `GmiErrorCode` gains `'no_compute_key' \| 'invalid_compute_key' \| 'not_entitled' \| 'quota_exceeded' \| 'conflict'` (compute) and `'context_overflow' \| 'limit_reached' \| 'permission_denied'` (harness), with `ERROR_HINTS` entries. `ctx.http`'s mapping is unchanged; the compute and gateway error mappers produce the new codes. `ipc/registry.ts` `QUIET_CODES` += `no_compute_key, not_entitled, permission_denied, limit_reached`. |
| `contracts/auth.ts` | `ComputeKeyInfo {status: InferenceKeyStatus; last4; keyId; orgId; orgMatchesAccount; validatedAt; error}`; `AuthState.computeKey?: ComputeKeyInfo`; `LockedSecret` += `'compute_key'`; `KeyDetectionState.target?: 'inference' \| 'compute'`; `AuthApi.setComputeKey(key)`, `removeComputeKey()`, `revalidateComputeKey()`; `startKeyDetection(target?: 'inference' \| 'compute')`. |
| `contracts/usage.ts` | `SpendKind` += `'compute' \| 'agent'`; `LocalSpend.computeUsd?: number; agentUsd?: number`. |
| `services/usage/{ledger,budget,index}.ts` | The ledger's `KINDS` accept `agent` and `compute`, and `totalsSince` gets `agent` and `compute` buckets that are not counted as media (today `KINDS` is `{chat, media}` and every non-chat kind counts as media; verified). `BudgetSources` implementation; `BudgetGuard.statusSnapshot()` (synchronous, for the gateway's check-and-insert). |
| `core/store.ts` | `durableWriteFile(path, data, mode?)`: write the temp file, `filehandle.sync()`, rename, then fsync the directory. Today's `atomicWriteFile` renames without any fsync (verified). Used by the compute journal and registry and by the gateway's thread ledger. |
| `contracts/app.ts` | `PageId` += `'compute' \| 'code'`. |
| `contracts/index.ts` | `GmiApi.compute: ComputeApi; computer: ComputerApi; code: CodeApi` (harness); `API_NAMESPACES` and `EVENT_NAMES` extended; `export type * from './compute'` and `'./code'`. |
| `shared/app.ts` | `GMI_URLS.consoleApiV2 = 'https://console.gmicloud.ai/api/v2'`. `CONSOLE_PAGES` += `computeHome: '/user-console/ce'`, `computeUsage: '/user-setting/ce/usage-billing/usage'`, `computeCredits: '/user-setting/ce/usage-billing/credits-and-payment'`, `sshKeys: '/user-setting/ce/access/ssh-keys'`, `containers: '/user-console/ce/containers'`, `elasticIps: '/user-console/ce/elastic-ip'`, `firewalls: '/user-console/ce/firewalls'`. New `consoleDeepLink(kind: 'container', id: string, view)`: UUID-validated id, fixed path suffixes, through the sign-in callback. |
| `core/services.ts` | `ComputeKeyProvider` (below); `SpendSource` + `BudgetSources` (below); `GmiGateway` (harness.md §13.2); `registerDiagnosticsAction()` (dev-only Diagnostics actions: probes, eval recording). |
| `src/main/slices/{gateway,compute,computer,harness,code}.ts` | One registration file per feature, imported once by `src/main/index.ts`. F0 creates them as stubs (APIs throw `not_implemented`); each is then owned by one later slice (§21.0). |
| `core/context.ts` | `Platform.pickFiles(opts): Promise<string[] \| null>`, `pickSavePath(opts:{title; defaultName}): Promise<string \| null>`, `pickDirectory(opts:{title}): Promise<string \| null>`. `AppContext.installId: string` (random 16 bytes hex, `data/install.json`, not secret). |
| `core/shutdown.ts` | `registerQuitCheck(check: () => Promise<'quit' \| 'cancel'>)`, run before the dispose phase (C1-D supplies compute's). |
| `core/preview-host.ts` (C2) | `PreviewHost` interface + Electron implementation (below). |
| `core/dev-env.ts` | `DEV_ENV_VARS` += `GMI_DESK_MOCK_COMPUTE`, `GMI_DESK_MOCK_CODE`, `GMI_DESK_TRACE`. |
| `core/logger.ts` | `SECRET_KEY_PATTERN` += `urlpath\|connect_url\|access_token\|traffic\|private_?key\|ssh_?key\|env_vars`; JWT-shaped values are already redacted. `sanitize` is exported for the dev trace writers (§17). |
| `renderer/lib/store.ts` | `openConnect(target?: 'inference' \| 'compute')`; `overlayCount` + `pushOverlay()/popOverlay()` used by dialog, popover, menu and palette; `dock: {open, width, resourceId}` per page. |
| `renderer/pages/{registry.compute,registry.code}.ts`, `pages/settings/sections.ts` | Per-feature page registration and the Settings section list, so later slices never edit the shared registry. |

```ts
// core/services.ts (additions)
export interface ComputeKeyProvider {
  getComputeKey(): Promise<string | null>;
  /** Throws GmiError('no_compute_key'). */
  requireComputeKey(): Promise<string>;
  /** 401 → key marked invalid. 403 is never treated as a dead key (not entitled / permission). */
  reportInvalidComputeKey(reason: string, key?: string | null, status?: number | null): Promise<void>;
  onChange(listener: () => void): () => void;
}

/** Spend that is not in the ledger (continuous accrual), summed into budget status. */
export interface SpendSource {
  readonly kind: SpendKind;
  /** Estimated USD since `since` (list price). */
  totalSince(since: Date): number;
  /** Current burn rate (USD per hour) for projections. */
  burnUsdPerHour(): number;
}

export interface BudgetSources {
  register(source: SpendSource): () => void;
}

// core/preview-host.ts
export interface PreviewHostCreate {
  id: string;
  url: string;
  /** Exact host allowed for top-level navigation. */
  allowedHost: string;
  /** Header added only to requests whose host equals allowedHost. */
  inject: { name: 'traffic-access-token'; value: string } | null;
}
export type PreviewHostEvent =
  | { id: string; type: 'state'; state: 'loading' | 'ready' | 'failed' | 'crashed'; detail?: string | null }
  | { id: string; type: 'navigated'; url: string; title: string | null; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'blocked'; url: string; reason: 'navigation' | 'popup' | 'download' | 'private_network' | 'scheme' }
  | { id: string; type: 'activity' };
export interface PreviewHost {
  create(opts: PreviewHostCreate): void;
  updateInject(id: string, inject: PreviewHostCreate['inject']): void;
  setBounds(id: string, bounds: { x: number; y: number; width: number; height: number } | null): void;
  command(id: string, command: 'reload' | 'back' | 'forward' | 'stop'): void;
  capture(id: string): Promise<string | null>;
  destroy(id: string): void;
  onEvent(listener: (event: PreviewHostEvent) => void): () => void;
}
```

---

## 14. Main-process modules (`src/main/services/compute/`)

| File | Responsibility |
|---|---|
| `index.ts` | `createComputeSlice(ctx, {auth, keys: ComputeKeyProvider, budget, budgetSources, catalog})` → `{api: ComputeApi, computer: ComputerApi, broker, quitCheck, dispose}`. Mock wiring when `ctx.mock`. |
| `types.ts` | Internal interfaces (frozen by C1-0): `Registry` (incl. `inflightExecs` and `actionPending`), `Supervisor`, `Guard`, `ActivitySink` (user and active-agent activity kinds only), `ExecPort` (`acquire({priority: 'user' \| 'agent'})` with the agent cap of 6, release at a terminal state, `cancel(eid)`), DTO re-exports. |
| `ce/dto.ts`, `sandbox/dto.ts` | Hand-written DTOs from `service_api.yaml` / `sandbox_api.yaml`; spec SHA-256 recorded in the header (re-check script in §21). |
| `errors.ts` | All error shapes → `GmiError`: CE `{reason}`, IAM `{group, code, message, traces, validationDetail}`, both 401 variants, billing `{error}`, v2 dotted `{code, message, request_id, details}` (`Auth.*`, `Resource.*`, `RateLimit.Exceeded`, `IDC.UnderMaintenance`, `Sandbox.*`, `Execution.*`, `Shell.*`). `traces` → debug log only. |
| `sanitize.ts` | §5.2 rules; `redactContainer`, `redactTemplate`, `filterPublicProducts`. |
| `catalog.ts` | Sources, cache, schedule, aggregation, price join. |
| `ce/client.ts` | Thin CE client over `ctx.http` (`retries: 0` for every POST/PUT/DELETE; GET retries 2). |
| `sandbox/client.ts` | v2 control plane (Idempotency-Key on create; list paging). |
| `sandbox/dataplane.ts` | Exec (wait 25 s + poll), files (stream upload/download), shell control; `TokenCache` (memory, single-flight `connect`). |
| `registry.ts` | `data/compute-resources.json` (`durableWriteFile`): managed resources, leases, `actionPending`, in-flight execution ids, billing intervals, services, tombstones (90 days). |
| `journal.ts` | `data/compute-journal.json` (`durableWriteFile`): write-ahead create entries; unresolved entries never pruned (§6.2). |
| `names.ts` | Install tag, name slug + nonce, metadata labels, match rules (this install / another install / unmanaged). |
| `supervisor.ts` | Adaptive polling, state mapping (§6.5, §7.4), reconcile, per-resource mutex, clock skew. |
| `ce/create.ts`, `ce/network.ts` | Create + reconcile; EIP/firewall saga and teardown. |
| `sandbox/lifecycle.ts` | Create, pause, resume (cold), extend, snapshot, delete. |
| `sweep.ts` | Orphans, tombstones, paused-long, EIPs. |
| `pricing.ts`, `accrual.ts`, `guard.ts`, `alarms.ts` | Prices, intervals → totals (`SpendSource`), leases, idle, budget actions, alarm store and notification throttle, quit check. |
| `computer/session.ts` | Session manager, `ExecPort` (10 slots, user first, agent ≤ 6, held until terminal, cancel, persisted eids), activity, services. |
| `computer/shell-v2.ts`, `computer/ring-buffer.ts`, `computer/flow.ts` | Shell bridge, reconnect, take over, ack flow control. |
| `computer/exec.ts`, `computer/files.ts`, `computer/transfers.ts`, `computer/ports.ts` | §8.3–8.4. |
| `computer/preview.ts` | Preview manager over `PreviewHost` (host lock, inject, activity). |
| `computer/shell-ce.ts`, `computer/ssh.ts` (C2-E, gated) | CE shell adapter or SSH. |
| `broker.ts` (H4) | Grants for the harness's sandbox MCP (harness.md §10.4). |
| `src/main/mock/compute.ts` + `fixtures/compute/` | Mock simulators (§16). |

## 15. Renderer

| Path | Content |
|---|---|
| `pages/compute/index.tsx` | Page shell; tabs **Resources · Launch · Network · Snapshots** (Base UI tabs, `data-active`); signed-out/no-key states. URL params: `tab`, `resource`, `step`, `idc`. |
| `pages/compute/ResourceList.tsx`, `ResourceRow.tsx` | Managed resources first; "Show all in organization" toggle (unmanaged rows read-only); phase badge (Plates when working), $/h, accrued, lease countdown. |
| `pages/compute/ResourceDetail.tsx` | Header (name, phase, Open computer = the lime action, Delete), Overview, Network, Logs (CE), Lease editor, History. |
| `pages/compute/launch/*` | Wizard steps (template, IDC, size, options, review) with `CreateQuote` lines, budget line, warnings; `LeaseEditor.tsx`; `AccessStep.tsx` (EIP/firewall choice + CIDR + opt-in Detect). |
| `pages/compute/NetworkTab.tsx`, `SnapshotsTab.tsx`, `AlarmBanner.tsx`, `PriceTag.tsx`, `hooks.ts`, `format.ts` | |
| `components/connect/ConnectComputeDialog.tsx` | §4.1 (shares parts with ConnectChatDialog). |
| `pages/settings/ComputeKeySection.tsx` | Status, last4, entitlement chips, re-verify, remove (with "resources keep billing"). |
| `components/computer/ComputerDock.tsx` | Resizable dock, resource picker, tabs, status bar. |
| `components/computer/TerminalView.tsx` | xterm + fit addon, theme from CSS variables (re-themed on `app:settings`), ack loop, paste chunking, link provider. |
| `components/computer/FileTree.tsx`, `FilePreview.tsx`, `TransferList.tsx` | Lazy tree, text preview/editor (plain textarea with mono font in v1), transfers. |
| `components/computer/PortsView.tsx`, `PreviewPane.tsx` | Ports list with Open; preview slot that reports bounds (ResizeObserver + rAF) and shows the captured image while `overlayCount > 0`. |
| `components/computer/StatusBar.tsx` | §8.5. |

Command palette entries: "Open computer…", "New sandbox", "New container", "Compute: show alarms", and "Connect
Compute". The Compute nav item badge shows the alarm count.

---

## 16. Mock mode and fixtures

- **`GMI_DESK_MOCK=1`** → `src/main/mock/compute.ts` runs **simulators** of the CE and v2 APIs behind the same client
  interfaces:
  - phases progress on timers (`creating` 3 s → `running`; pause and resume 2 s);
  - the data plane runs a fake filesystem;
  - the fake PTY echoes input and runs `ls`, `pwd`, `cd`, `cat`, `echo`, `clear`, `uname -a`, `nvidia-smi` (canned)
    and `python3 -m http.server 8000` (registers a listening port);
  - the preview in mock mode is a renderer placeholder card (no `WebContentsView`), so offscreen screenshots work.
- **`GMI_DESK_MOCK_COMPUTE=<flags>`** (mock only; added to `DEV_ENV_VARS`): `no_key`, `not_entitled`,
  `sandboxes_only`, `create_fails`, `create_unknown`, `orphan`, `orphan_other_install`, `eip_orphan`, `budget_low`,
  `no_daily_budget`, `lease_expiring`, `lease_action_failed`, `org_billing`, `paused`, `cold_resume`, `shell_busy`,
  `api_down`, `price_unknown`.
- **Fixtures** (`src/main/mock/fixtures/compute/`): `idcs.json`, `public-templates.json`, `billing-products.json`,
  `account-products.json`, `containers.json`, `sandboxes.json`, `snapshots.json`, `eips.json`, `firewalls.json`,
  `logs.txt`.
  - **Synthetic**, written by hand to the documented schema. Recorded feed rows are never copied.
  - Org ids are `00000000-0000-0000-0000-000000000000`; IPs come from `203.0.113.0/24` (TEST-NET-3); no descriptions;
    only allowlisted generic SKUs.
  - `test/compute/fixtures.test.ts` enforces all of these rules (ground rule 6).
- **Screenshots** (F0 adds `compute` and `code` to `PAGES`):
  - `compute`, `compute?tab=launch&step=review`, `compute?resource=cr_mock_sb1`, `compute?tab=network`;
  - `chat?dock=1&resource=cr_mock_sb1` (terminal), `…&dockTab=files`, `…&dockTab=preview`;
  - every one in both themes, plus states from mock flags.

---

## 17. Observability (structured, no secrets)

- **Scoped logger children:** `compute.catalog`, `compute.ce`, `compute.v2`, `compute.supervisor`, `compute.guard`,
  `compute.sweep`, `computer.shell`, `computer.files`, `computer.preview`.
- **Events, info level, one JSON `meta` object each:**
  - `resource.transition {rid, kind, from, to, raw}`;
  - `create.journal {rid, state}`;
  - `guard.action {rid, action, reason, usdPerHour}`;
  - `alarm.raised {kind, rid}`;
  - `shell.state {sid, from, to, code}`;
  - `transfer.done {sid, dir, bytes, ms}`;
  - `preview.blocked {pid, reason, host}`.
  - Request ids (`x-gmi-request-id`, v2 `request_id`) are included for support.
- **Never logged:**
  - keys, tokens, the `urlPath`, env values;
  - file contents, terminal bytes;
  - full preview URLs with query strings;
  - public IPs (debug level only);
  - `traces` (debug level only).
- **Dev trace (`GMI_DESK_TRACE=1`, stripped when packaged).** Writes control-plane response bodies to
  `logs/trace-compute-*.jsonl`, first through the compute sanitiser (§5.2) and then through the logger's key-name
  `sanitize()` (which already matches `token`), so `sandbox_access_token`, `traffic_access_token`, `connect_url` and v2
  `env_vars` values never reach a trace. **Data-plane bodies are never traced** (exec stdout and stderr, `/files`
  content): only status, sizes and request ids. Trace files written during a live session are deleted when it ends
  (C-live checklist). A test asserts that a recorded create and connect response contains no token value. This is what
  probes and fixture refreshes use.
- **Diagnostics** (Settings › About): poll cadence, last poll, API health, open sessions, ws reconnects, exec slots,
  unacked bytes, guard tick time.

## 18. Performance budgets

| Item | Budget |
|---|---|
| Compute page first paint (cached catalog + registry) | < 300 ms after navigation |
| Catalog refresh (3 public feeds, filtered by IDC) | < 3 s p95; the 43 KB feed parses in < 20 ms |
| Polling load | ≤ 1 list request / 5 s per backend while transitional, ≤ 1 / 60 s steady; detail calls only for open sessions |
| Keystroke → echo overhead added by the app (IPC + ws) | < 15 ms p95 on top of network RTT |
| Terminal throughput | ≥ 5 MB/s output without main event-loop lag > 50 ms; IPC chunks ≤ 64 KiB every 16 ms |
| Memory per session (main) | ring buffer 1 MiB + token cache; xterm scrollback 5,000 lines |
| Directory listing (1,000 entries) | < 1.5 s (one exec, 25 s wait cap) |
| Preview view creation | < 500 ms to first paint after the URL resolves |
| Main event-loop lag with 4 sessions | < 50 ms p99 |
| Guard tick (100 resources) | < 10 ms |
| CE log polling | ≤ 1 MiB of main memory per resource, whatever the log size; no auto-poll above 10 MB without Range |

## 19. New dependencies (C2)

| Package | Version (pinned) | License | Size | Why / alternatives |
|---|---|---|---|---|
| `ws` | **8.22.0** (2026-09-26; 8.22.1 is 2 days old: rule ≥ 14 days) | MIT | 152 KB unpacked, 0 dependencies | Main-side WebSocket with custom headers (`X-Access-Token`, `Authorization`), handshake status (`unexpected-response` → 409 `Shell.AlreadyAttached`), `pause()`/`resume()` for backpressure, ping/pong, and `WebSocketServer` for the tests. Node's global `WebSocket` cannot read handshake statuses. The esbuild main bundle marks the optional `bufferutil`, `utf-8-validate` as external (ws falls back to JS). |
| `@xterm/xterm` | **6.0.0** (2025-12-22) | MIT | 5.9 MB unpacked (several builds + typings); adds about 0.3 MB minified to the renderer (measure in C2-D) | The de-facto web terminal: ANSI/VT, binary-safe writes with callbacks (for acks), link provider, themeable. CSP-compatible (`style-src 'unsafe-inline'` is already allowed). |
| `@xterm/addon-fit` | **0.11.0** (2025-12-22) | MIT | 21 KB | Fits cols/rows to the dock. |
| *(conditional)* `ssh2` | 1.17.0 (2025-08-20) | MIT (LICENSE; package.json uses the legacy `licenses` field) | 1.1 MB unpacked; dependencies `asn1`, `bcrypt-pbkdf`; optional native `cpu-features`/`nan` → **excluded**, pure-JS path | Only if P-CE shows the CE shell `urlPath` cannot be used (§8.8): PTY + SFTP + port forwards over one connection. |

**Not added:**
- `@xterm/addon-webgl` (2.3 MB; the DOM renderer is enough at dock sizes);
- `@xterm/addon-search` (later);
- `@xterm/addon-clipboard` (OSC 52 risk);
- `openapi-typescript` (DTOs are hand-written with pinned spec hashes; fewer moving parts);
- `node-pty` (no local terminal in C1/C2; it is a native module).

## 20. GMI facts still unverified, and the cheapest probe for each

All probes run **through the app**, using a dev-only "Run compute probes" action in Settings › Diagnostics:
- it is gated by `!app.isPackaged`;
- it needs the user present, under ground rule 9;
- every paid step pauses for the native confirmation;
- `GMI_DESK_TRACE=1` records sanitised responses.

The compute key never leaves main, so no shell or key paste is needed (ground rules 3 and 9). **Free** = no spend, but
the user's key must be added first. **Paid** = explicit approval in the conversation and a budget set first.

| Id | Unverified fact | Probe | Cost / needs |
|---|---|---|---|
| U1 | A `ce_resource` key is accepted by `GET /api/v1/containers` (200/403) | P-free-1 | free; key |
| U2 | The same key is accepted by v2 `GET /api/v2/sandboxes?page_size=1` | P-free-2 | free; key |
| U3 | Compute keys are HS256 JWTs (clipboard detection) | Validation metadata at Connect Compute (alg from the JWT header only, never logged) | free; key |
| U4 | `/api/v1/me/ssh-keys` accepts API keys | P-free-3 `GET /me/ssh-keys` | free; key |
| U5 | `/containers/products?idc=` shape; `name == billing instanceType` | P-free-4 for 2 IDCs | free; key |
| U6 | v2 `/products` and `/templates` shapes per IDC | P-free-5 | free; key |
| U7 | Sandbox SKU prices = public `gmi.sandbox.*` | P-free-6 `GET https://api.gmi-serving.com/v1/agents/products?idc_name=…&runtime=sandbox` (compare) | free; key |
| U8 | v2 metadata limits, `secure` traffic token header, `{port}-{key}.{domain}` routing, WS/HMR pass-through, idle timeouts | **P-SB**: one `gmi.sandbox.small`, `timeout: 300`, `secure: true`, egress allowlist incl. `pypi.org`, our 5 labels; `python3 -m http.server`, then a preview; a WS echo (`python3 -c` websockets server if available, else skipped) | paid ≈ **$0.02** (≤ 15 min × $0.0911/h list) |
| U9 | Shell binary protocol, resize, keepalive / idle timeout, stale attach after a network drop | P-SB (drop the Wi-Fi for 30 s, or kill the socket from Diagnostics) | in P-SB |
| U10 | Exec `wait`/poll, truncation flags, `envs` passing, 10-exec cap, `cancel` on a running execution | P-SB | in P-SB |
| U21 | v2 list `state` filter: does it take several values, and does `deleted` appear with `metadata[rid]` | P-free-2 variant (a list call; free) and P-SB after its delete | free / in P-SB |
| U11 | Pause semantics (memory kept or cold) in that IDC; token re-sign on resume; `auto_pause` availability | P-SB: start `sleep 1000 &`, pause, resume, check `ps` | in P-SB |
| U12 | Snapshot create time and size; scrub flow; launch from a snapshot | P-SB: snapshot, then delete (no launch) | in P-SB (+ storage price `[U]`, ask GMI) |
| U13 | Egress allowlist enforcement | P-SB: `curl -sS https://example.com` fails, `https://pypi.org` works | in P-SB |
| U14 | CE shell `urlPath`: host, protocol (frames), TTL, single use, concurrency cap; `Range` on `/logs` | **P-CE**: one `gmi.container.intel.x4660.large` (CPU) from an official template; call `/shell`; open the WS from main with the trace on; one `Range: bytes=-1024` request on `/logs` | paid ≈ **$0.02** (≤ 20 min × $0.0475/h), up to $0.05 if billed hourly |
| U15 | CE: billing starts at `creating`? per-minute granularity; restart keeps the ephemeral disk; `publicIP` without EIP; SSH user | P-CE (write a file, restart, check it); the user reads the console usage page an hour later | in P-CE |
| U16 | CE list consistency right after create (the reconcile window) | P-CE: list immediately after the 200, then every 1 s | in P-CE |
| U17 | EIP association, ordering and release; firewall rule application | **P-CE-EIP** (only if the SSH fallback is needed): allocate, associate, firewall /32, SSH, tear down | paid ≈ $0.04 (≤ 20 min × $0.10/h), up to $0.10 hourly |
| U18 | CE `stopped`/`zombie` triggers; behaviour at zero/negative balance; prepaid vs PAYG for API creates | **Ask GMI** (never probed: it would mean running out of credit) | — |
| U19 | Rate limits and quotas (CE, v2, per-org concurrent creates) | Observe headers in all probes + ask GMI | — |
| U20 | Pause billing after Early Access; snapshot and paused-disk storage prices | Ask GMI | — |

**Paid total** (all three probes, worst case): about **$0.20** list. Each probe tears down whatever happens (a
`finally` sweep plus a server timeout of 300 s for the sandbox).

---

## 21. Implementation plan

**Ownership rules (as D9).**
- **F0 (§21.0) runs first, alone.** After it, the compute track (C1 → C2) and the harness track (harness.md §24:
  H1 → H2 → H3) run in parallel; they own disjoint files. H4 starts after both C2 and H3.
- Each phase starts with a phase-0 slice (C1-0, C2-0) that owns only that phase's internal interfaces and its
  registration file under `src/main/slices/`.
- Each slice owns exactly the files listed, plus its tests. Anything else is requested from the phase-0 owner or the
  integrator. A stub created by F0 has exactly one later owner (the hand-over list below).
- Contracts are frozen after F0; additive fixes are collected and applied by an integrator at a sync point, never by
  two slices.
- Every slice ends with `npm run check` green, and screenshots in both themes for UI slices.
- Per AGENTS.md: no commits unless asked. `docs/{STATUS,DECISIONS,ARCHITECTURE}.md` and `AGENTS.md` are edited only by
  each phase's integrator step, and the integrator steps of the two tracks never run at the same time.

### 21.0 Shared foundation F0 (both documents; runs first, alone)

F0 owns every file that compute.md and harness.md both change outside their own slices, so the two tracks never touch
the same file afterwards.

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **F0 Shared foundation** | `src/shared/contracts/{index,errors,usage,auth,app,compute,gateway,code}.ts`; `src/shared/{app.ts, lib/money.ts}`; `src/main/core/{services,context,shutdown,dev-env,logger,store}.ts`; `src/main/ipc/registry.ts`; `src/main/index.ts`; `src/main/slices/{gateway,compute,computer,harness,code}.ts` (stubs); `src/main/services/usage/{ledger,budget,index}.ts`; `src/main/dev/screenshots.ts`; `scripts/{screenshots.mjs, build-electron.mjs}`; `tsconfig.node.json`; `vitest.config.ts`; `src/harness/host.ts` (stub entry); `src/renderer/{App.tsx, lib/**, components/shell/**, components/ErrorNotice.tsx}`; `src/renderer/pages/{registry.ts, registry.compute.ts, registry.code.ts, StubPage.tsx}`; `src/renderer/pages/settings/sections.ts`; `src/renderer/pages/usage/index.tsx` (mount only); stubs `src/renderer/components/computer/ComputerDock.tsx`, `src/renderer/pages/usage/GatewayCard.tsx`, `src/renderer/pages/code/settings/index.tsx`; `test/core/**`; `test/helpers/**`; `test/usage/{ledger-kinds,budget-sources}.test.ts` | Every contract type of both documents (§13 here, harness.md §13), frozen; error codes, hints and ErrorNotice actions; `SpendKind` `agent`/`compute` with ledger buckets that are not counted as media; `SpendSource` / `BudgetSources` and a synchronous `BudgetGuard.statusSnapshot()`; `durableWriteFile`; the money `cacheWriteTokens` term; Platform pickers; `installId`; the quit-check hook; the Diagnostics action registry; `DEV_ENV_VARS`; logger patterns and an exported `sanitize`; stub `compute`, `computer` and `code` APIs (methods throw `not_implemented`) registered through `src/main/slices/*`; Compute and Code nav items (§22), palette entries, query keys, event hooks (`useComputeEvents`, `useCodeEvents`), store additions (`openConnect(target)`, `overlayCount`, `dock`); the dock stub mounted in `App.tsx`; the harness bundle entry (stub) and `ws` externals in the build; screenshot pages `compute` and `code` | `npm run check`; contract tests for every new namespace and event (method names match the interfaces, `ERROR_HINTS` complete); a ledger test that `agent` entries count toward `total` and not `media`; `durableWriteFile` order (write, `sync`, rename, directory `fsync`) on a fake fs; logger redaction of the new key names; screenshots of both stub pages, both themes |

**Hand-overs** (each stub has exactly one later owner, in this order): `slices/gateway.ts` → H1-0;
`slices/compute.ts` and `pages/registry.compute.ts` → C1-0; `slices/computer.ts` → C2-0; `slices/harness.ts` and
`src/harness/host.ts` → H2-0; `slices/code.ts` and `pages/registry.code.ts` → H3-0;
`components/computer/ComputerDock.tsx` → C2-D; `pages/usage/GatewayCard.tsx` → H1-D;
`pages/code/settings/index.tsx` → H3-C.

**Global order:** F0 → { C1 → C2 } ∥ { H1 → H2 → H3 } → H4.

### Phase C1: compute core (containers + sandboxes management, cost guard; no terminal)

**Order:** C1-0 → (C1-A ∥ C1-B) → (C1-C ∥ C1-D ∥ C1-E) → review (4 lenses: security, GMI integration, cost,
UX) → fixers by area → integrator → **C-live-1** (user).

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **C1-0 Compute interfaces** | `src/main/services/compute/{index.ts (stub), types.ts, ce/dto.ts, sandbox/dto.ts}`, `src/main/slices/compute.ts` (F0's stub), `src/renderer/pages/registry.compute.ts` (F0's stub), `test/compute/types.test.ts` | Frozen internal interfaces (§14 `types.ts`: `Registry` with `inflightExecs` and `actionPending`, `Supervisor`, `Guard`, `ActivitySink`, `ExecPort` with `acquire({priority})`, terminal-state release and `cancel`); DTOs; the `compute` namespace served by the slice stub; the Compute page stub registered | `npm run check`; screenshots `compute` (stub) dark + light |
| **C1-A Compute key** | `src/main/services/auth/**`, `test/auth/**`, `src/renderer/pages/settings/**` except `sections.ts`, `src/renderer/components/connect/**` | Secure `compute.key`; set/remove/revalidate; scope check (`ie_model` → "use for chat?"); `ComputeKeyProvider`; detection `target`; session-only storage on `basic_text` unless confirmed natively; Connect Compute dialog; Settings section; mock auth flags `no_compute_key, compute_key, compute_key_invalid, compute_key_locked, basic_text`. | Key never in `AuthState`/IPC (test serialises every API result); 401/403 semantics; locked keychain keeps metadata; `basic_text` → not persisted without the native confirm; detection excludes stored keys; the dialog renders every state (react-dom/server markup tests) + screenshots `*?connect=compute` both themes. |
| **C1-B Catalog + clients** | `src/main/services/compute/{catalog.ts, sanitize.ts, errors.ts, ce/client.ts, sandbox/client.ts, sandbox/dataplane.ts}`, `src/main/mock/compute.ts`, `src/main/mock/fixtures/compute/**`, `test/compute/{catalog,sanitize,errors,ce-client,sandbox-client,dataplane,fixtures,trace}.test.ts`, `test/compute/fakes/**` | §5, §6.4 logs client (Range probe, streaming ring), §7.2 token cache, exec/files primitives (explicit `execution_timeout_seconds`, `cancel`), the trace writer rules of §17, simulators + fixtures. | Every error shape → the right code; only a 400/401/403/404/422 with a parsed GMI body maps to "failed"; the sanitiser drops descriptions, credentials and env values; a recorded create/connect trace holds no token; no customer SKU in fixtures (allowlist test); idempotency header present; POST never retried (fake-fetch call counts); exec wait → poll; upload `[]` → error; Range resume only on 206; a 200 MB log without Range keeps memory bounded and stops auto-polling. |
| **C1-C Lifecycle** | `src/main/services/compute/{index.ts (from stub), service.ts, registry.ts, journal.ts, names.ts, supervisor.ts, ce/create.ts, ce/network.ts, sandbox/lifecycle.ts, sweep.ts}`, `test/compute/{registry,journal,create,network,lifecycle,supervisor,sweep,service}.test.ts` | `ComputeApi` except guard-specific methods (stubs call into the C1-D interface); §6.1–6.6, §7.1, §7.3–7.5: durable journal, unresolved entries kept, install-tagged names, outcome mapping, "Try again" with a native dialog, CIDR rules with native dialogs, managed-only `releaseEip`, `adopt`, the secret-substring check, sandbox reconcile by listing (incl. `deleted`), the sweep's orphan alarms and org banner, registry storage of `inflightExecs` and `actionPending`. | Crash between journal and POST → reconcile; timeout, 429, HTML page, odd 200 → `unknown` → reconcile by name, no second POST; a late container is adopted on a later sweep; another install's `gmid-` container → read-only alarm; saga failure → degraded + alarm; teardown order; sweep never touches untagged resources without adopt; `allowCidrs: ['0.0.0.0/0']` without `allOpen` still triggers the native dialog; a substring secret in env/command/args is refused; polling cadence (fake timers); per-resource mutex; native confirm called for create/resume/delete/extend beyond lease/open CIDRs/release EIP/adopt (FakePlatform `confirms`). |
| **C1-D Cost guard** | `src/main/services/compute/{pricing.ts, accrual.ts, guard.ts, alarms.ts}`, `src/renderer/pages/usage/LocalSpend.tsx`, `test/compute/{pricing,accrual,guard,alarms,quit}.test.ts` | §9 entirely: required daily budget, committed burn in projections, explicit `onBudget`, delete-sooner dialogs, `actionPending` retries, clock-gated destructive catch-up, user-only idle activity; `SpendSource` registration; Usage "This device" compute row; quit check. | Accrual across pause/resume/app-closed gaps (fake clock); today/month by local time; lease warnings T−15/5/1; expiry actions; a failed delete is retried and alarms after 3; local clock at +30 days → no delete before GMI's time is known; idle pause with streaming output and an HMR preview open; budget-exhausted actions per kind; a `setLease` that deletes sooner needs a native confirm; unknown price blocks create when enforced; alarm deduplication and throttling; existing budget tests still pass. |
| **C1-E Compute page** | `src/renderer/pages/compute/**`, `test/compute/ui-*.test.tsx` | §15 page, wizard (inline "Set a daily budget", `onBudget` choice, CIDR warnings), network, snapshots, alarms (adopt, org banner), signed-out browse. | Markup tests per state; D16–D18 rules (one lime fill per screen, no native `<select>` — the ui-kit test already enforces this); screenshots: list, detail, wizard review, network, signed out, `budget_low`, `no_daily_budget`, `orphan`, `orphan_other_install`, `eip_orphan`, `org_billing`, both themes. |

**C-live-1 (needs the user; free).** `npm run dev` with `GMI_DESK_TRACE=1`.
1. The user adds a Compute key through Connect Compute.
2. Run P-free-1…6 and the U21 list call.
3. Compare the traces with the DTOs; fix the DTOs and normalisers with regression tests; refresh the fixtures
   (sanitised); delete the trace files.
4. The integrator updates STATUS.md.

### Phase C2: the computer panel

**Order:** C2-0 → (C2-A ∥ C2-B ∥ C2-C ∥ C2-D) → **C-live-2** (user, paid P-SB) → fixes → **C-live-3** (user, paid
P-CE) → C2-E (gated) → review + fixers → integrator.

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **C2-0 Foundation** | `package.json` + lockfile (`ws@8.22.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`), `src/main/core/preview-host.ts`, `src/main/window.ts`, `src/main/slices/computer.ts` (F0's stub), `src/renderer/components/ui/**` (overlay counter wired into dialog, popover, menu and command), `test/core/preview-host-policy.test.ts` | `PreviewHost` (Electron) with the §8.4 policy as pure functions (URL builder, host lock incl. `did-start-navigation`, private-IP block, inject filter) + Electron glue; the overlay counter in the ui kit; the `computer` namespace registered from the slice. | Policy unit tests (IPv4/IPv6 private ranges, `.local`, scheme block, exact-host inject, `@evil.example/` and `//evil` paths, port range); `app://` not handled in a preview partition and Local Network Access denied (Electron smoke test via the screenshot runner); bundle builds with `ws` (externals from F0); CSP unchanged. |
| **C2-A Shell bridge** | `src/main/services/compute/computer/{session.ts, shell-v2.ts, ring-buffer.ts, flow.ts, index.ts}`, `test/compute/computer/{session,shell,flow,ring,execport}.test.ts` | §8.1–8.2, §8.7; the `ComputerApi` terminal methods + session lifecycle; `ExecPort` (priority, slots held until terminal, cancel, persisted eids reconciled on open); visibility-gated flow control; replay soft reset + resize nudge; the input FIFO; `ws` options. | Against a `ws` `WebSocketServer` fake: binary only (a text frame never sent), resize debounce, 409 → `attached_elsewhere`, take over → `control close` after a native confirm, 401 → `connect` → reattach, backoff schedule, pause/resume at 512/128 KiB only while visible, a closed dock with 10 MB of output never pauses the ws, reload mid-stream then attach resumes, an oversized frame is refused, replay after reattach, no `exit` ever sent; a 25 s wait timeout keeps the slot; abort sends cancel. |
| **C2-B Files, ports, services** | `src/main/services/compute/computer/{exec.ts, files.ts, transfers.ts, ports.ts, services.ts}`, `test/compute/computer/{exec,files,transfers,ports,services}.test.ts` | §8.3–8.4 (detection only while visible), §8.5 usage snapshot; app-originated execs marked as non-activity. | Paths only through env (asserted on request bodies); NUL listing parser + busybox fallback; path normaliser rejects `..`, NUL, relative paths; picker/save dialogs from FakePlatform; `.part` + rename; `/proc/net/tcp` parser; the port scan never counts as activity. |
| **C2-C Previews** | `src/main/services/compute/computer/preview.ts`, `test/compute/computer/preview.test.ts` | Preview manager over `PreviewHost` (fake in tests): open (URL built in main), bounds, commands, token refresh → `updateInject`, input-only activity → guard, blocked events. | Exact-host inject only; `X-Access-Token` never present; a renderer path cannot change the host; external open needs a confirm; previews close with the session. |
| **C2-D Renderer computer** | `src/renderer/components/computer/**` (F0 created the `ComputerDock.tsx` stub), `test/computer/ui-*.test.tsx` | §8.6 dock, terminal, files, ports, preview slot, status bar; terminal theme from tokens; link provider; `terminalVisibility` reporting. | Markup tests; screenshots (mock) of terminal/files/ports/preview placeholder/paused banner/attached-elsewhere in both themes; ack loop and visibility reporting unit-tested with a fake xterm. |
| **C2-E CE computer** (after P-CE) | `src/main/services/compute/computer/{shell-ce.ts, ssh.ts, logs-tail.ts}`, `test/compute/computer/{shell-ce,ssh,logs}.test.ts` (+ `ssh2` in package.json by the C2 integrator, if chosen) | §8.8 per the probe result. | The `urlPath` never logged; host-key pinning; SFTP mapped to `FileService` semantics. |

**C-live-2 (user; paid ≈ $0.02).** Budget set, then P-SB through Diagnostics with the user approving each native
dialog. Verify U8–U13 and U21, then fix.

**C-live-3 (user; paid ≈ $0.02–0.05, optional EIP +$0.04).** P-CE, which decides C2-E.

---

## 22. Decisions to record (proposed; the integrator adds them to DECISIONS.md)

- **D19: Compute slice architecture.**
  - The compute key is owned by auth (DC1).
  - Sandbox API v2 only (DC2).
  - CE create journal and no retry (DC3).
  - Native confirmation for anything that starts or extends billing (DC4).
- **D20: Compute cost guard.**
  - Leases: delete by default for containers, pause for sandboxes; idle pause on user activity only; `SpendSource`
    budgets with committed burn; a daily budget required before the first container; actions retried until they
    succeed; destructive catch-up only on GMI's clock; alarms, including other installs' `gmid-` containers and an
    org-wide billing banner; quit check; startup catch-up (DC5, DC6).
  - Durable (fsynced) create journal; unresolved entries never pruned; install-tagged names.
  - Network exposure beyond one /32 needs a native dialog; only managed EIPs are released.
- **D21: The computer panel.**
  - v2 data plane, `ws` + xterm.js, invoke/event flow control; `WebContentsView` previews with an in-memory partition
    and exact-host token injection; the CE transport decided by P-CE (DC7–DC9).
- **Open, for the user:**
  1. Nav shortcuts. This design proposes **Code = ⌘/Ctrl+6** and **Compute = ⌘/Ctrl+7** and keeps 1–5 unchanged.
     The alternative is to reorder to Chat, Code, Compute, Models…, which breaks existing muscle memory.
  2. A tray icon that keeps leases enforced while the window is closed (§9.7).
  3. Whether "Detect my IP" may call a public IP echo service at all (§6.3).
  4. The default container lease (4 h, delete).
  5. A required daily budget before the first container or GPU sandbox (§9.3), and its suggested default (none is
     pre-filled today).
  6. Agent sandboxes start with **deny-all egress** (§7.1): the user adds npm/PyPI per thread. The alternative is to
     pre-allow the install registries (never GitHub or upload hosts).
  7. Whether the org-wide billing banner may name colleagues' resources (it shows counts and $/h only by default).

---

## 23. Review log (2026-11-02)

Two adversarial reviews: **SC** = security-cost lens (32 findings), **RL** = reliability-loop lens (34 findings),
numbered in the order they were reported. The findings on this document are below; harness.md §26 logs the rest (all
of them also accepted). Each was checked against the research documents and the code. **No finding was rejected.**
SC-13 was accepted with one change, stated below.

| Id | Finding | Verdict | Where |
|---|---|---|---|
| SC-10 | Firewall CIDRs can be widened (any prefix, `allowCidrs` without `allOpen`, `updateFirewallCidr`) without a native dialog; the dialog omits ports and CIDRs | Accepted | §6.2 dialog text, §6.3, §13.1, T14 |
| SC-13 | Budgets barely constrain compute: `DEFAULT_BUDGET` has no daily or monthly limit, projections ignore running resources, containers default to `notify` | Accepted; **verified** (`contracts/usage.ts`). Changed: setting the first daily budget needs no native dialog, because adding a limit tightens (D8); main refuses the create until one exists | §9.3, §6.2, §13.1 `dailyBudgetSet`, T2 |
| SC-14 | The idle guard counts terminal output and preview traffic, so auto-extend runs a forgotten sandbox to 480 min | Accepted (merged with RL-16) | §9.5, §7.3, §8.4, §9.8 |
| SC-15 | Journal pruning, reinstalls and late creates leave unmanaged `gmid-` containers billing with no alarm | Accepted (merged with RL-30) | §6.1 names, §6.2, §7.5, §13.1, T4 |
| SC-17 | Agent egress allowlist (npm, PyPI, GitHub) does not limit exfiltration | Accepted | §7.1; harness.md §10.4 |
| SC-18 | Tightening a lease can trigger a delete without a native dialog | Accepted | §9.3, §13.1 |
| SC-19 | The trace sanitiser misses sandbox tokens, `connect_url`, env values and data-plane bodies | Accepted; the logger's key-name pattern already matches `token` (`core/logger.ts`, verified) | §17, §13.2, T19 |
| SC-22 | Create outcome mapping misses 429, HTML pages and odd 200 bodies; "Try again" can double-create | Accepted | §6.2, §11 |
| SC-25 | The preview URL is built from a renderer `path` that can change the host; `loadURL` skips `will-navigate` | Accepted | §8.4, §13.1, T5 |
| SC-26 | `ws` defaults allow 100 MiB frames and deflate bombs from a hostile sandbox | Accepted | §8.2, T20 |
| SC-30 | The secret check only rejects env values equal to a secret | Accepted (also applied to the H4 broker) | §6.1, T15; harness.md §10.4 |
| SC-31 | With `basic_text`, the compute key is stored under a weak built-in key | Accepted; the backend detection exists (`src/main/index.ts`, verified) | §4.1, T21 |
| SC-32 | `releaseEip` could release a colleague's EIP | Accepted | §7.5, §13.1, T12 |
| RL-5 | The ledger's kinds and totals, and their ownership by a compute slice | Accepted; **verified** in `services/usage/ledger.ts`; F0 now owns the change | §13.2, §21.0; harness.md §4.3 |
| RL-13 | Ack backpressure stalls remote programs when no view is visible; replay can garble the screen; input invokes can reorder | Accepted | §8.2, §11, §13.1 |
| RL-14 | The two plans share files with no order between them | Accepted: shared F0, per-feature registration files, serialised integrators | §21, §21.0; harness.md §24 |
| RL-16 | App-originated execs and preview traffic keep sandboxes alive | Accepted (merged with SC-14) | §9.5, §8.4 |
| RL-17 | Exec slots are released when the HTTP call returns; abandoned executions keep running; restarts lose track | Accepted | §8.1, §14, §21 C2-A; harness.md §10.4 |
| RL-30 | The journal is not fsynced; `failed_unknown` is pruned; no install tag in names | Accepted; **verified** (`atomicWriteFile` in `core/store.ts` renames without fsync) | §6.2, §13.2, §7.5 |
| RL-31 | Lease and budget actions fire once; a wrong local clock can delete containers at startup | Accepted | §9.4, §9.7, §10, §11 |
| RL-32 | Without Range, every 10 s log poll downloads the whole log | Accepted | §6.4, §20 U14, T20 |
| RL-33 | Sandbox startup reconcile by re-POST fails after 24 h; deleted sandboxes are hidden from the default list | Accepted | §7.1, §20 U21 |
