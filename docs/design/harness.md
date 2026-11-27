# GMI gateway, agent harness and the Code tab (design, 2026-11-02)

**Status:** design, ready to implement as phases **H1** (gateway + chat migration), **H2** (harness core), **H3**
(Code tab) and **H4** (sandbox MCP + agent-driven computer). Nothing in it has been built.

**Revision (2026-11-02, after review).** Two adversarial reviews (lenses security-cost and reliability-loop) of this
document and compute.md produced 66 findings. Each was checked against the research, the code and, for the sandbox and
git claims, against this machine (bwrap 0.11.0, git 2.43, rg 14.1.0). All are folded into the sections below; the
shared implementation foundation **F0** now lives in compute.md §21.0. §26 is the review log (verdict and location of
every finding).

**Inputs:** [research/harness.md](../research/harness.md) (RH),
[research/agentbox.md](../research/agentbox.md), [RESEARCH.md](../RESEARCH.md), DECISIONS D1–D18, and the companion
[compute.md](compute.md). This document reuses compute.md's foundation changes (§13.2 there), including the shared
error codes and `SpendKind` additions.

**User request (2026-11-02):** "we should have some opencode or droid like harness to efficiently use gmi model. Just
sending raw tokens with no compactions mechanism and so on will end up burning the tokens unnecessarily. We should have
a proper production grade architecture for all of this… used at scale… audit for security, proper loop engineering,
mcp integrations." Earlier: "T3code style parallel repo… We don't want to burn tokens."

**Markers:** `[V]` verified (the source is cited in the research), `[I]` inferred, `[U]` unverified (each one is
listed in §23 with a probe).

---

## 0. Summary

1. **GMI gateway in main.** All model traffic goes through it: chat, agents, subagents, compaction, titles. The
   inference key and the OAuth token never leave main. The gateway handles:
   - request normalisation per model family: Chat Completions or Responses, `max_tokens` vs `max_completion_tokens`,
     `reasoning_content` replay, always `context_length_exceeded_behavior: "error"`;
   - exact metering: cached tokens at the read price, cache writes, long-context price tiers, the org discount. A
     prompt is charged as soon as GMI answers 2xx, and attempts that GMI may have billed are charged as estimates;
   - **worst-case budget reservations computed by main** from the body it is about to send (never from numbers the
     host supplies), taken at admission and released at settle, so parallel threads cannot jointly overshoot.
     Per-thread spend and caps are **persisted in main**;
   - **one TPM-aware scheduler for the whole org** (TPM-only limits, Tier 1 = 1M TPM `[V]`) with head-of-line
     fairness. A 429 never stops a thread: the request is requeued;
   - retries only where GMI cannot have billed, watchdogs, per-model circuit breakers and a global offline gate.
   The existing chat slice is migrated onto it first (H1).
2. **Our own harness (RH option C), not OpenCode or Pi.** It runs in an **Electron `utilityProcess`** with a scrubbed
   environment and no secrets. It contains the agent loop, tools, permissions, compaction, MCP clients, git and a
   `node:sqlite` event log; heavy synchronous work runs in a worker thread. It talks to main over a validated
   MessagePort protocol. A crash never touches the UI (main aborts the host's upstream requests), and runs are replayed
   from the log.
3. **Loop engineering.**
   - Step, active-time, cost and budget caps.
   - Doom-loop detection on step signatures, failing steps, no progress and edit oscillation.
   - Every stored tool call is paired with exactly one result, synthetic on cancel, cut, cap or crash. Tool calls get
     internal ids, so provider ids that repeat cannot collide.
   - Mixed tool batches keep model order: runs of reads go in parallel, every mutation is a barrier.
   - Subagents have their own context in storage; one mutation lock per worktree.
   - Steering and cancellation through an AbortController tree; durable events with a contiguous per-thread seq,
     ephemeral deltas.
4. **Token efficiency.**
   - **A 160k-token working window by default**, not the model's 1M. Compaction then runs at about 120k tokens, where a
     fully cached GLM-5.3 step costs about $0.03 (at the old 1M ceiling it was about $0.19, or $1.04 on a cache miss).
     Raising the window is an explicit per-thread choice that shows the cost per step.
   - A byte-stable prompt prefix, so GMI's cache reads cost 1–20 % of fresh input `[V]`.
   - Truncation at insertion with spill files; read dedupe by line range.
   - Precomputed background summaries on a cheap model; triggers on tokens, message count and projected step cost.
   - Shrink-and-retry on overflow; "economy" mode that stays under price tiers, and switches itself off where a tier is
     too small for agent work.
   - Subagents and side tasks on Flash models or GMI Router.
5. **Safety.**
   - Permissions are allow/ask/deny rules per tool and path/command/host, kept in SQLite. The default mode is
     **auto-accept edits inside the worktree, ask for shell**, except read-only commands, which run in a read-only
     sandbox profile.
   - Shell runs in **bubblewrap** (0.11.0 here; the production argv and the self-test come from the same builder) on an
     **allowlisted root**: no `/run`, `/var`, `/home`, `/srv` or `/opt`, so no host Unix socket (Docker, D-Bus) is
     reachable. Network goes only through the app's **CONNECT proxy**, which applies web_fetch's IP rules (no loopback,
     LAN or metadata IPs). Git metadata is read-only except this thread's own refs, worktree dir and object store.
     `.env*` is masked, and `$HOME` is fresh for every command.
   - **Every host git call** goes through one `git-safe` exec. The git dir, common dir and work tree come from SQLite
     (never discovered), the `.git` pointer files are verified first, and filters, textconv, external diff, pagers,
     hooks, fsmonitor and signing are off.
   - Path policy: realpath, `O_NOFOLLOW`, hard-link checks, `.git` writes denied. Execution-sensitive and instruction
     files are read-only in the sandbox and hashed around every run.
   - Loosening any policy needs a native dialog from main, decided by one `isLoosening()` check. Paid tools need a
     one-shot approval token minted by main.
6. **MCP client:** stdio (in the same sandbox profile), streamable HTTP, OAuth through main. Servers need trust and are
   pinned by config hash, tool-description hash and package version. The GMI MCP is built in. A built-in **sandbox
   MCP** (H4) lets an agent drive the compute.md "computer" through scoped grants.
7. **Code tab (T3-style).**
   - Projects (git repos) with parallel threads, each in its own locked **git worktree** on a `gmi/<id6>/<slug>` branch
     (one ref directory per thread).
   - A thread list with live status, the timeline, approval cards, a diff/review/commit/merge flow, per-turn
     checkpoints for undo (kept in a separate snapshot repo outside the sandbox), and a per-thread model, budget and
     token/context meter.
8. **Runtime adapter (T3 `ProviderAdapter` shape).** OpenCode or others can be added later behind a hardened loopback
   gateway, which is designed here but not built in H1–H4.
9. **No new runtime dependencies.** `node:sqlite` (Electron 45 ships Node 24.22 `[V]`), `@modelcontextprotocol/sdk`
   1.32.2 and `zod` are already present. `git` is required; `rg` and `bwrap` are used when present.

---

## 1. Goals and non-goals

**Goals**
- **G1:** spend fewer tokens than a naive client by design, and prove it with metrics (cache-hit %, $/task in evals).
- **G2:** credentials never leave main. Model-run code never sees a GMI credential.
- **G3:** money is enforced in main: budgets, reservations, per-thread and per-turn caps, and a shared TPM scheduler.
  The loop cannot overspend even if it has a bug.
- **G4:** a production loop: bounded, cancellable, resumable after a crash, deterministic history (every call has a
  result), observable.
- **G5:** safe defaults on a real developer machine: sandboxed shell, confined paths, explicit approvals, prompt
  injection treated as expected input.
- **G6:** parallelism: 10+ threads across repos queue fairly instead of failing.
- **G7:** extensible: MCP servers, a sandbox MCP for remote computers, and a runtime adapter.

**Non-goals for H1–H4**
- Bundling OpenCode, Pi or Droid binaries. The adapter is designed (§11); a later phase decides.
- Running the agent loop inside an Agentbox sandbox with `generated_api_key`, for long unattended jobs. That is
  later, with its own spend cap (RH §7.8).
- LSP integration, a full code editor, inline completion.
- Browser automation tools; image or vision input for coding (later, per model capability).
- Team or cloud sync of threads.
- Content inspection of shell network traffic. The shell's network goes through the app's proxy, which blocks private
  networks and applies the project's host list (§8.3); it does not inspect what is sent.
- Windows sandbox parity. Windows gets ask-mode shell only (§8.3).

---

## 2. Architecture

```
┌──────────────────────── Renderer (sandboxed; no network, no secrets) ─────────────────────────┐
│ pages/code  ThreadList · Timeline · Composer(model, mode, meter) · Review(diff) · Approvals    │
│ pages/chat  (unchanged UI; now served through the gateway)     components/computer (H4 lane)  │
│        │ gmi.code.* gmi.chat.*  (invoke)                ▲ code:event code:threads code:approval│
└────────┼────────────────────────────────────────────────┼──────────────────────────────────────┘
         ▼ IPC (app origin only)                          │
┌──────────────────────────────── Main process (trusted) ─────────────────────────────────────────┐
│ GMI Gateway (services/gateway)                                                                  │
│   KeyProvider(inference key | OAuth token, D14) ─► Normaliser(capabilities) ─► Scheduler(TPM,  │
│   priorities, fairness) ─► Retry/Breaker/Watchdogs ─► ctx.http ─► api.gmi-serving.com/v1       │
│   Meter(cached, tiers, discount) ─► BudgetGuard + Reservations ─► spend ledger (kind chat|agent)│
│ chat slice ─────────────► gateway.stream(purpose:'chat', priority:'interactive')                │
│ code slice (services/code): projects, trust, thread caps, approval broker (native dialogs),     │
│   forwards CodeApi ⇄ host                                                                       │
│ HarnessSupervisor (services/harness): spawn utilityProcess(env scrubbed) · MessagePort ·        │
│   zod-validated protocol · heartbeat · restart/backoff · rpc: gw.request, mcp.gmi, compute.*    │
│ McpGateway (GMI MCP, OAuth in main) · ComputeBroker (compute.md, H4) · McpOAuth (3rd-party)     │
└───────────────────────────────▲─────────────────────────────────────────────────────────────────┘
                                │ MessagePort (structured clone; ≤ 4 MiB/message)
┌───────────────────────────────┴──── Harness host (Electron utilityProcess; no secrets) ────────┐
│ ThreadRuntime × N ─ Loop(runner, caps, doom) ─ Context(prefix, tokens) ─ Compactor(precompute) │
│ ToolRegistry: read list glob grep edit write apply_patch bash todo question task web_fetch     │
│   + mcp__* (MCP manager: stdio in bwrap / http) + sandbox_* (H4, rpc → main ComputeBroker)     │
│ PermissionEngine (rules, presets) · PathPolicy · SandboxRunner (bwrap | seatbelt | none)       │
│ Git (git-safe): worktrees · checkpoints (snapshot repo) · object import · diff · ref guard     │
│ Store: node:sqlite <userData>/data/harness/harness.sqlite (WAL; single writer = host)          │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ spawn (process group)                     │ stdio / https
        ▼                                           ▼
   bwrap ── bash/git/npm/pytest (allowlisted root,  MCP servers (stdio in bwrap; http)
            worktree rw, git ro except own refs/objects,
            net only via the app proxy, fresh $HOME, env allowlist)
```

**One turn, end to end**
1. The renderer calls `code.send(threadId, text)`.
2. Main's code slice checks the budget for the thread and forwards to the host as a command (`cmd`) with a
   `commandId`, so the operation is idempotent.
3. The host appends `turn.started` and the user message to the log, then builds the context (§7).
4. The host sends `gw.request` to main.
5. The gateway checks that the request belongs to a run main knows is running, estimates it itself, queues it in the
   scheduler, reserves the worst-case cost at admission, normalises the body and streams. Events go back to the host
   as batched `gw.events`.
6. The host appends `assistant.*` events, which are forwarded to the renderer as `code:event`.
7. For tool calls: the permission engine either allows, or asks (`approval.request` → main → renderer card or native
   dialog → `approval.decision`). Then the tool runs (bwrap for shell) and `tool.finished` is appended.
8. The loop continues until a final answer, a cap or a cancel.
9. Main settles usage into its persisted thread ledger (one spend-ledger row per turn, kind `agent`). Usage goes to the
   host and on to the renderer as a meter event.

---

## 3. Decisions (to record as D22–D25, see §25)

| # | Decision | Why | Rejected |
|---|---|---|---|
| DH1 | Build our own harness (RH option C, score 81/95) with OpenCode's and Pi's *algorithms* and numbers, behind a runtime adapter. | Full control of prompt bytes (caching), key isolation, permissions and sandbox, metering, and T3-style events; no binary of about 253 MB; no daily upstream churn. | OpenCode sidecar (59): its shell inherits the env, it is a large binary, the API churns. Pi in-process (69): no approvals, telemetry on and paid cache warming by default. |
| DH2 | The gateway lives in **main**; the loop lives in a **utilityProcess**. | Keys and budgets stay in the trusted process; a loop crash or hang cannot freeze the UI or reach secrets. | Loop in main (blast radius); a gateway in the host (the key would leave main). |
| DH3 | **One host process** by default. The protocol carries `hostId`, so a pool can shard threads by project later. | Simplest correct thing; restart replays from SQLite; about 40 MB per host. | One process per thread (memory) or per project (premature). |
| DH4 | **Main is authoritative for money.** Main computes every estimate and reservation from the request body it receives, validates purpose, priority and scope against the runs it tracks, and holds thread and turn spend and caps **persisted** in `data/gateway-threads.json`. The host may only tighten caps; its own caps are a courtesy. | The host runs code paths shaped by the model and parses untrusted data; spending must not depend on it, and caps must survive a restart. | Caps only in the host; caps only in main's memory (reset at every launch); host-supplied token estimates. |
| DH5 | **Chat Completions by default; Responses only where a model requires it**, with `store: false` and no `previous_response_id`. | GMI documents Chat Completions for most models; whether GMI keeps Responses server state is `[U]` (privacy); stateless full replay still gets prefix caching. | Responses everywhere. |
| DH6 | Always send **`context_length_exceeded_behavior: "error"`** (where the family accepts it). | GMI truncates silently by default `[V]`, which would defeat compaction without any signal. | Default truncation. |
| DH7 | **Event-sourced `node:sqlite`** in the host (append-only events + projections + command receipts), T3-style. | Crash-safe resume, auditable history, timeline paging; no native module to rebuild for Electron. | JSON files per thread (the chat slice's model) do not scale to tool-heavy runs. |
| DH8 | **Linux shell sandbox = bubblewrap** on an allowlisted root, network only through the app's CONNECT proxy, git metadata read-only except per-thread dirs. It is required for auto modes; without it every command asks. | OS-level confinement independent of command parsing. With `--ro-bind / /`, host Unix sockets (Docker, system D-Bus) stayed connectable, and a shared netns reaches localhost and the LAN (both verified here). | Command allowlists alone (not a security boundary); containers (heavy, Docker not guaranteed); `--share-net`. |
| DH9 | **Defaults:** main model chosen by the paid eval (provisional GLM-5.3); subagents and summaries on DeepSeek-V4-Flash; titles and commit messages on GLM-5.3-Flash, with GMI Router optional. | RH §1.3 prices; tool quality is untested `[U]` → eval. | Router for the main loop (it ignores tools `[V]`). |
| DH10 | **Default working window 160k tokens** (`CODE_DEFAULTS.maxContextTokens`), not the model's maximum. | Cost per step grows with context. At a 1M window compaction began near 743k tokens: $0.19 per cached GLM-5.3 step, $1.04 cold (above the $1 turn cap), and one request took 76 % of T1's TPM. OpenCode's 15 %/16k reserve assumes ~200k windows. | The model's full window by default. |
| DH11 | **Checkpoints in a separate snapshot repo** (`<userData>/data/harness/snapshots/<project>.git`) with a persistent per-thread index, outside the sandbox (the OpenCode pattern). | The sandbox cannot touch or prune them; the persistent index makes an unchanged checkpoint a stat pass instead of a full re-hash. | Hidden refs in the user's repo (the object store the agent could write); a temp index seeded from the agent-writable worktree index (it could lie about content). |

---

## 4. The GMI gateway (`src/main/services/gateway/`)

### 4.1 Interface and request lifecycle

The interface is `GmiGateway.stream(req, signal, owner)` (§13.2). It returns an async iterable of `GatewayEvent`.
**Upstream failures never throw.** A successful stream ends with `usage` (measured, or estimated when GMI sent none)
followed by `finish`. A failed stream ends with `error` `{afterOutput}`, preceded by an estimated `usage` whenever GMI
answered 2xx (the prompt at least, whatever the output). The iterable throws only for invalid requests
(`invalid_input`).

```
received ─validate (run tracked and running, purpose/priority allowed, model, sizes)─► estimate (main's own P, §4.4)
   ─► budget pre-check on actual spend only ── a limit already reached → error budget_exceeded / limit_reached
   ─► queued (scheduler: TPM, concurrency, breaker, offline gate, budget headroom)
         │ admit = reserve the worst case, synchronously (§4.4)
         │   short only because of others' reservations → stays queued(budget)
         ▼
      sending ─2xx headers─► streaming ─[DONE]/finish─► settling (finally: release, charge actual) ─► done
         │ connect/DNS failure before the body was sent, 429, 503 + Retry-After ─► requeue (keeps its place; AIMD on 429)
         │ 500/502/504/524, first-byte timeout, reset after the body was sent ─► maybeBilled: estimated prompt charge,
         │                                                                      ≤ 1 retry (none if P > 32k), then error
         │ cut / idle / total watchdog after the first byte ─► usage (estimated) + error {afterOutput: true}
         └ cancel, interrupt, owner host gone ─► abort ─► settling (prompt charged if a 2xx arrived)
```

- Every request carries the `ownerHostId` that the supervisor assigns (not a field the host sends). When the host
  exits or is killed, `gateway.abortOwner(hostId)` aborts its requests (§5.1).
- Main batches stream chunks per request every 16–40 ms before posting them to the host (`gw.events`).

### 4.2 Normalisation and capabilities (`capabilities.ts`, `body-*.ts`)

**Capabilities.** A local table, keyed by model-id pattern and overridable by probe results stored in
`data/gateway-capabilities.json`, plus catalog data (`api`, `contextLength`, pricing):

| Capability | Values | Default / examples |
|---|---|---|
| `api` | `chat` \| `responses` | catalog `api`; `*-codex`, `gpt-5.4-pro`, `bytedance/seed-2.0-mini` → responses `[V]` |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `openai/gpt-*` → `max_completion_tokens` `[V]` |
| `maxOutputTokens` | number | unknown → 32,768 cap, until probe H-P4 |
| `tools` / `parallelToolCalls` / `toolChoiceRequired` / `strictTools` | bool | true / `[U]` / `[U]` / false, until H-P5 |
| `reasoningReplay` | `tool_loop` \| `always` \| `never` \| `empty` | DeepSeek, Kimi, GLM → `tool_loop` `[V: RESEARCH]`; others → `never` |
| `ctxExceededParam` | bool | true, until H-P3 says a family rejects it |
| `includeUsage` | bool | true |
| `cacheKeyParam` | `prompt_cache_key` \| `user` \| null | null, until H-P2 |
| `developerRole` | bool | false (system role) |

**Request body (Chat Completions)**
- `model`, `messages`, `stream: true`, `stream_options: {include_usage: true}`.
- `<maxTokensField>: min(req.maxOutputTokens, cap.maxOutputTokens)`.
- `context_length_exceeded_behavior: "error"` when supported. If a family rejects it, the gateway strips it, marks
  `truncationRisk` and the harness compacts at 70 %.
- `tools` as given (the host already sorts them canonically), plus `tool_choice` and `parallel_tool_calls` when
  supported.
- `temperature` and `reasoning_effort` are passed only where the family supports them. Unknown parameters are never
  sent: the GMI wrapper answers 400 `unsupported_parameter` `[V]`.

**Messages**
- The canonical `GwMessage` maps 1:1 to Chat roles.
- Assistant `toolCalls` → `tool_calls[{id, type:"function", function:{name, arguments}}]`.
- Tool results → `{role:"tool", tool_call_id, content}`, plus `name` where a family needs it.
- `reasoning` → `reasoning_content` according to `reasoningReplay`:
  - `tool_loop`: include it on assistant messages of the **current** user turn only, matching chat templates that drop
    past-turn reasoning;
  - `empty`: send `""`;
  - `never`: omit it.
- Serialisation is **deterministic**: key order fixed by the builder, no `undefined`, no timestamps. A golden test
  keeps it that way.

**Responses** (`body-responses.ts`):
- `input` items, `store: false`, `max_output_tokens`, function tools.
- For OpenAI reasoning models, `include: ["reasoning.encrypted_content"]`, with the encrypted items replayed in later
  requests. Whether GMI passes them through is `[U]` (H-P7).

**Router** (`body-router.ts`): `{messages, mode, stream}` only. Requests with tools are rejected with `invalid_input`.

**Parsers.** These are the chat slice's existing parsers moved into the gateway (`parsers/{common,chat,responses,
router,think}.ts`), extended with:
- **tool-call deltas:** `delta.tool_calls[i]` accumulated by `index` and emitted as `tool_call` at finish; Responses
  `response.output_item.added` / `function_call_arguments.delta`;
- **cache-write usage**, where reported (`prompt_tokens_details.cache_creation_tokens` /
  `cache_creation_input_tokens` `[U]`).

### 4.3 Metering (`meter.ts`)

- **Price source:** catalog `LlmPricing` (list prices, `tiers`, cache read and **write**) and `discount`.
- **Tier selection:** by `promptTokens` **including cached tokens**, the existing `pricingForPrompt` rule.
- **Cost formula:**
  `cost = ((prompt − cached − cacheWrite) × in + cached × cacheRead + cacheWrite × cacheWriteRate + completion × out) / 1e6`,
  then × (1 − discount).
  - `estimateTokenCostUsd` in `shared/lib/money.ts` gains an optional `cacheWriteTokens` term (additive; F0).
- **No usage chunk** (stopped, cut, cancelled, or the router sent none): usage is estimated from the request body and
  the streamed text with main's calibrated estimator (§7.2) and gets `estimated: true`. **The prompt is charged
  whenever GMI answered 2xx (headers)**, even if no token arrived (for example a cancel during a long prefill). This is
  chat's existing `responded`-on-2xx rule (`services/chat/service.ts`).
- **Maybe-billed attempts** (500/502/504/524, a first-byte timeout, or a reset after the body was sent; §4.6): an
  estimated prompt charge is recorded for each such attempt before any retry (`estimated: true, maybeBilled: true`).
- **Record:**
  - Chat: one ledger row per reply (`kind: 'chat'`), as today.
  - Agent-side spend (purposes agent, subagent, compaction, title and commit_message, plus paid GMI MCP calls made by a
    thread) is accumulated per `(thread, turn, model)` in `gateway/threads.ts`. It is persisted in
    `data/gateway-threads.json` and registered as a `SpendSource`, so budgets see it at once. One ledger row
    (`kind: 'agent'`, ref `thr:<id>/turn:<n>`) is written when the turn settles, or every $0.10 / 60 s of unflushed
    spend, whichever comes first. The source reports only the unflushed remainder, so nothing is counted twice.
  - Why: at about 1k requests per active hour (T1, subagents, compaction, side tasks), per-request rows would reach the
    ledger's 20,000-entry cap (`LEDGER_MAX_ENTRIES`, `trimLedger`) after about 20 active hours. Current-month rows would
    then be evicted and the monthly limit would fail open. Every append also rewrites the whole JSON file on main's
    event loop.
  - The ledger's `KINDS` accept only `chat` and `media` today, and `totalsSince` counts every non-chat kind as media
    (`services/usage/ledger.ts`, verified). F0 (compute.md §21.0) adds `agent` and `compute` buckets that are not
    counted as media, with a test, before any slice records agent spend.
  - Main updates the persisted per-thread and per-turn spend at every settle.
- **Per-request trace record** (memory ring of 1,000, plus the debug log): ids, model, api, purpose, priority,
  `promptTokens`, `cachedTokens`, `cacheWrite`, completion, reasoning, `costUsd`, `estimated`, `maybeBilled`,
  `queueMs`, `ttfbMs`, `totalMs`, attempts, status. **Never** bodies or keys.

### 4.4 Budgets and reservations (`reservations.ts`)

**Estimate: always main's, never the host's.**
- `P` = main's estimate of the serialised body it is about to send: the calibrated estimator (§7.2) over `messages` and
  `tools`. Main keeps its own calibration factor per `(thread, model)`, learnt from measured usage. The protocol has no
  host-supplied token counts.
- `maxOut` = the body's output limit after the capability clamp. The tier is chosen by `P`.
- **Reservation = the worst case:** `reserveUsd = (P × in + maxOut × out) × (1 − discount)`, with cached tokens counted as
  **0**. Cache-read prices are applied only when settling measured usage. (Pricing the expected cached share at the
  read price under-reserved by 5–12× on a cache miss, e.g. DeepSeek-V4-Pro 0.145 vs 1.74 $/M, so parallel threads near
  a cap could overshoot together.)
- **Display estimate** (the meter, "this step ≈ $x", cache diagnostics): `C` = the estimated tokens of the byte-level
  longest common prefix between this request's serialised body and the previous request's body for the same
  `(threadId, model)`. Main keeps a per-message cumulative hash chain per thread to find it. `C = 0` when the previous
  request is older than the cache TTL (5 min until H-P2) or the model changed, and `0 ≤ C ≤ P` always. This handles the
  cases where `prefixHash` misled: after compaction (prefix unchanged, cached part shrinks), at a new user turn (the
  `tool_loop` replay rule drops earlier reasoning, §4.2) and after a long approval wait.

**When budget is checked and reserved.**
- **Before queueing:** only against **actual** spend (spent plus unflushed). Refused (`budget_exceeded` for the app
  budget, `limit_reached` for thread or turn caps) only when a limit is already reached. No network I/O.
- **At admission**, synchronously, with no `await` between summing and inserting. `BudgetGuard` gains a synchronous
  `statusSnapshot()` for this (F0); today `check()` is async (`usage/budget.ts`), which let two reservations read the
  same outstanding sum.
  - app budget: `spent + Σ outstanding + reserveUsd ≤ remaining`;
  - thread and turn caps: `threadSpend + outstanding(thread) + reserveUsd ≤ perThreadUsd`, and the same for the turn;
  - fits → insert the reservation and send;
  - would fit without the other requests' outstanding reservations → stays `queued(budget)` until they settle;
  - does not fit even with nothing outstanding → `error limit_reached` (thread or turn) or `budget_exceeded` (app).
- **Settle** in `finally`: release the reservation and charge actual (or estimated) usage. There is no time-based
  expiry: a reservation lives exactly as long as its request object, and main's memory dies with main. (A 15-minute
  expiry could fire on a request that had waited in the queue and was still streaming.)
- **Purpose `chat` keeps today's semantics** (D8 / ARCHITECTURE): `check(null, 'chat')`, blocked only when a limit is
  already reached, and `budgetWarning` when it is not enforced. Agents always use reservations.
- **Purpose `probe`** (Diagnostics only, §23): the probe chooses a self-terminating prompt, and its reservation is
  capped at $0.05; the native dialog states the worst case.

**Persisted thread ledger** (`gateway/threads.ts`, `data/gateway-threads.json`, written with `durableWriteFile` at every
settle and on quit):
`{threadId: {spentUsd, turns: {turnId: spentUsd}, caps: {perTurnUsd, perThreadUsd}, capsApprovedAt}}`.
- Loaded before the first agent request is admitted, so a thread's spend survives restarts.
- `createThread` writes `CODE_DEFAULTS` caps (main side).
- Caps sent by the host (`setThreadCaps`) are accepted only when they **tighten** the persisted values. Loosening goes
  only through CodeApi `updateThread` → `isLoosening` → main's native dialog (§9.4), which calls `approveThreadCaps`.

**Validation of host requests (the supervisor's port).**
- Purposes `agent | subagent | compaction | title | commit_message` only; `probe` and `eval` are reserved for main's
  own Diagnostics actions, `chat` for the chat slice.
- Priority at most `foreground`; never `interactive`.
- `scope.threadId`, `turnId` and `runId` must match a run that main tracks as running. Main opens a run when it
  forwards `run.send` or `run.resume` and gets the `cmd.result`; it closes it on `interrupt`, on the host's
  `run.ended`, and when the host exits. Requests for an interrupted or ended run are refused (`invalid_input`).

### 4.5 Scheduler (`scheduler.ts`): one TPM bucket for the org

- **Limit:**
  - `limitTpm` from Settings › Code › "GMI rate-limit tier" (T1–T5 presets `[V]`, or custom; default T1 = 1,000,000).
  - `effectiveTpm` adjusts by AIMD: on a 429 → `max(0.25·limit, 0.7·effective)`; after each 60 s without a 429 →
    `+5 %·limit`, up to the limit. The org's bucket is shared with every other client of the org (teammates, the
    user's own OpenCode, Codex or Droid on GMI), so local accounting cannot prevent 429s; it only makes them rare.
- **Accounting:**
  - A sliding 60 s window of `(t, tokens)`.
  - At admission, `P + maxOut` is debited (conservative: whether TPM counts `max_tokens` or cached tokens is `[U]`);
    at settle it is corrected to `prompt + completion`.
  - **Head-of-line per model:** when the oldest eligible request of the highest waiting class does not fit (TPM or
    concurrency), younger and lower-class requests for that model are not admitted until it fits. After 2 minutes it
    is admitted anyway, with a warning (this covers a single request larger than the effective limit). Aging and
    deficit round-robin still decide which request is at the head.
  - A request requeued after a 429 or a not-billed failure keeps its position.
- **Queues.** Priority classes `interactive` (chat) > `foreground` (the selected Code thread's main loop) >
  `background` (other threads, subagents) > `idle` (compaction precompute).
  - Inside a class: **deficit round-robin per thread**, so one thread cannot starve others.
  - **Aging:** +1 class per 30 s waited, up to `foreground`.
- **Budget headroom** is part of admission (§4.4). A request waiting only for other reservations to settle shows
  `queued(budget)`.
- **Offline gate** (§4.6): while it is closed nothing is admitted, and requests show `queued(offline)`.
- **Concurrency caps:**
  - 16 in flight globally, 6 per model (configurable);
  - per thread: 1 main-loop request per context, 2 subagents and 1 compaction;
  - a model whose circuit breaker is `open` is not admitted.
- **Feedback:** a `queued` event with position, ETA and reason (`tpm | concurrency | breaker | budget | offline`). The
  renderer shows "Waiting for rate limit · ~12 s" on the thread.

### 4.6 Retries, backoff, watchdogs, circuit breaker

| Situation | Policy |
|---|---|
| Connect or DNS failure, or a reset **before the body was fully sent** | Not billed. Goes to the connectivity gate when the network looks down; otherwise requeued with backoff (full jitter, base 1 s, ×2, cap 20 s). |
| **429** before the first byte | Not billed. **Never surfaced to the loop:** the gateway requeues it in the scheduler (AIMD shrink, honouring `Retry-After`, keeping its queue position), and the thread shows `queued(tpm)`. It ends with `rate_limited` only after **10 minutes** of continuous 429s for that request, or when the user interrupts. Chat (interactive) requeues for at most 60 s. |
| **503 with `Retry-After`** | Not billed: requeued as for 429. |
| 500 / 502 / 504 / 524, 503 without `Retry-After`, the first-byte timeout, a reset after the body was sent | **Maybe billed:** GMI may already have accepted and billed the prompt. An estimated prompt charge is recorded for the attempt (§4.3). At most **one** retry, and none when `P > 32k` tokens. Then `error` (`upstream`). Chat never retries these (today's `retries: 0`). |
| 400 / 401 / 402 / 403 / 404 / 422 | No retry. 401 or `credentialRefused` → `keys.reportInvalidKey` (D15 semantics). |
| Context overflow (400 + "context length"/"maximum context"/"too many tokens", or the probed code) | `error context_overflow` → the harness runs compaction layer 2 (§7.5). Main's own size refusals (more than 2,048 messages, a body over 4 MiB) are reported as `context_overflow` too, not `invalid_input`. |
| After the first byte (cut, idle, total) | **No transparent retry.** Estimated `usage`, then `error {afterOutput: true}` → the loop decides (§6.2). |
| Watchdogs | First byte **90 s + 1 s per 10k prompt tokens** (prefill of a large prompt is slow); idle 120 s (the current chat value); total 15 min per request. |
| Circuit breaker per model | Counts only **5xx responses and first-byte timeouts from a reachable server**: 5 within 60 s → `open` for 30 s → `half_open` (1 probe request) → `closed` or `open` (doubling up to 5 min). Network-level failures and 4xx never count. Agent requests wait in `queued(breaker)`. A chat request fails fast ("GMI is failing for this model right now") with **Try anyway**, which forces the half-open probe. Shown in `GatewayStatus`. |
| **Connectivity gate** (global) | A DNS failure, ECONNREFUSED or ECONNRESET before any response, or `net.isOnline()` false closes the gate: admission pauses for every model, the status shows "Offline", and nothing consumes retry budgets or opens breakers. It reopens on Electron's online signal or `powerMonitor` `resume`, after one free probe (`HEAD` of the API host). |

### 4.7 GMI Router and cheap sub-steps

- **Side tasks** (thread titles, commit messages, PR blurbs) use the thread's `sideTaskModel`: `GLM-5.3-Flash` by
  default, or `router` in `cost` mode when chosen.
  - The router ignores `max_tokens` `[V]`, so its output is bounded only by the prompt instruction. The meter records
    the actual cost.
  - It is never used for tool loops or compaction: the window and model are unknown `[V: D6]`.
- **Subagents** default to `DeepSeek-V4-Flash` ($0.14 / $0.028 / $0.28 per M `[V]`) with read-only tools (§8.6).

### 4.8 Migrating the chat slice (H1)

- `ChatDeps` becomes `{gateway, catalog, budget}`. Key handling and `credentialRefused` reporting move into the
  gateway.
- `service.ts` builds `GwMessage[]` from history and calls
  `gateway.stream({purpose:'chat', priority:'interactive', target: model|router, …})`. It maps `GatewayEvent` to the
  existing `ChatStreamEvent`s.
- **`ChatApi` and `ChatStreamEvent` are unchanged.**
- The stream parsers and the think splitter move to `gateway/parsers/`. Chat's mock stream moves to
  `gateway/mock.ts`, which still reads `fixtures/chat/replies.json`.
- **Behaviour changes**, both deliberate and tested:
  1. `context_length_exceeded_behavior: "error"` is now sent. An over-long chat shows `context_overflow` with "Start a
     new chat (the model's context is full)" instead of silently truncating.
  2. Chat now takes part in the scheduler and the breaker. Chat is the `interactive` class, so it jumps ahead of
     agents.
  3. Not-billed failures (connect before send, 429, 503 with `Retry-After`) are requeued for up to 60 s, then
     `rate_limited`. Maybe-billed failures are never retried for chat. While a model's breaker is open, chat fails
     fast with **Try anyway** (§4.6).
- **Parity tests:** golden request bodies for every route are byte-equal to today's, except the added parameter. All
  existing chat tests pass against a fake gateway.

### 4.9 Loopback front door for external runtimes (designed; built only with the OpenCode adapter)

An OpenAI-compatible server on `127.0.0.1:<random>`, limited to `/v1/chat/completions`, `/v1/responses` and
`/v1/models`. Hardening:
- a per-runtime 256-bit bearer, which is not the GMI key and is useless outside this app run;
- `Host` must equal `127.0.0.1:<port>`;
- any request with an `Origin` header is rejected (no browser or DNS-rebinding access);
- body ≤ 8 MiB;
- the model allowlist comes from the catalog;
- tokens are revoked when the runtime exits;
- every request goes through the same reservations, scheduler (`background`) and meter, with `purpose: 'agent'` and a
  scope that main opened for that runtime's run (§4.4).

---

## 5. Harness host (`src/harness/`)

### 5.1 Process, protocol and supervisor

**Spawn** (`services/harness/supervisor.ts`):
- `utilityProcess.fork(dist-electron/harness.cjs, [], {serviceName: 'GMI Desk Harness', stdio: 'pipe', env})`.
- `env` is an **allowlist**: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `USER`, `SHELL`, `XDG_*_HOME` and
  `GMI_DESK_LOG_LEVEL`. It never includes `GMI_API_KEY` or any `*_KEY` / `*_TOKEN` / `*SECRET*`.
- A `MessageChannelMain` port is passed with `{t:'port'}`.

**Protocol** (`src/harness/protocol.ts`, §13.3):
- Every message is validated with **zod** on both sides; max 4 MiB per message; unknown or invalid messages are
  dropped and logged.
- Commands carry `commandId`. The host stores `command_receipts`, so a replayed command after a restart is
  idempotent.

**Health:**
- The liveness watchdog is armed only after `ready`. Startup (migrations including the `.bak` copy, log replay,
  recovery) has its own 5-minute budget with progress heartbeats (`pong` carries a `phase`).
- After `ready`: `ping` every 5 s; no `pong` within 15 s → `kill()` and restart.
- **The host's event loop never blocks for long.** Migrations, `git diff` parsing, compaction transcript rendering, and
  serialising or hashing contexts above 1 MB run in a `worker_threads` worker (`src/harness/worker.ts`), or are chunked
  with `setImmediate`. Budget: no synchronous block over 1 s.
- The host's `stdout` and `stderr` are always drained into the log (rate-limited to 50 lines/s). A chatty dependency
  can never fill the pipe and block the host.
- Restart backoff 1, 2, 4, 8… up to 60 s. 5 crashes in 5 min → `crashed`, a banner, and "Restart runtime".
- **Quarantine:** if the host crashes twice while recovering the same thread, that thread is marked `failed`
  (`status_reason: recovery`) and skipped on the next start.
- **Upstream requests die with the host.** Every gateway request carries the `ownerHostId` that the supervisor
  assigned. On the utilityProcess `exit` event or a watchdog kill, main calls `gateway.abortOwner(hostId)`: the
  fetches are aborted, settled with estimated usage (the prompt is charged if a 2xx arrived) and their reservations
  released. The restarted host ignores `gw.events` for unknown `reqId`s.
- **View-only fallback:** while the host is `crashed`, main opens the database itself with `node:sqlite`
  `{readOnly: true}` and serves `listThreads`, `getThread` and `getTimeline` (no writes, no runs). The banner says so.
- `code:state.hostState` reports the state.

**After a restart**, the host replays the log:
- runs that were `running` become `interrupted`;
- unsettled tool calls get synthetic results ("Interrupted: the runtime restarted. State unknown; re-check before
  retrying.");
- threads in `creating` or `setting_up` are reconciled against `git worktree list --porcelain` (§12.2);
- stale git lock files of ours are removed (§12.2), and the persisted ref-guard snapshot of each interrupted run is
  checked (§8.2);
- **runs never resume automatically** (cost safety). The thread shows "Continue". Main cancels the remote executions
  of H4 grants whose run ended (§10.4).

**Shutdown:** `before-quit` sends `{t:'shutdown', graceMs: 2500}`. The host aborts runs (synthetic results), flushes
SQLite (WAL checkpoint) and exits. Main gives it at most 3 s (the existing quit guard).

### 5.2 Storage (`src/harness/store/`, `node:sqlite`)

- **File** `<userData>/data/harness/harness.sqlite` (mode 0600; directory 0700). Pragmas: `journal_mode=WAL`,
  `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. FULL makes a committed `tool.started` survive an OS crash
  or power loss, which invariant 2 relies on. The write rate is low because streaming deltas are not persisted.
- **The host is the only writer.** Main never writes the file. It opens it read-only only for the view-only fallback
  (§5.1).
- **Migrations** use `PRAGMA user_version` and run in the worker (§5.1). The file is copied to
  `harness.sqlite.bak-<v>` before each migration.
- `node:sqlite` is behind a small `Db` interface (prepare, run, all, transaction), so it could be swapped for another
  driver if the API changes. On Node 24 it prints an ExperimentalWarning, which the host filters.

```sql
CREATE TABLE events (                       -- append-only source of truth; durable events only (no deltas)
  seq INTEGER PRIMARY KEY AUTOINCREMENT,    -- global, internal only
  thread_id TEXT NOT NULL,
  thread_seq INTEGER NOT NULL,              -- contiguous per thread, assigned in the same transaction (§6.6)
  event_id TEXT NOT NULL UNIQUE,
  context_id TEXT NOT NULL,                 -- the thread's main context or a subagent's child run
  run_id TEXT, turn INTEGER, step INTEGER,
  type TEXT NOT NULL,                       -- turn.started, item.*, status, todo, diff, tool.started, tool.finished, …
  at TEXT NOT NULL,
  payload TEXT NOT NULL,                    -- JSON, already truncated/redacted (no secrets, outputs ≤ 64 KiB)
  UNIQUE(thread_id, thread_seq)
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY, thread_id TEXT, at TEXT NOT NULL, result TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, name TEXT, default_branch TEXT,
  worktree_dir TEXT NOT NULL, setup_command TEXT, trust_state TEXT NOT NULL, trust_hash TEXT, trusted_at TEXT,
  ref_format TEXT NOT NULL,                 -- 'files' | 'reftable' (§8.3)
  added_at TEXT NOT NULL);
CREATE TABLE trusted_files (project_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(project_id, path));           -- instruction / MCP / permission files as trusted (§7.1, §12.1)
CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT, strategy TEXT,
  branch TEXT, base_ref TEXT, base_sha TEXT, worktree_path TEXT,
  git_dir TEXT, common_dir TEXT, git_pointer TEXT, object_dir TEXT,   -- recorded at creation; git-safe uses only these
  setup_state TEXT,                         -- creating | setting_up | ready | failed
  settings TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT, cost_usd REAL NOT NULL DEFAULT 0,
  tokens TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, instructions_hash TEXT, env_block TEXT, created_at TEXT,
  updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, context_id TEXT NOT NULL, ord INTEGER NOT NULL,
  turn INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, reasoning TEXT,
  reasoning_family TEXT, model TEXT, in_context INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,        -- the current turn's request, re-inserted after a summary (§7.4)
  partial INTEGER NOT NULL DEFAULT 0,       -- streaming text checkpoint, replaced at step end
  est_tokens INTEGER, UNIQUE(context_id, ord));                                       -- what the model sees, per context
CREATE TABLE tool_calls (id TEXT PRIMARY KEY,            -- internal tc_<ulid>: spill files, approvals, idempotency keys
  wire_id TEXT NOT NULL,                    -- the id the model sees (§7.1)
  provider_call_id TEXT,                    -- as the provider emitted it; may repeat
  thread_id TEXT NOT NULL, context_id TEXT NOT NULL, run_id TEXT, turn INTEGER, step INTEGER, tool TEXT, args TEXT,
  status TEXT, result_message_id TEXT, spill_path TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT,
  UNIQUE(context_id, wire_id));
CREATE TABLE approvals (request_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, tool_call_id TEXT, kind TEXT,
  request TEXT NOT NULL, decision TEXT, decided_at TEXT);
CREATE TABLE permission_rules (id TEXT PRIMARY KEY, tool TEXT NOT NULL, pattern TEXT, effect TEXT NOT NULL,
  scope TEXT NOT NULL, project_id TEXT, thread_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE checkpoints (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL, files_changed INTEGER, created_at TEXT NOT NULL);     -- objects live in the snapshot repo
CREATE TABLE compactions (id TEXT PRIMARY KEY, thread_id TEXT, context_id TEXT, upto_ord INTEGER, summary TEXT,
  model TEXT, before_tokens INTEGER, after_tokens INTEGER, cost_usd REAL, created_at TEXT);
CREATE TABLE reads (context_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL,
  ranges TEXT NOT NULL,                     -- JSON [[start, end), …]: lines of this sha currently in context
  size INTEGER, mtime_ms INTEGER, ord INTEGER, PRIMARY KEY(context_id, path));     -- read dedupe ledger (§7.3)
CREATE TABLE usage_steps (thread_id TEXT, context_id TEXT, run_id TEXT, turn INTEGER, step INTEGER, model TEXT,
  prompt INTEGER, cached INTEGER, expected_cached INTEGER, completion INTEGER, reasoning INTEGER, cost_usd REAL,
  estimated INTEGER, prefix_hash TEXT, at TEXT);
CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, config TEXT NOT NULL, trust_hash TEXT,
  tool_hashes TEXT, resolved_version TEXT, enabled INTEGER NOT NULL);
CREATE TABLE todos (context_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, items TEXT NOT NULL, updated_at TEXT);
CREATE TABLE ref_snapshots (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, refs TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE sensitive_hashes (thread_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT, PRIMARY KEY(thread_id, path));
CREATE TABLE git_procs (pid INTEGER PRIMARY KEY, thread_id TEXT, started_at TEXT);   -- stale-lock detection (§12.2)
```

- **Contexts.** `context_id` is the thread's main context (`ctx_<threadId>`) or a subagent's child run id. Messages,
  reads, todos and usage are stored and built **per context**: a child's messages never enter the parent's context, and
  a child's reads never mark a file as seen for the parent.
- **Durable vs ephemeral.** `events` holds durable events only (items, status, todo, diff, tool lifecycle, compaction,
  checkpoint). Streaming text lives in memory. At most one `partial = 1` message row per streaming item is upserted
  every 1 s, so a crash shows what was seen, and the final message replaces it at step end.
- **Retention:** events and messages are kept while the thread exists. Archived threads keep their projections; the
  "Delete thread" action removes all rows, spill files, its snapshot refs and index.
- **Spill files:** `<userData>/data/harness/spill/<thread>/<tc_id>.txt` (the internal tool-call id), 0600, deleted
  after 7 days or with the thread.
- **Not encrypted at rest**, the same as chat JSON today. The directory permissions and the "transcripts can contain
  file contents" warning cover it. Encrypting with a key wrapped by `safeStorage` is a later option.

---

## 6. The agent loop (`src/harness/loop/`)

### 6.1 Run state machine (per thread; one active run)

```
idle ─send─► preparing ─(over ceiling)─► compacting ─┐
  ▲             │                                     │
  │             ▼                                     ▼
  │          requesting (gw queued/admitted) ─► streaming ─► dispatching tools ─► awaiting_approval ⇄ tools_running
  │             ▲                                  │                                   │
  │             └──────── next step ◄──────────────┴──── results appended ◄────────────┘
  │                                                │ no tool calls
  │                                                ▼
  └───────────── completed │ stopped(cap|doom|budget) │ failed(error) │ cancelled(user) │ interrupted(host restart)
                                awaiting_user (doom-loop question / question tool) ─answer─► preparing
```

**Invariants**
1. Every assistant tool call **stored in history** has exactly one tool result before the next request. Calls that do
   not run (deny, cancel, crash, invalid arguments, a step cap, a cut stream) get a synthetic result ("Not executed:
   <reason>"). Incomplete calls (partial deltas, arguments cut by `length`) are never stored.
2. Side effects (a mutating tool, shell, a sandbox write) run only after `tool.started` (with arguments) has been
   committed with `synchronous=FULL`.
3. History is append-only. Compaction marks messages `in_context=0` and inserts a summary message; it never edits
   message content.
4. One in-flight main-loop gateway request per context; at most one `general` subagent per thread; every mutation
   (edit, write, apply_patch, bash, sandbox writes) holds the thread's **worktree mutation lock**, shared by the parent
   and its subagents.
5. The wall-clock cap counts only active time: `awaiting_approval` and `awaiting_user` pause it.

### 6.2 Step algorithm

1. **Check caps** (§6.3): steps, active wall clock, turn and thread cost (main's persisted figures, which arrive with
   each `meter`), and the app budget.
2. **Build the context** (§7) for this context id. If a compaction trigger fires (tokens, message count or projected
   step cost, §7.4) → compact, or swap in the precomputed summary.
3. **Send** `gw.request` with the tools frozen for this turn, and stream:
   - text and reasoning deltas → ephemeral events, batched every 40 ms in the host only (§6.6);
   - tool calls are collected; their arguments are parsed **after** each call is complete.
4. **On `finish`:**
   - `length` with no tool calls → one continuation ("Your previous response was cut off by the output limit.
     Continue exactly where you stopped; do not repeat."); a second `length` → the notice `output_limit` and stop;
   - `length` **while a tool call's arguments were being written** → the incomplete call is dropped (complete calls
     before it run normally) and the next request carries the note "Output limit hit while writing <tool> arguments;
     split the change into smaller edits." This does not use the invalid-JSON budget. The second time in a turn →
     `stopped(output_limit)`.
5. **Invalid tool JSON or an unknown tool** → a tool result describing the error, with the schema and the parse error.
   At most 2 per step, then the run stops with `model_error`.
6. **Run tools in batches that keep model order:**
   - the calls are split into maximal contiguous runs. A run of read-only calls (read, list, glob, grep, web_fetch,
     todo_write, MCP tools marked read-only by the user's policy) executes **in parallel, up to 4**;
   - every other call (edit, write, apply_patch, bash, task, question, `sandbox_*`, other MCP tools) is a
     **barrier**: it runs alone, after everything before it and before everything after it;
   - results are appended in the original call order;
   - each call goes through the permission engine first (§9); mutating calls take the worktree mutation lock;
   - example: `[read X, edit X, read X]` returns the old content, applies the edit, then returns the new content.
7. **Append results, then the doom check** (§6.4). If there were tool calls → back to 1; otherwise `completed`.
8. **Gateway `error`:**
   - `context_overflow` (including main's size refusals) → layer 2 (§7.5);
   - `rate_limited` (only after 10 minutes of 429s, §4.6) and `upstream` after the maybe-billed retry → `stopped` with
     the reason and "Continue";
   - `budget_exceeded` / `limit_reached` → `stopped` with a cost notice; the user raises the cap, which is a loosening
     and so needs a native dialog;
   - `afterOutput`:
     - partial text and **no** incomplete tool-call deltas → one continuation request;
     - **incomplete tool-call deltas** → the partial assistant message is discarded (never stored) and the same step is
       re-issued once; its prefix is cached;
     - a second `afterOutput` in the same step → `stopped` with "Continue".

### 6.3 Caps (defaults; per thread in `ThreadBudget`; main enforces money)

| Cap | Default | At the cap |
|---|---|---|
| Steps per turn | 50 (range 1–500) | One final request with `tool_choice:"none"` (or with no tools, for families that H-P5 shows ignore `none`), `max_tokens` 1,500 and "Summarise what is done, what is left, and the next step" (OpenCode-style). Tool calls in that answer get synthetic "Not executed: step cap reached" results → `stopped(step_cap)` |
| Wall clock per turn | 30 min of **active** time (paused in `awaiting_approval` and `awaiting_user`, so the 24 h approval expiry can be reached) | Abort the in-flight work (synthetic results) → `stopped(time_cap)`; no summary request |
| Cost per turn | $1.00 | Enforced by the gateway reservation → `stopped(cost_cap)`; a summary built from the log (no model call) |
| Cost per thread | $5.00 | Same as per turn |
| Subagent | depth 1, 20 steps, $0.25 | The subagent returns a truncated report |
| Tool timeouts | bash 120 s default, 600 s max; MCP 60 s; web 20 s; git 60 s | Kill the process group (SIGTERM, SIGKILL after 5 s) → a `timeout` result |
| Tool output per result | 2,000 lines / 50 KiB (≈ 12.5k tokens) | Spill (§8.7) |
| Tool output per step (all results) | 40k tokens | Truncate the largest results first, with markers |

### 6.4 Doom-loop detection (`doom.ts`)

| Signal | Threshold | Action |
|---|---|---|
| Identical `(tool, canonical args)` | 3 times in a row | `awaiting_user`: "The agent repeated the same call 3 times. Continue / Stop / Give a hint." |
| Same error text (normalised: digits and paths stripped) | 3 times | 1st: inject a hint user message ("Same error 3×: reconsider the approach; read the error carefully"); 4th → `awaiting_user` |
| No progress: no new file change, no new path read, no new command | 8 steps | `awaiting_user` |
| Edit oscillation: a file's content hash returns to an earlier state | twice | `awaiting_user` |
| Identical **step signature**: non-empty assistant text (whitespace-normalised, case-folded) plus the sorted tool-call names and canonical args | 2 in a row | `awaiting_user`. Empty text never matches by itself: DeepSeek, GLM and Kimi tool loops send `content: ""` with every call, and a repeated preamble with different calls is normal. |
| Failing steps: every tool result of the step is an **execution error** (the tool could not run: invalid arguments, path denied, missing file, timeout) | 5 consecutive steps | `awaiting_user`. A command that ran and exited non-zero counts as **executed** (a failing test run is progress). |

In unattended modes (scheduled or eval) `awaiting_user` becomes `stopped(doom_loop)`. A golden test runs a 30-step
empty-content tool loop with varied calls and asserts that no signal fires.

### 6.5 Cancellation, steering, interruption

- **AbortController tree:** run → step → {gateway request, tools}.
  - `interrupt` aborts the run: `gw.cancel` → main aborts the fetch.
  - Tool process groups get SIGTERM, then SIGKILL after 5 s (processes are spawned `detached` and killed with
    `-pgid`; bwrap has `--die-with-parent`).
  - Pending approvals are withdrawn.
  - Every unsettled call gets a synthetic "Cancelled by the user" result. Checkpoints stay as they are.
  - H4: interrupting also cancels the run's remote executions (`POST /executions/{eid}/cancel`, §10.4).
- **Steering:**
  - A message sent while a run is active is queued.
  - It is appended as a user message (`steering: true`) **after** the current step's tool results, so the prefix is
    preserved; it is never inserted mid-step.
  - Several steering messages are joined.
- **Follow-up:** `send` while idle starts a new turn.

### 6.6 Streaming events (host → main → renderer)

- **Durable events** (`item`, `status`, `todo`, `diff`) carry `seq` = the thread's **contiguous** `thread_seq`,
  assigned in the same transaction that stores the event. The renderer applies them in order; a gap or a reconnect →
  `getTimeline(afterSeq)`. (The global `events.seq` is not contiguous per thread once two threads run.)
- **Ephemeral events** (`delta`, `meter`) carry no seq. A delta carries `{itemId, field, offset}`; the offset makes it
  exactly-once and order-independent (the same trick as chat's `contentOffset`). A delta for an unknown item or a stale
  offset is dropped, and the next durable `item` event carries the full text.
- **Batching happens once, in the host:** 40 ms per thread for deltas; meter events at most 4/s per thread. Main
  forwards `code:event` without merging, after zod validation only.
- **`gw.events` from main to the host** are batched per request every 16–40 ms (text concatenated, tool-call deltas per
  index), never one message per SSE chunk.
- **Tool output to the UI:** the first 32 KiB of a tool's output streams live, then a 1 Hz tail window (the last
  4 KiB). Everything goes to the spill file. A `cat` of a 100 MB log never floods host → main → renderer.
- Test: two interleaved streaming threads cause zero `getTimeline` calls.

---

## 7. Context and compaction (`loop/context.ts`, `loop/compaction.ts`)

### 7.1 Byte-stable prefix (the caching contract)

```
[system]  base prompt vN (versioned file, hashed)  + tool-use guidance  (NO mode, NO dates)
[tools]   built-ins sorted by name, canonical JSON (sorted keys)  + MCP tools sorted by server, name (frozen per turn)
[user#0]  <project-instructions> AGENTS.md | CLAUDE.md | .gmi-desk/instructions.md (≤ 32 KiB; from the trusted snapshot)
          <environment> OS, shell, repo name, worktree path, base branch, tools (rg, bwrap), sandbox mode
                        (computed once per thread; frozen; fixed values in eval mode, §16)
[summary] (after compaction) "Summary of earlier work in this thread: …"
[history] append-only user / assistant(+tool_calls, +reasoning per replay rule) / tool messages
[user#N]  the new message + <context> date, mode rules ("Current mode: auto-accept-edits…"), git status --short (≤ 2 KiB),
          open todo list, budget left — VOLATILE DATA LIVES ONLY HERE
```

**Rules**
- Earlier messages are never edited.
- **Tool-call ids.** Every call gets an internal id `tc_<ulid>`, used for storage, spill files, approvals and
  idempotency keys. The id the model sees (`wire_id`) is the provider's own when present and not yet used in this
  context. A missing id becomes `call_<turn>_<step>_<i>`. A repeated provider id (many open models emit `call_0` every
  turn) is renamed `<id>_t<turn>s<step>` **when the message is first stored**, so the stored history is byte-stable
  from then on.
- No randomness or timestamps in the prefix.
- **Instructions come from the trusted snapshot.** `[user#0]` takes AGENTS.md / CLAUDE.md / `.gmi-desk/instructions.md`
  from `trusted_files` (stored at trust time, §12.1), never from the agent's worktree, where the agent can edit them.
  The MCP manager and the permission engine read their project files the same way, so one prompt injection cannot
  become persistent project instructions. A change in the project root makes the trust `changed`; after re-trust the
  new snapshot applies at the **next turn**, with a notice (`instructions_changed`), at the cost of one cache miss. A
  changed MCP tool list works the same way.
- `prefixHash` = sha256 of the serialised `[system]+[tools]+[user#0]`, sent with every request for diagnostics.
- **Diagnostics:**
  - `cached/prompt` per step and main's expected cached tokens (the byte-level common prefix, §4.4) are stored in
    `usage_steps`;
  - if measured cached tokens stay below 50 % of the expected value after step 3, the log gets `cache_miss_suspect`
    and the meter shows "low cache hit".

### 7.2 Token accounting

- **Estimator:** the existing `estimateTokens` (4 ASCII characters ≈ 1 token; other characters 1 each), cached per
  message.
- **Calibration:** a per-thread, per-model factor `k` (EMA, α 0.3) = `measured prompt_tokens / estimated`, clamped to
  0.5–2.5.
- **Size before a request:** `S = lastMeasuredPrompt + k·est(messages since then)`.
- **Main keeps its own copy** of the calibration per `(thread, model)`, learnt from measured usage, for reservations
  (§4.4). The host's copy only drives the compaction triggers.

### 7.3 Layer 0: at insertion (always on, cache-safe)

- **Truncation:** tool output ≤ 2,000 lines / 50 KiB / 2,000 characters per line (RH, the OpenCode numbers).
  - Shell output keeps **head 200 + tail 800 lines**: errors usually come last.
  - Markers: `[showing lines 1-200 and 1,201-2,000 of 9,120; full output: spill:<id> (use read on it)]`.
- **Read dedupe by line range.** `reads` stores, per `(context_id, path)`, the file's sha and the line ranges of that
  sha currently in context. `read(path, offset, limit)` returns "Unchanged since step N (lines a–b, sha …). The content
  is earlier in this conversation." only when the requested `[offset, offset + limit)` lies entirely inside an
  in-context range with the same sha. Paging through a long file therefore always shows new lines.
- **Own writes keep the row.** After a successful `edit`, `write` or `apply_patch` in this context, the row's sha is set
  to the post-write hash; the ranges stay as they were (unseen lines are not marked as seen). Chained edits therefore
  need no re-read. A change made by anything else (bash, a formatter, the user) changes the sha and invalidates the row.
- Compaction removes the ranges whose content left the context.
- **Binary or minified files:** NUL bytes, or an average line over 1,000 characters → a summary line (size, type)
  instead of the content.
- Images and PDFs are not read in v1.

### 7.4 Layer 1: threshold summary with background precompute

- **Window and ceiling.**
  - `W = min(catalog contextLength, thread maxContextTokens)`. `maxContextTokens` defaults to **160,000**
    (`CODE_DEFAULTS`, DH10); null means the model's full window. Raising it above the default is a loosening: the
    native dialog shows the cost of a cached and of an uncached step at the new ceiling. An unknown context is treated
    as 128k.
  - **Reserve** `R = max(0.15·W, 16,384) + maxOutputTokens`. **Ceiling** `C = W − R`. At the defaults:
    `C = 160,000 − (24,000 + 16,384) ≈ 119.6k`.
  - **Economy** (stay below the next price tier) limits only the prompt, because tiers are chosen by prompt tokens
    (§4.3): `C = min(W − R, floor(0.95 × tierBoundary))`. It is enabled for a model only when
    `C ≥ prefixTokens + keep + 8k`; otherwise it is switched off for that model with the notice `economy_disabled`
    ("this model's cheap tier is too small for agent work"). Example: Qwen3-Coder's 32k tier gives `C = 30,400`. (The
    earlier formula subtracted R from the tier boundary and produced `C = −385`.)
- **Keep** = `min(20k, 0.25·C)`.
- **Triggers** (any one, checked before each request; `S` = the size estimate, §7.2):
  - tokens: `S ≥ C`;
  - message count: more than 1,500 messages in context (main refuses 2,048, §13.3);
  - cost: the projected **cached** cost of the next step is above `perTurnUsd / 20` (default $0.05), so expensive
    models compact earlier.
- **Precompute** when `S ≥ 0.85·C` and `S ≥ 32k`, or the message or cost trigger is at 85 %. It starts a background
  summary at `idle` priority over the messages before an **anchor**: the last user/assistant boundary that leaves at
  least **keep** tokens after it. It never cuts between a tool call and its result.
- **Compact** when a trigger fires:
  - If a precomputed summary exists and the tail since its anchor is ≤ max(2·keep, 30k) and ≤ 25 % of C → swap it in.
  - Otherwise run the summary synchronously (`compacting` state; priority `foreground`).
  - **Target ≤ 0.5·C** afterwards (hysteresis, so the next compaction is far away).
- **The current turn's request stays verbatim.** After the summary, and outside the summarised region, the current
  turn's user message and its steering messages are re-inserted exactly as they were (`pinned = 1`), capped at 8k
  tokens with a pointer to the full text in the log if longer. Anchor selection counts this pinned block as part of
  the kept tail. (Pi keeps a separate turn-prefix summary for the same reason.)
- **Summariser:**
  - It runs on `compactionModel` (default DeepSeek-V4-Flash, 1M context).
  - If it is the same model as the thread, the summary request reuses the thread's exact prefix and appends the
    summary prompt as the last user message, which gets a cache hit.
  - Summary output is capped at 8k tokens by default (16k maximum).
  - The previous summary is passed in for incremental updates ("newer history takes precedence").
- **Template** (RH OpenCode headings):
  - Objective · Requirements · Decisions · Work state (Completed / Active / Blocked) · Next move · Relevant files
    (≤ 15) · Important context.
  - Rules: terse bullets; exact paths, symbols, commands, errors and URLs; carry only unanswered requests of earlier
    turns (the current one is pinned); include the VCS state; never mention compaction.
  - The **file ledger** (read and modified paths, from tool events, not from the model's memory) is appended by code,
    not by the model.
- **Failure:** 2 failed summaries → layer 2 directly. If that fails too → `stopped(overflow)`.
- **Cost**, using compaction model prices: about $0.03 per 200k-token summary on V4-Flash `[I]`; at the 160k default a
  summary covers about 100k tokens, about $0.016 (§19).

### 7.5 Layer 2: overflow from the provider

On `context_overflow`, shrink the target to 85 %, 70 %, 50 % and 35 % of the rejected size, one retry per level. Main's
own size refusals (more than 2,048 messages, a body over 4 MiB) arrive as `context_overflow` too and take this path.
The steps are:
1. A summary, if not already done.
2. Drop old tool outputs from the summarised region.
3. Keep fewer tail messages, never splitting a call from its result.

Then fail with `context_overflow`: "This task no longer fits the model's context. Start a new thread from this summary
(button)."

### 7.6 Reasoning retention

- Reasoning is stored per assistant message with the model family.
- It is replayed according to `reasoningReplay` (§4.2).
- **On a model switch inside a thread**, reasoning from the other family is never sent. The switch takes effect at the
  next turn, with a notice; the cache restarts.

### 7.7 Checkpoints and undo (`git/checkpoints.ts`)

- **Where:** a bare **snapshot repo** per project, `<userData>/data/harness/snapshots/<projectId>.git`, which no
  sandbox mounts (OpenCode's pattern, DH11). Its `objects/info/alternates` points at the project's common object store
  (read only), so committed blobs are not duplicated; new blobs are written into the snapshot repo. Each thread has a
  **persistent index** there (`index-<threadId>`), so a checkpoint re-hashes only files whose stat data changed.
- **When:** before the first call of a turn that can change files: a mutating fs tool, `apply_patch`, a `bash`
  command that is not on the read-only allowlist, or `sandbox_download`. Also once in the background (`idle`) right
  after a thread is created, so the first full hash of a large repo is not paid inside a turn.
  1. Through git-safe (§8.2) with `--git-dir=<snapshot repo> --work-tree=<worktree>` and
     `GIT_INDEX_FILE=<index-thread>`: `add -A`. It respects the worktree's `.gitignore` and includes untracked files;
     it is skipped with a warning if the untracked set is over 50 MB.
  2. If nothing changed since the previous checkpoint (`diff-index --quiet` against it), its tree is reused.
  3. `write-tree`, `commit-tree -m "gmi-desk checkpoint <thread>/<turn>"`, `update-ref
     refs/checkpoints/<thread>/<turn>`, all in the snapshot repo.
  The user's index, branches and object store are never touched, and nothing the agent can write is trusted: the
  worktree's own index is never used as a seed (it is agent-writable and could misstate file content).
- **Restore** (native confirmation if the worktree has changes made after the checkpoint by something other than the
  agent):
  1. Every object of the checkpoint tree must be readable (`cat-file -e`). If the user rewrote history and ran `gc` on
     the project, a blob reached only through the alternate may be gone: the restore is refused and names the paths.
  2. `restore --source=<ckpt> --worktree -- .` through git-safe against the snapshot repo.
  3. Delete the files that are tracked in the thread's snapshot index but absent from the checkpoint tree. Ignored files
     are never deleted.
  4. Append `checkpoint.restored`, and a user-visible message to the model: "Files were restored to the checkpoint
     before turn N; later changes were discarded."
- **Cleanup:** the thread's checkpoint refs and index are deleted with the thread, then `git gc --prune=now` runs on the
  snapshot repo (ours, never the user's).
- **Performance:** an unchanged 50k-file worktree checkpoints in under 2 s (test).
- **Non-git folders** are not supported in v1 ("Initialise git?" with a confirmation).

---

## 8. Tools (`src/harness/tools/`)

### 8.1 Built-in tool set

| Tool | Args (JSON schema, abridged) | Class | Notes |
|---|---|---|---|
| `read` | `path, offset?, limit?` | read | Line-numbered; caps §7.3; dedupe; spill files of this thread are readable |
| `list` | `path?, depth≤3` | read | Respects `.gitignore` (`rg --files` with the fixed argv of §8.2 / JS walker); ≤ 1,000 entries |
| `glob` | `pattern, path?` | read | `rg --files -g` with the fixed argv (§8.2); ≤ 1,000 |
| `grep` | `pattern, path?, glob?, ignore_case?, context≤5` | read | `rg --json` with the fixed argv (§8.2) (≤ 200 matches / 50 KiB); JS fallback when `rg` is missing |
| `edit` | `path, old_string, new_string, replace_all?` | mutate | Exact match. The file must be unchanged since this context last saw it: the `reads` sha, which this context's own successful writes update (§7.3); otherwise "re-read first". A miss returns the 3 closest line windows. |
| `write` | `path, content` | mutate | New file, or a full rewrite of a file read before; ≤ 1 MiB |
| `apply_patch` | `patch` | mutate | Accepts unified diff (`git apply --check` then `git apply` through git-safe, §8.2, in the worktree) **and** the Codex `*** Begin Patch` format (converted). Every target path goes through §8.2 first. |
| `bash` | `command, cwd?, timeout_ms?, description` | shell | §8.3; output streamed to the UI (first 32 KiB, then a 1 Hz tail); head+tail truncation |
| `todo_write` | `items[{id,text,status}]` | state | Stored per thread; shown in the UI; not in the prefix |
| `question` | `question, options?` | user | `awaiting_user`; the answer comes back as the tool result |
| `task` | `description, prompt, agent: explore\|general, model?` | subagent | §8.6 |
| `web_fetch` | `url, prompt?` | network | §8.5 |
| `mcp__<server>__<tool>` | per server | per policy | §10 |
| `sandbox_*` (H4) | §10.4 | remote | Through main's ComputeBroker |

Git is used through `bash` for the agent (read-only commands are allowlisted, §9). The **host's own** git calls are
listed in §8.2.

### 8.2 Path policy (`sandbox/paths.ts`): every file tool, and every apply_patch target

1. **Reject** NUL, `~`, and URLs.
2. **Resolve** relative to the worktree root, then `path.resolve`.
3. **realpath:** `fs.realpath` of the deepest existing ancestor + the remaining segments. It must be inside
   `realpath(worktree)` or an extra root (spill dir, read-only) — a prefix check with the separator; case-folded on
   darwin and win32.
4. **Writes:**
   - open the final component with `O_NOFOLLOW`;
   - write to `<dir>/.gmid-tmp-<rand>` and then `rename` (atomic, same directory);
   - a regular file with `nlink > 1` → ask (a hard link may point outside).
5. **Hard deny** (not overridable by any rule or mode):
   - **writes** to `.git/**` and to the worktree's `.git` file;
   - **reads and writes** of `**/.env`, `**/.env.*` (except `.env.example|.sample|.template`), `**/*.pem`, `**/*.key`,
     `**/id_rsa*`, `**/id_ed25519*`, `**/.npmrc`, `**/.netrc`, `**/.pypirc`, `**/.git-credentials`;
   - anything under the app's userData, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.factory`,
     `~/.claude.json` (ground rule 3).
6. **Execution-sensitive and instruction files:** `.husky/**`, `.git/hooks/**`, the in-repo `core.hooksPath` dir,
   `.github/workflows/**`, `.envrc`, `.vscode/{settings,tasks,launch}.json`, `package.json#scripts`, `Makefile`,
   `*.sh` at the repo root, and the instruction and config files `AGENTS.md`, `CLAUDE.md`, `.gmi-desk/**`, `.mcp.json`.
   - **fs tools:** edits always ask, even in `auto-accept-edits`, with the `execution_sensitive` risk flag.
   - **Sandbox:** those that exist are `--ro-bind`-mounted (except `package.json`, `Makefile` and `*.sh`, which builds
     legitimately rewrite), unless the user approved "allow writes to sensitive files" for that one command.
   - **Hashes around every sandboxed run:** the host hashes all of these paths, tracked and ignored (husky's `_/` is
     gitignored and would never show in the review diff), before and after each run. Any change raises an
     `execution_sensitive` notice and a review entry.
   - The native merge dialog lists execution-sensitive changes separately (§12.3).

**The host's own git calls: one `git-safe` exec** (`src/shared/lib/git-safe.ts`, used by the host and by main's
project checks; worktree, checkpoint, diff, apply, ref guard, commit, merge, object import):
- **Paths from the record, never discovered:** `--git-dir=<threads.git_dir>`, `GIT_COMMON_DIR=<threads.common_dir>`,
  `--work-tree=<threads.worktree_path>`. Before each call, the contents of `<worktree>/.git`, `<git_dir>/gitdir` and
  `<git_dir>/commondir` must equal the recorded values; otherwise the call is refused and the thread gets the notice
  `git_tampered` ("git metadata of this thread was changed outside GMI Desk").
- **Always:** `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`
  (`:(top)`, `:/` and `*` are plain names), `-c core.fsmonitor=false -c core.hooksPath=/dev/null
  -c core.attributesFile=/dev/null -c diff.external= -c core.pager=cat -c commit.gpgSign=false -c tag.gpgSign=false
  -c gpg.program=false -c credential.helper= -c protocol.file.allow=never -c core.sshCommand=false -c gc.auto=0`, and
  `--` before every path.
- **Checkpoint, diff, apply and ref-guard calls** also set `GIT_CONFIG_GLOBAL=/dev/null` (author name and email from
  env), and diffs add `--no-ext-diff --no-textconv`.
- **Commit and merge** (user actions in Review) keep the user's global config (LFS filters and signing are the user's
  own, outside every sandbox). Before them, main lists the repo-local keys that can run code (`filter.*`,
  `diff.*.textconv`, `diff.*.command`, `merge.*.driver`, `core.{pager,editor,sshCommand,fsmonitor,hooksPath,askPass}`,
  `gpg.*`, `credential.*`, `include*`); any that were not present at trust time → a native confirmation showing them.
- **No option injection:** values supplied by the agent or the renderer never become options. Positional values that
  start with `-` are rejected; `getFileDiff` and `discardFile` require `path` to be in the thread's current diff list.
- Why: in a scratch repo, a sandbox-writable `.git` file pointing at an attacker-made git dir with a `filter.x.clean`
  driver ran code during the host's `GIT_INDEX_FILE=… git -c core.fsmonitor=false -c core.hooksPath=/dev/null … add -A`
  (verified 2026-11-02); with the git dir passed explicitly from the record, it did not. The sandbox now also mounts
  these pointer files read-only (§8.3).

**Host-side ripgrep** (grep, glob, list) uses a fixed argv only:
`rg --no-config --json [-i] [-C <n>] [-g <glob>]… -e <pattern> -- <path>`, and for globs
`rg --no-config --files -g <glob> -- <path>`, with `RIPGREP_CONFIG_PATH` removed from the env. The pattern goes only
after `-e`, globs only after `-g`, paths only after `--`, so a pattern such as `--pre=sh` stays a pattern. When bwrap
works, rg also runs in the `readonly` sandbox profile (§8.3). Tests pass `--pre=sh` as the pattern, the glob and the
path.

**Ref guard** (defence in depth: common refs are read-only in the sandbox now, §8.3):
- Before each run, `git for-each-ref` is recorded in `ref_snapshots` (so a crash does not lose it). After the run, and
  at host start for interrupted runs, it is compared.
- Any change outside `refs/heads/gmi/<threadId6>/` → a `warning` notice with the old and new sha, and "Restore ref"
  (`update-ref <ref> <old>` through git-safe, under the per-repo mutex).

### 8.3 Shell sandbox (`sandbox/bwrap.ts`, `seatbelt.ts`, `runner.ts`)

**Linux (bubblewrap). The self-test is the production argv.** At host start, `bwrap.ts`'s own builder produces the exact
`exec` argv used for commands, with `true` as the command, and the self-test runs it with assertions: no host socket is
connectable, there is no network, `$HOME` is empty, and the git metadata is read-only. (The earlier argv used
`--disable-userns` without `--unshare-user`; on bwrap 0.11.0 that exits 1 with "--disable-userns requires
--unshare-user", while the earlier self-test `bwrap --ro-bind / / --unshare-all --die-with-parent true` passed. Verified
here.) If the self-test fails, for example because Ubuntu ≥ 24.04 AppArmor restricts unprivileged user namespaces, the
state is `sandbox: {kind:'none', ok:false, detail}`: every shell command asks, the UI explains how to enable bwrap, and
the auto modes are disabled.

**Profile `exec`** (bash, stdio MCP servers, the setup command):
```
bwrap --die-with-parent --new-session --unshare-all --unshare-user --disable-userns
      --ro-bind /usr /usr  (+ /bin /sbin /lib /lib64: --symlink on merged-/usr systems, else --ro-bind)
      --ro-bind /etc /etc  --tmpfs /etc/{docker,containerd,NetworkManager,wpa_supplicant,wireguard,openvpn,ppp} (those present)
      --ro-bind-try /sys/devices/system/cpu …  --ro-bind-try /sys/fs/cgroup …
      --dev /dev  --proc /proc  --tmpfs /tmp  --tmpfs /var/tmp  --tmpfs /run  --symlink ../run /var/run
      --tmpfs $HOME            (nothing else of /home, /media, /mnt, /opt, /srv, /var/lib or /data is mounted)
      --ro-bind <each PATH dir outside /usr and its realpath: ~/.nvm/versions/node/<v>, ~/.cargo/bin, ~/.local/bin,
                 ~/.bun, ~/.pyenv, /snap/bin …>
      --bind <worktree> <worktree>
      --ro-bind <worktree>/.git <worktree>/.git                                (the pointer file)
      --ro-bind <common> <common>              (config, hooks, HEAD, packed-refs, the user's index, objects, other threads)
      --bind <common>/worktrees/<name> <common>/worktrees/<name>               (this worktree's HEAD, index, logs)
      --ro-bind <common>/worktrees/<name>/{gitdir,commondir,config.worktree} … (config.worktree created empty first)
      --bind <common>/refs/heads/gmi/<id6> …  --bind <common>/logs/refs/heads/gmi/<id6> …     (this thread's refs only)
      --bind <thread object dir> <thread object dir>
      --ro-bind <each existing execution-sensitive or instruction path> …      (§8.2.6)
      [--ro-bind /dev/null <worktree>/<each masked secret file found: .env, .env.local, *.pem …>]
      --bind <thread cache>/{.cache,npm,pip} $HOME/{.cache,.npm,.cache/pip}     (only caches persist; no dotfiles)
      [--ro-bind <proxy socket dir> /run/gmid-proxy]                           (network approved)
      --chdir <cwd inside worktree>  --setenv … (allowlist only)  --  /bin/bash --noprofile --norc -c "$CMD"
```

- `cwd` must pass §8.2 (inside the worktree).
- The command runs with `bash --noprofile --norc -c` **inside** the sandbox. `$HOME` is a fresh tmpfs for every
  command and only cache directories persist per thread, so a planted `~/.bash_profile` cannot run next to an approved
  command whose approval showed only `$CMD`. Command parsing is used only for permission matching (§9.3), never as the
  security boundary.
- **No host Unix socket is reachable.** `/run`, `/var/run`, `/tmp` and `$HOME` are fresh tmpfs, and `/var/lib`,
  `/srv`, `/opt`, `/home` and `/data` are not mounted. With the earlier `--ro-bind / /`, a sandboxed command could
  connect to `/var/run/docker.sock` and `/run/dbus/system_bus_socket` (verified here; the user is in the `docker`
  group, so `docker run -v /:/host …` meant root on the host). A read-only mount does not stop `connect()`, and a
  network namespace does not cover path sockets. Abstract sockets are cut by the network namespace. A seccomp filter
  against `AF_UNIX` is not added: no host socket path is mounted any more, and local IPC inside the sandbox (test
  servers, worker pools) needs Unix sockets. The live tests try `connect()` on every socket path in the host's
  `/proc/net/unix` and require all to fail, and `docker version` must fail.
- **git inside the sandbox.** The agent can stage and commit on its own branch (`gmi/<id6>/…`) and nothing else: other
  threads' worktree metadata, the user's index, `HEAD`, `packed-refs`, config, hooks and the shared object store are
  read-only. New objects go to the thread's own object directory: `GIT_OBJECT_DIRECTORY=<data>/harness/objects/<thread>`
  with `GIT_ALTERNATE_OBJECT_DIRECTORIES=<common>/objects`. The host imports them into the common store, verified,
  after each run and before any commit, diff or merge that needs them:
  `git rev-list --objects <branch> --not <base> | git pack-objects --stdout | git unpack-objects` (git re-hashes every
  object on unpack), under the per-repo mutex. `rm -rf <common>/objects`, `reflog expire` with `gc --prune=now`, edits
  to `packed-refs` or to another thread's `worktrees/*/HEAD`, and `git worktree prune` now fail inside the sandbox.
  `git stash` is unavailable there (the stash is repo-wide) and `gc.auto=0` is set. Before each run the host creates
  `refs/heads/gmi/<id6>/` and `logs/refs/heads/gmi/<id6>/` if missing (a `git pack-refs` by the user removes empty
  ref directories), under the per-repo mutex.
- **Strategies without per-thread refs.** For `root` and `existing_worktree` threads, and in **reftable** repositories
  (`extensions.refStorage = reftable`: one shared ref store), the whole git metadata is read-only in the sandbox: the
  agent edits files and Review commits. The thread object dir is still mounted, so `git add` works where the index is
  this thread's own.
- **Network.** The sandbox never shares the host network namespace.
  - When a command's network is approved, the host starts (once per host) an HTTP/HTTPS **CONNECT proxy** on a Unix
    socket in a private directory, bind-mounted into the sandbox at `/run/gmid-proxy/`. A bundled 60-line forwarder,
    run with the Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`, read-only mount), listens on the sandbox's own
    `127.0.0.1:3128` and relays to it. The env gets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` set to
    `http://127.0.0.1:3128` (and lower-case forms), `NO_PROXY` empty.
  - The proxy resolves names itself and applies **the same `lookup` IP checks as web_fetch** (§8.5: no loopback, RFC
    1918, link-local including 169.254.169.254, CGNAT, multicast, IPv6 ULA or link-local), plus the project's host
    policy. Approved network therefore reaches the internet but not the Vite dev server, local databases, the Docker
    TCP API, Ollama, the app's OAuth or MCP loopback listeners, or the LAN.
  - Tools that ignore proxy variables get no network at all: the failure is closed, and the error says to use a
    proxy-aware tool.
  - If the proxy cannot start, network approval is **per command only**, with the `local_network` risk flag ("this
    command can reach your local network and this computer's services") and `--share-net`. The renderer card cannot
    grant it for the thread.
- **Profile `readonly`** (the allowlisted read-only commands of §9.2, and host-side rg): the same as `exec`, but the
  worktree, the common dir and the thread object dir are all `--ro-bind`, `$HOME` is an empty tmpfs, there is no
  proxy, and `/tmp` is private. Read-only is a property of the mounts, not of command parsing.
- **Package installs** need the network: "Allow network for this command" (default) or "for this thread" (only while
  the proxy runs; a thread grant is a loosening → native dialog). Caches are written to the thread's cache dirs, so
  they are not shared with the user's real caches.
- **macOS:** `sandbox-exec -p <profile>`: deny by default; allow process exec, fork and sysctl reads; reads of `/`
  except the denied secret paths and other users' homes; writes to the worktree, this thread's git paths (the same
  list as Linux), the thread caches and `/private/tmp`; network only to the proxy's socket (`remote unix-socket`), and
  no other Unix socket. It is the model Codex uses `[I]`. The same self-test and assertions.
- **Windows:** no OS sandbox. **Every** command asks (`unsandboxed` flag); the auto modes are unavailable; the env is
  scrubbed; a Job Object kills the process tree.

### 8.4 Environment scrubbing (`sandbox/env.ts`)

- **Child env = an allowlist only:**
  - `PATH` (with `.` and relative entries removed);
  - `HOME` = a fresh tmpfs per command (§8.3); `USER`; `LOGNAME`; `LANG`; `LC_*`; `TZ`; `TERM=dumb`; `SHELL=/bin/bash`; `TMPDIR=/tmp`;
  - `NO_COLOR=1`, `CI=1`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`;
  - `GIT_AUTHOR_NAME/EMAIL` from `git config user.*` (read by the host);
  - `npm_config_cache`, `PIP_CACHE_DIR` and `XDG_CACHE_HOME` pointed into the thread's cache dirs (§8.3);
  - git: `GIT_OBJECT_DIRECTORY=<thread object dir>`, `GIT_ALTERNATE_OBJECT_DIRECTORIES=<common>/objects`,
    `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=gc.auto`, `GIT_CONFIG_VALUE_0=0` (no `gc --auto` killed mid-repack);
  - when network is approved: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lower-case forms) =
    `http://127.0.0.1:3128`, the in-sandbox forwarder (§8.3);
  - plus the project's **allowlisted names** (Settings › Code › Project › Environment).
- **Names matching `/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|GMI_|OPENAI|ANTHROPIC|AWS_|AZURE_|GCP_|GOOGLE_)/i`**
  can be allowlisted only through a native confirmation in main, and their values are never logged.
- **The host's own env is already scrubbed at spawn** (§5.1), so there is nothing to leak by accident.

### 8.5 Web fetch (`tools/web.ts`)

- **Mode:** `off` (default for new projects), `ask` (each host is approved once per thread or always), or `allowlist`
  (project list + defaults `docs.gmicloud.ai`, `developer.mozilla.org`, `nodejs.org`, `docs.python.org`, `pypi.org`,
  `www.npmjs.com`, `raw.githubusercontent.com`, `github.com`).
- **Transport:** `node:https` with a custom `lookup` that **rejects loopback, private, link-local, CGNAT and multicast
  IPs after DNS resolution**. This stops SSRF to 127.0.0.1 services, the router or cloud metadata, and DNS rebinding,
  because the lookup result is the connect address.
  - https only; ≤ 5 redirects, each re-validated (host policy + IP check);
  - no cookies; UA `GMI-Desk/<v> (agent fetch)`.
  - The shell's network proxy (§8.3) uses this same `lookup` and host policy.
- **Response:** ≤ 5 MiB; HTML → text (scripts, styles and nav stripped; links kept as `[text](url)`); ≤ 20k tokens,
  then spilled.
- **The output is untrusted data** (§18). It is wrapped in `<fetched url="…">…</fetched>` so the model can tell it
  apart. This is not a defence by itself.

### 8.6 Subagents (`tools/task.ts`)

- **Own context in storage.** A subagent runs with its own `context_id` (its child run id): its messages, reads, todos
  and usage are stored and built per context (§5.2). Its reads never mark a file as seen for the parent.
- **`explore`:** read, list, glob, grep, web_fetch (if allowed). No mutation, no shell. Default model DeepSeek-V4-Flash.
  At most 20 steps and $0.25. Up to 2 at once per thread.
- **`general`:** the same tools as the parent, under the parent's permission rules and mode. Depth 1; a subagent
  cannot spawn subagents. **At most one `general` subagent per thread at a time.** Its mutations take the thread's
  worktree mutation lock, shared with the parent.
- `task` is a barrier in the parent's tool batch (§6.2), so the parent does not edit while a child runs.
- **Report:** ≤ 2k tokens as the tool result. The subagent's own transcript is stored as a child run, shown collapsed
  in the timeline (`subagent` item) and never added to the parent context.
- **Scheduler:** `background` priority.

### 8.7 Output truncation and spill

- Full outputs go to spill files (§5.2).
- The model sees head and tail with a marker and can `read` the spill: the path appears as `spill:<id>` and the read
  tool maps it, within this thread only.
- While a tool runs, the UI receives its first 32 KiB live and then a 1 Hz tail window (§6.6). Afterwards it shows a
  64 KiB preview and "Open full output" (`readSpill`).
- Spill files are named by the internal tool-call id (§7.1), so repeated provider ids cannot overwrite each other.

---

## 9. Permissions (`src/harness/perm/`)

### 9.1 Rule model

```
rule = { tool: glob ("bash", "edit", "mcp__github__*", "sandbox_exec", "*"),
         pattern: string|null   // path glob (fs tools), command pattern (bash), host (web_fetch/network), arg glob (mcp)
         effect: allow | deny,  scope: thread | project | global,  source: preset | user | project_file }
evaluate(call):
  1. hard denies (§8.2.5, destructive class for non full-access) → deny
  2. any matching deny rule → deny
  3. last matching allow rule (scope precedence thread > project > global) → allow
  4. mode preset (§9.2) → allow | ask
  5. default → ask
```

- Rules persist in `permission_rules`.
- User-created **allow** rules name exactly one tool (no wildcards) and a pattern no broader than the request's
  `suggestedRule` (§9.4). Wildcards exist only in presets and in deny rules.
- **Project-file rules** (`.gmi-desk/permissions.json`) apply only after the project is trusted (§12.1). They can only
  **add denies or asks**; they cannot add allows. A malicious repo cannot pre-approve itself.

### 9.2 Modes (T3 vocabulary)

| Mode | File edits in the worktree | Shell (sandboxed, net off) | Network / web | MCP | Notes |
|---|---|---|---|---|---|
| `approval-required` | ask | ask (except the read-only allowlist) | ask | ask (except GMI read tools) | |
| **`auto-accept-edits`** (default) | allow (sensitive files ask) | ask, except the read-only allowlist and the project's approved test/build commands | ask | per-server policy | |
| `auto` | allow | allow (still sandboxed, net off) | ask | per-server policy | Needs a working sandbox; **native confirmation** to enable |
| `full-access` | allow | allow, network through the proxy (§8.3) | allow (allowlist ignored, IP block kept) | allow | Native confirmation each time it is enabled. Hard denies, the destructive class and `costs_money` tools still ask. |

**Read-only shell allowlist** (only for simple commands with no metacharacters, §9.3). Allowlisted commands run in the
**`readonly` sandbox profile** (§8.3), so read-only is enforced by the mounts even if a flag slips through. Each command
also has a flag rule; a denied flag turns the command into an ordinary shell command (ask):
- `git status|diff|log|show|rev-parse|ls-files|blame`: no `-c`, `--config-env`, `--output`/`--output=`, `--ext-diff`,
  `--textconv`, `--exec-path`, `--paginate`/`-p` as a git option;
- `git branch`: list forms only (`-a`, `-r`, `-v`, `--list`, `--contains`, `--show-current`); no `-d`, `-D`, `-m`,
  `-M`, `-c`, `-C`, `-f`, `--set-upstream-to`, `--edit-description`, and no positional branch name;
- `ls`, `pwd`, `cat`, `head`, `tail` (no `-f`), `wc`, `which`, `node -v`, `python3 -V`, `npm ls`;
- `rg`: no `--pre`, `--pre-glob`, `-z`/`--search-zip`; `grep`;
- `find`: no `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`;
- `tree`: no `-o`.
(`rg --pre sh x <file>` executes the file; verified with rg 14.1.0. These cases are part of the ≈ 80-case permission
table, §16.)

### 9.3 Command classification (`perm/command.ts`)

- **Tokenise** with a small POSIX shell lexer. Compound commands (`; && || |`, `$( )`, backticks, `>`, `>>`, `<(`,
  `&`, here-docs, `eval`, `sudo`) → never matched by an allowlist rule: **ask** (or allow in `auto`/`full-access`
  within the sandbox).
- **Destructive class** (asks in every mode, deny in unattended):
  - `rm -rf` on `/`, `~`, `..` or `*` at the root; `git push --force*`, `git reset --hard` on non-thread refs;
    `git clean -xdf`;
  - `chmod -R`/`chown -R` outside the worktree; `dd`, `mkfs`; `kill -9 -1`;
  - `curl|wget … | sh|bash`; writes to `/dev/sd*`; `:(){`.
- **Flag rules** of the read-only allowlist (§9.2) are checked on the lexed argv.
- **"Always allow" suggestions** are command-prefix patterns (`npm test`, `pytest -q`, `cargo test`), never `*`.

### 9.4 Approvals

**Card** (renderer) and **native dialog** (main, used when the window is unfocused, for loosening and for paid tools):
- The card shows the tool, the full command and cwd, the paths, a diff preview for edits (≤ 200 lines), the URL/host,
  the MCP server and tool with arguments (pretty, ≤ 4 KiB), the cost estimate (paid MCP or compute), and risk chips.
- **Decisions:** Allow once (optionally "allow writes to sensitive files", §8.2.6) · Allow for this thread · Always
  (editable pattern, scope project or global) · Deny · Deny with feedback (the text goes to the model as the tool
  result).
- Main fills `allowedDecisions` on every request and refuses anything else:
  - `costs_money` tools (paid GMI MCP, `sandbox_create`, `sandbox_resume`, `sandbox_extend`) and `upload_media` accept
    **only** Allow once and Deny: each call has its own approval and a native dialog with the price (§10.3);
  - `allow_always` rules must name exactly the requested tool (`rule.tool === request.tool`, no wildcards) and a
    pattern no broader than `suggestedRule` (a prefix of the same command, a path inside the same directory, the same
    host); anything broader → native dialog;
  - `allow_thread` or `allow_always` for network, web hosts, MCP tools and `sandbox_*` → native dialog.
- Keyboard: `y` / `n`.

**Pending approvals:**
- They appear on the thread row (amber dot and count) and on the Code nav item badge.
- A desktop notification goes out when the window is unfocused, throttled per thread.
- They expire after 24 h → denied as "no answer". The turn's wall clock is paused while they wait (§6.3).

**Loosening: one `isLoosening(before, after)` in main** (`services/code/loosen.ts`, the same shape as
`describeLoosening` in `usage/budget.ts`). It returns the lines for the native dialog and covers:
- the mode: switching to `auto` or `full-access`;
- thread settings: `network`, `webFetch` (`off` → `ask` → `allowlist`), `computerId` (binding a paid remote computer
  grants exec on it), `maxContextTokens` above the default, raised caps;
- MCP: `addMcpServer`, `updateMcpServer` enabling a server or setting any tool to `allow`; enabling the optional
  `sandbox_create`, `sandbox_resume` and `sandbox_extend` tools (§10.4);
- approval decisions, as listed above;
- allowlisting secret-like env names.

Every one of these paths is in H3-A's FakePlatform `confirms` acceptance tests. The renderer cannot loosen anything on
its own: `CodeApi.updateThread`, `updateMcpServer` and `respondApproval` route through main's approval broker, which
shows the dialog before forwarding to the host. The host's `dialog.confirm` RPC has no loosening kind (§13.3).

---

## 10. MCP (`src/harness/mcp/`)

### 10.1 Client and transports

- **Library:** `@modelcontextprotocol/sdk` **1.32.2** (already a dependency; MIT). A move to the v2 split packages
  (`@modelcontextprotocol/client` 2.4.0, Apache-2.0) is planned, but not needed for H3.
- **stdio:**
  - started through the same `SandboxRunner` `exec` profile as bash (§8.3): network only through the proxy, and only
    if the server config declares `network: true` (the trust dialog shows it); HOME = a fresh tmpfs with a per-server
    cache dir; cwd = the worktree or the server dir; env = allowlist + declared env;
  - declared secret env values come from main's secure store at spawn: `rpc secrets.mcpEnv`, a native confirmation
    once per server;
  - a process group per server; killed on stop or thread end.
- **Streamable HTTP:**
  - **bearer** tokens are stored in main and fetched per connection;
  - **OAuth** servers: main runs PKCE with the app's loopback code (each authorisation is a user action in the system
    browser) and stores the tokens in `ctx.secure` (`mcp.<serverId>.tokens`). The host gets short-lived access tokens
    over RPC (`mcp.oauth.token`), and main handles refresh.
- **Timeouts:** connect 15 s, `tools/list` 10 s, a call 60 s (configurable per server). Elicitation (form or URL) is
  shown as an approval card (`mcp-elicitation`).
- **Exposure:**
  - the tool list is **frozen per user turn**;
  - beyond 40 MCP tools, deferred exposure: a `tool_search` meta-tool returns schemas on demand, so large servers do not
    bloat the prefix;
  - tool names are namespaced `mcp__<server>__<tool>`.

### 10.2 Trust and pinning

- **Project MCP config** (`.mcp.json` / `.gmi-desk/mcp.json`) is **never started automatically**. The project trust
  dialog (native) lists each server's exact command and args or URL, its declared network access and its env names.
- The trust is keyed by the config hash. A change sets `trust.state = changed`, and the servers stop until the user
  trusts again.
- **Tool description pinning (rug-pull / tool-poisoning defence):**
  - each tool's `sha256(description + inputSchema)` is stored at trust time;
  - a later change marks the tool `changed`, removes it from the exposed set and asks;
  - descriptions are capped at 1 KiB and schemas at 4 KiB, with control characters and zero-width characters
    stripped.
- **Package pinning.** The config hash does not pin code: `npx -y pkg`, `uvx pkg` and `pipx run pkg` fetch the latest
  version at every start. Commands that fetch packages at start (`npx`, `pnpm dlx`, `bunx`, `uvx`, `pipx run`) must
  name an exact version (`pkg@1.2.3`, `pkg==1.2.3`). Otherwise the trust dialog marks the server **unpinned**
  (`unpinned` risk flag). The host records the resolved version at first start (from the installed package's manifest
  in the server's cache dir) and asks for re-trust when it changes.
- **Per-tool policy:** `allow | ask | deny`. Servers can mark tools `readOnlyHint`, but hints never auto-allow
  third-party tools; only the user's policy can.

### 10.3 Built-in GMI MCP

- **Path:** the host calls `rpc mcp.gmi.call` → main's `mcp-bridge.ts` → the existing `McpGateway`. The OAuth token
  stays in main.
- **Auto-allowed (free reads):** `search_models`, `get_model`, `search_docs`, `get_account_summary`,
  `list_generations`, `get_generation`, `estimate_generation`. Main enforces this list too.
- **Paid or side-effect tools are enforced in main**, not by the host's permission engine:
  - `mcp-bridge.ts` runs `submit_generation`, `upload_media` or `create_support_request` only with a **one-shot
    approval token** that main's approval broker minted for that `requestId` and `sha256(canonical args)`. The token is
    consumed on use; a call with no token, a used token or different arguments is refused.
  - `submit_generation`: main calls `estimate_generation` itself, shows a **native dialog** with the price, runs
    `BudgetGuard.check` (honouring `confirmAboveUsd`), and **reserves the estimate against the thread's turn and thread
    caps** before the call. The actual cost is recorded with ref `thr:<id>/turn:<n>/media`.
  - `upload_media`: native dialog that says the file becomes a public, unsigned URL.
  - `create_support_request`: native dialog every time (it files a new ticket each time).
  - `allow_thread` and `allow_always` are refused for all three.
- The same token, native dialog and thread reservation apply to `sandbox_create`, `sandbox_resume` and `sandbox_extend`
  (§10.4).

### 10.4 Built-in sandbox MCP (H4): an agent drives the computer

- **Binding:** a thread is bound to at most one compute resource (`settings.computerId`), chosen by the user ("Attach
  computer"). Main issues a **grant**:
  `{grantId, threadId, resourceId, ops: ['exec','files','ports','status'], expiresAt: run end}`.
- **Validation:** main's `ComputeBroker` checks the grant on **every** call. The host never sees the compute key or
  data-plane tokens.
- **Tools:**

  | Tool | Maps to (compute.md) | Policy |
  |---|---|---|
  | `sandbox_exec {command, cwd?, env?, timeout_s≤600}` | v2 exec with `execution_timeout_seconds = timeout_s` always set, `wait=true&wait_timeout_seconds=25`, then poll; `Idempotency-Key = base32(sha256(grantId:runId:tc_id))[:40]` (v2 keys are 1–64 printable ASCII, remembered 24 h `[V]`) | ask by default (`auto`: allow); output head+tail; `*_truncated` flags |
  | `sandbox_read {path, max_bytes}` / `sandbox_list {path}` | `/files` GET / exec listing (env-passed paths) | allow |
  | `sandbox_write {path, content}` | `/files` POST (+ `mkdir -p`) | allow in `auto-accept-edits` |
  | `sandbox_upload_tree {local_dir (worktree-relative), remote_dir}` | tar in the host of tracked and untracked-not-ignored files only (`.git`, ignored files and the masked-secret list excluded; paths §8.2) → `/files` → `tar -xf` via exec | ask |
  | `sandbox_download {remote_path, local_path (worktree-relative)}` | `/files` GET → write through §8.2 | ask |
  | `sandbox_ports {}` / `sandbox_status {}` | port scan / resource status, accrued $, end time | allow |
  | `sandbox_start_service {name, command, port?}` | compute.md §8.3 services | ask |
  | `sandbox_preview {port}` | opens the preview in the user's dock (no data back to the model except status) | allow |

- **Not model tools by default:** create, resume, delete, extend beyond the lease, network or EIP changes. An optional
  setting adds `sandbox_create`, `sandbox_resume` and `sandbox_extend`, **each needing a one-shot approval token and a
  native dialog with the price** (compute.md DC4), reserved against the thread's caps (§10.3). Enabling the setting
  is itself a loosening (§9.4).
- **Exec slots:** the broker acquires slots through C2-A's `ExecPort.acquire({priority: 'agent'})`. The per-sandbox
  semaphore (10 slots, the v2 limit on non-terminal executions `[V]`) is shared with the user's panel; the agent gets
  at most 6. A slot is held **until the execution reaches a terminal state** (polling `GET /executions/{eid}`), not
  until the HTTP call returns: a 25 s wait that times out leaves the execution running.
- **Cancellation:** on interrupt, grant revoke or run end, the broker sends `POST /executions/{eid}/cancel` for every
  execution of the grant. In-flight eids are persisted in the compute registry; when a session opens or the app starts,
  they are polled or cancelled before any slot is granted. A 429 `Execution.ConcurrencyLimitExceeded` lowers the
  local capacity to the observed level and backs off.
- **Egress:** a sandbox with purpose `agent` defaults to **deny-all egress**. Hosts are added per thread with a native
  confirmation (compute.md §7.1). `github.com`, `api.github.com`, `uploads.github.com` and `upload.pypi.org` are never
  allowed by default; the dialog notes that `registry.npmjs.org` also accepts `npm publish`.
- Agent exec counts as activity for the idle guard only during an active run (compute.md §9.5).
- **Secrets:** main rejects `sandbox_exec`, `sandbox_write` and `sandbox_start_service` inputs that contain a stored
  secret as a substring (compute.md §6.1).
- **Visibility:** an "Agent" lane in the dock (H4-C) shows each exec (command, exit code, duration) live, so the user
  sees what the agent does on the computer. The agent never uses the interactive shell: v2 allows a single attachment,
  which belongs to the user.
- **Security:** the agent's remote commands run in GMI's sandbox (the isolation boundary). Local files reach the
  sandbox only through `sandbox_upload_tree` (ask; `.git`, ignored files and secrets excluded). No GMI keys are ever
  sent (compute.md T15). Residual: if the user allows egress to a host that accepts uploads, an injected agent can send
  the uploaded tree there (H-T2).

---

## 11. Runtime adapter (`src/harness/runtime/`)

```ts
export interface RuntimeCapabilities {
  steering: boolean; checkpoints: boolean; mcp: boolean; permissions: 'native' | 'adapter'; subagents: boolean; compaction: 'native' | 'runtime';
}
export type RuntimeEvent = { threadId: string; type: string; payload: unknown }; // normalised to ThreadEvent by the adapter
export interface RuntimeAdapter {
  readonly id: RuntimeId;                      // 'gmi' (native) | 'opencode' (later)
  capabilities(): RuntimeCapabilities;
  ensureThread(spec: { threadId: string; worktree: string; settings: CodeThreadSettings }): Promise<void>;
  startTurn(threadId: string, input: { text: string; commandId: string }, signal: AbortSignal): Promise<{ runId: string }>;
  steerTurn(threadId: string, text: string): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  respond(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  readSnapshot(threadId: string): Promise<{ items: TimelineItem[]; status: RunStatus }>;
  rollback(threadId: string, checkpointId: string): Promise<void>;
  events(): AsyncIterable<RuntimeEvent>;
  dispose(): Promise<void>;
}
```

- **`gmi`** (native) implements this directly over the loop.
- **OpenCode (later)** would:
  - run `opencode serve --stdio`, pinned (e.g. 2.2.x), with `OPENCODE_DISABLE_AUTOUPDATE=1`, and isolated `XDG_*`
    under `<userData>/runtimes/opencode/`;
  - use a config whose only provider is the loopback gateway (§4.9) with its per-run bearer;
  - have its env scrubbed (OpenCode's shell inherits env `[V]`);
  - map OpenCode `/permission` requests to our approval cards.
- The decision to ship it is separate (D-entry), after H4.

---

## 12. Code tab

### 12.1 Projects

- **Adding a project:** "Add repository" opens a **native folder picker** in main (`Platform.pickDirectory`). Main
  checks `git rev-parse --show-toplevel` (with the safe git flags, §8.2) and rejects the filesystem root, the home
  root, userData and `~/.ssh`.
- **Trust dialog** (native), on first use and whenever the config hash changes. It lists:
  - instruction files (AGENTS.md, CLAUDE.md, `.gmi-desk/instructions.md`; size and first lines);
  - MCP servers (exact commands);
  - `.gmi-desk/permissions.json`;
  - the setup command.
  Before trust, the project works with built-in tools only, and no project files are injected into prompts except
  through explicit `read`. On trust, the listed files are stored as the **trusted snapshot** (`trusted_files`); prompts,
  the MCP manager and the permission engine read only that snapshot (§7.1).
- **Ref storage:** at add time the host records `ref_format` (`extensions.refStorage`; `reftable` makes the git
  metadata read-only in the sandbox for every strategy, §8.3).
- **Worktree dir:** default `$XDG_DATA_HOME/gmi-desk/worktrees/<repoName>-<hash8>/` (macOS: Application Support). It
  is outside userData/secure, absolute, not a filesystem root, realpath-checked, and not inside a `.git` directory.
- **Setup command:** an optional per-project command (e.g. `npm ci`) runs in a new worktree on creation, as a
  sandboxed bash with a per-command network approval card.

### 12.2 Threads (T3-style)

- **Strategies:**
  - `worktree` (default): `git worktree add --lock -b gmi/<threadId6>/<slug> <dir> <baseRef>`. The base ref is
    validated (`-` → `@{-1}`) and `base_sha` is recorded, together with the git dir, common dir, `.git` pointer content
    and object dir that git-safe will use (§8.2). One ref directory per thread is what lets the sandbox mount only this
    thread's refs writable (§8.3). A user-chosen branch name becomes `gmi/<id6>/<name>`. A locked worktree is never
    pruned, even while its directory looks missing (sibling worktrees sit inside each sandbox's hidden `$HOME`).
  - `existing_worktree`: git metadata read-only in the sandbox (§8.3).
  - `root` (works in the repo itself): a native confirmation; at most one active `root` thread per repo; git metadata
    read-only in the sandbox; not offered for reftable repositories.
- **Lifecycle:** `creating → setting_up → ready → (runs) → archived`.
  - **Recovery at host start:** threads in `creating` or `setting_up` are reconciled against
    `git worktree list --porcelain`. A complete worktree continues with setup state `failed` and "Re-run setup". A
    half-made one is rolled back (`git worktree remove --force` on that path only, delete our branch) and the thread is
    marked `failed: setup` with "Retry".
  - **Per-repo mutex** (host, async) for every write to shared repo state: worktree add, remove and unlock, branch
    create and delete, `update-ref`, object import, merge, ref restore.
  - **Stale locks:** at host start and before a git write, `*.lock` files in the thread's git dir, in
    `refs/heads/gmi/<id6>/` and the worktree's `index.lock` are removed when no git process of ours is alive
    (`git_procs`). Lock files elsewhere in the common dir are reported, never removed.
  - Archive checks for uncommitted changes (a native confirmation lists them), then `git worktree unlock`,
    `git worktree remove` for that worktree, and optionally `git branch -D`. A blanket `git worktree prune` is never
    run.
  - At host start, orphaned worktree dirs are listed in Settings for cleanup. They are never deleted automatically.
- **Parallelism:** any number of threads may run. The gateway scheduler queues them (TPM, concurrency) and the UI shows
  queue positions. Each thread is confined to its own worktree, refs and object dir by bwrap; threads never share
  one, and none can change another's git metadata.

### 12.3 Screens (D16–D18 rules)

**Left: thread list.**
- Grouped by project, with a collapsible header and a "+ New thread" action per project.
- A row shows: a status signal (**Plates** while running; amber dot with the count of awaiting approvals or
  `awaiting_user`; red failed; grey idle), title, branch chip (mono micro-label), `+12 −3`, cost, relative time.
- A selected row uses `bg-accent` + the inner active bar. Keyboard: ↑/↓, Enter, ⌘/Ctrl+N (new thread on Code).

**Centre: timeline** (46rem column):
- user messages; assistant text (Markdown, remote images click-to-load as today); collapsible reasoning;
- tool cards: compact rows with an icon, title (`Read src/app.ts`, `$ npm test`), status, duration; expanding shows
  output (preview + "full output"), diffs for edits, and exit codes;
- approval cards (§9.4); compaction markers ("Context compacted · 182k → 41k tokens · $0.03"); checkpoint markers
  ("Turn 3 checkpoint · Restore"); subagent cards; notices;
- virtualised beyond 300 items.

**Composer:**
- text area (Enter sends; Shift+Enter newline; while running, Enter = steer);
- model picker (catalog LLMs, a tool-capable badge from the capability table);
- mode `Select`;
- the **meter**: `turn $0.04 · thread $0.62 / $5.00 · ctx 61% (81% cached)` with a context bar, and a popover with
  tokens in / cached / out / reasoning, compactions and the tier boundary;
- Stop (while running).
The **lime fill is the Send button only**.

**Right panel** (`w-details`): tabs **Changes** (diff stat per file; the sensitive-file badge) · **Todo** · **Context**
(meter details, prefix hash, cache trend). It collapses when the computer dock is open (compute.md §8.6).

**Review:**
- A per-file unified diff, against the base or a checkpoint, from the host's `git diff` parsed into hunks (no diff
  library). Large files (> 2,000 lines of diff) are collapsed, with "Show".
- **Actions:**
  - **Discard file** (restore from base, with confirm). The path must be in the thread's current diff list and
    reaches git as a literal pathspec after `--`;
  - **Commit** through git-safe (message: typed, or "Suggest" through the side-task model; metered);
  - **Merge into <base>**: a native confirmation listing the changed files and, separately, every execution-sensitive
    change (hooks, workflows, `.envrc`, instructions…). It requires a clean project root, imports the thread's objects
    into the common store (verified, §8.3), and runs `git merge --no-ff` or `--squash` in the root through git-safe.
    Conflicts → abort and explain.
  - **Export patch** (native save);
  - **Reveal worktree** (system file manager).
  - Push or PR creation is not in v1 (network, credentials).

**Settings › Code:** rate-limit tier, defaults (model, subagent, compaction, side task, mode, caps, working window),
sandbox status and self-test (including the network proxy), rules list (delete), MCP servers (add, edit, authorise,
trust state, pinned version), web allowlist, project env allowlist.

---

## 13. Contracts

### 13.1 `src/shared/contracts/code.ts` (new)

```ts
/**
 * Code tab: projects (git repos), parallel agent threads on git worktrees, approvals, review.
 * The agent loop runs in the harness host; model traffic goes through the GMI gateway in main.
 */
import type { ReasoningEffort } from './chat';
import type { GatewayStatus } from './gateway';

export type RuntimeId = 'gmi' | 'opencode';
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';

export interface CodeProject {
  id: string;
  name: string;
  /** Absolute, realpath. */
  rootPath: string;
  defaultBranch: string | null;
  trust: { state: 'untrusted' | 'trusted' | 'changed'; configHash: string | null; trustedAt: string | null };
  worktreeDir: string;
  setupCommand: string | null;
  addedAt: string;
  threadCount: number;
}

export type ThreadStrategy =
  /** A user-chosen branch name becomes `gmi/<id6>/<name>` (one ref directory per thread, §12.2). */
  | { kind: 'worktree'; baseRef: string; branch?: string | null }
  | { kind: 'existing_worktree'; path: string }
  | { kind: 'root' };

export interface ThreadBudget {
  perTurnUsd: number | null;
  perThreadUsd: number | null;
  maxStepsPerTurn: number;
  maxTurnMinutes: number;
}

export interface CodeThreadSettings {
  runtime: RuntimeId;
  model: string;
  subagentModel: string | null;
  compactionModel: string | null;
  /** Titles and commit messages: a cheap model id, or GMI Router ('router'). */
  sideTaskModel: string | null;
  mode: RuntimeMode;
  reasoningEffort: ReasoningEffort | null;
  maxOutputTokens: number;
  /** Keep prompts below the model's next long-context price tier (switched off per model when the tier is too small). */
  economy: boolean;
  /** Working window, default 160k (DH10). Null = the model's full window. Raising it is a loosening (native dialog). */
  maxContextTokens: number | null;
  webFetch: 'off' | 'ask' | 'allowlist';
  /** Shell network inside the sandbox, always through the app's proxy (§8.3). */
  network: 'off' | 'ask';
  budget: ThreadBudget;
  /** compute.md resource bound to this thread (H4). */
  computerId: string | null;
}

export const CODE_DEFAULTS = {
  maxStepsPerTurn: 50,
  /** Active minutes: paused while awaiting approval or the user. */
  maxTurnMinutes: 30,
  perTurnUsd: 1,
  perThreadUsd: 5,
  maxOutputTokens: 16_384,
  maxContextTokens: 160_000,
  /** Compact when the next step's cached cost would exceed perTurnUsd / this. */
  compactCostDivisor: 20,
  /** Compact above this many messages in context (main refuses 2,048). */
  compactMessageCount: 1_500,
  mode: 'auto-accept-edits',
} as const satisfies Partial<ThreadBudget> & {
  maxOutputTokens: number;
  maxContextTokens: number;
  compactCostDivisor: number;
  compactMessageCount: number;
  mode: RuntimeMode;
};

export type RunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_user'
  | 'compacting'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type QueueReason = 'tpm' | 'concurrency' | 'breaker' | 'budget' | 'offline';

export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface CodeThreadSummary {
  id: string;
  projectId: string;
  title: string;
  strategy: ThreadStrategy['kind'];
  branch: string | null;
  worktreePath: string | null;
  status: RunStatus;
  statusReason: string | null;
  pendingApprovals: number;
  /** Position in the gateway queue while `queued`. */
  queuePosition: number | null;
  queueReason: QueueReason | null;
  model: string;
  mode: RuntimeMode;
  costUsd: number;
  tokens: TokenTotals;
  diff: DiffStat | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ContextMeter {
  windowTokens: number;
  ceilingTokens: number;
  usedTokens: number;
  reserveTokens: number;
  /** cached / prompt of the last request. */
  cachedRatio: number | null;
  compactions: number;
  tierBoundaryTokens: number | null;
  messageCount: number;
  /** Main's display estimate of the next step at the expected cache share (§4.4). Null: unknown price. */
  nextStepUsd: number | null;
  /** usedTokens is an estimate (no measured usage yet since the last change). */
  estimated: boolean;
}

export interface StepUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  estimated: boolean;
  model: string;
  latencyMs: number | null;
}

export type ToolStatus = 'pending' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'interrupted';

export interface ToolOutputPreview {
  text: string;
  truncated: boolean;
  totalBytes: number;
  spillId: string | null;
  exitCode?: number | null;
}

export type NoticeReason =
  | 'step_cap'
  | 'cost_cap'
  | 'time_cap'
  | 'budget'
  | 'doom_loop'
  | 'overflow'
  | 'output_limit'
  | 'interrupted'
  | 'sandbox_unavailable'
  | 'rate_limited'
  | 'model_error'
  | 'checkpoint_restored'
  | 'instructions_changed'
  | 'ref_changed'
  | 'cache_low'
  | 'execution_sensitive'
  | 'git_tampered'
  | 'economy_disabled'
  | 'offline';

export type ApprovalKind = 'command' | 'file-change' | 'file-read' | 'network' | 'mcp' | 'mcp-elicitation' | 'compute' | 'question';

export type RiskFlag =
  | 'network'
  | 'outside_worktree'
  | 'destructive'
  | 'execution_sensitive'
  | 'secret_path'
  | 'unsandboxed'
  | 'costs_money'
  | 'compound_command'
  | 'changed_tool'
  /** Network without the proxy: reaches localhost and the LAN (§8.3). */
  | 'local_network'
  /** MCP server whose package version is not pinned (§10.2). */
  | 'unpinned';

export interface PermissionRuleDraft {
  tool: string;
  pattern: string | null;
  effect: 'allow' | 'deny';
  scope: 'thread' | 'project' | 'global';
}

export interface PermissionRule extends PermissionRuleDraft {
  id: string;
  projectId: string | null;
  threadId: string | null;
  source: 'preset' | 'user' | 'project_file';
  createdAt: string;
}

export interface ApprovalRequest {
  requestId: string;
  threadId: string;
  runId: string;
  toolCallId: string | null;
  kind: ApprovalKind;
  tool: string;
  title: string;
  detail: {
    command?: string;
    cwd?: string;
    paths?: string[];
    /** Unified diff preview, ≤ 200 lines. */
    diff?: string;
    url?: string;
    host?: string;
    server?: string;
    /** Pretty JSON, ≤ 4 KiB. */
    args?: string;
    costUsd?: number | null;
    question?: string;
    options?: string[];
  };
  risk: RiskFlag[];
  suggestedRule: PermissionRuleDraft | null;
  /** Filled by main; any other decision is refused (§9.4). */
  allowedDecisions: Array<ApprovalDecision['kind']>;
  createdAt: string;
  expiresAt: string | null;
}

export type ApprovalDecision =
  /** sensitiveWrites: lets this one command write execution-sensitive files (§8.2.6). */
  | { kind: 'allow_once'; sensitiveWrites?: boolean }
  | { kind: 'allow_thread' }
  | { kind: 'allow_always'; rule: PermissionRuleDraft }
  | { kind: 'deny'; feedback?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'cancel_run' };

/** `seq` on timeline items and durable events = the thread's contiguous thread_seq (§6.6). */
export type TimelineItem =
  | { kind: 'user'; id: string; seq: number; turn: number; text: string; steering: boolean; at: string }
  | {
      kind: 'assistant';
      id: string;
      seq: number;
      turn: number;
      step: number;
      text: string;
      reasoning: string | null;
      model: string;
      usage: StepUsage | null;
      status: 'streaming' | 'complete' | 'stopped' | 'error';
      at: string;
    }
  | {
      kind: 'tool';
      id: string;
      seq: number;
      turn: number;
      step: number;
      toolCallId: string;
      tool: string;
      title: string;
      argsPreview: string;
      status: ToolStatus;
      output: ToolOutputPreview | null;
      durationMs: number | null;
      at: string;
    }
  | { kind: 'approval'; id: string; seq: number; request: ApprovalRequest; decision: ApprovalDecision | null }
  | { kind: 'compaction'; id: string; seq: number; beforeTokens: number; afterTokens: number; model: string; costUsd: number | null; at: string }
  | { kind: 'checkpoint'; id: string; seq: number; checkpointId: string; turn: number; filesChanged: number; at: string }
  | { kind: 'subagent'; id: string; seq: number; toolCallId: string; agent: string; model: string; status: RunStatus; summary: string | null; costUsd: number | null }
  | { kind: 'notice'; id: string; seq: number; level: 'info' | 'warning' | 'error'; reason: NoticeReason; text: string; at: string };

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  /** Execution-sensitive path (hooks, workflows, scripts, .envrc …). */
  sensitive: boolean;
  /** Null in list views; filled by getFileDiff. */
  hunks: Array<{ header: string; lines: DiffLine[] }> | null;
  tooLarge: boolean;
}

export interface CheckpointInfo {
  id: string;
  turn: number;
  createdAt: string;
  filesChanged: number;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface CodeThread extends CodeThreadSummary {
  settings: CodeThreadSettings;
  baseRef: string | null;
  checkpoints: CheckpointInfo[];
  todo: TodoItem[];
  meter: ContextMeter;
  /** Last thread_seq. */
  lastSeq: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  scope: 'global' | 'project';
  projectId: string | null;
  transport:
    | { type: 'stdio'; command: string; args: string[]; envNames: string[]; cwd: string | null; network: boolean }
    | { type: 'http'; url: string; auth: 'none' | 'bearer' | 'oauth' };
  enabled: boolean;
  toolPolicy: Record<string, 'allow' | 'ask' | 'deny'>;
}

export interface McpServerStatus extends McpServerConfig {
  state: 'stopped' | 'starting' | 'ready' | 'needs_trust' | 'needs_auth' | 'error';
  /** npx/uvx/pipx package version resolved at first start; `unpinned` when the command names none (§10.2). */
  resolvedVersion: string | null;
  unpinned: boolean;
  tools: Array<{ name: string; changed: boolean; policy: 'allow' | 'ask' | 'deny' }>;
  error: string | null;
}

export interface CodeState {
  hostState: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped';
  /** Main serves threads read-only from the database while the host is crashed (§5.1). */
  viewOnly: boolean;
  sandbox: { kind: 'bwrap' | 'seatbelt' | 'none'; ok: boolean; detail: string | null; network: 'proxy' | 'shared_per_command' | 'none' };
  git: { ok: boolean; version: string | null };
  ripgrep: boolean;
  gateway: GatewayStatus;
  pendingApprovals: number;
  mock: boolean;
}

/** Durable events carry `seq` = the thread's contiguous thread_seq; ephemeral ones (delta, meter) carry null (§6.6). */
export type CodeThreadEvent =
  | { threadId: string; seq: number; type: 'item'; item: TimelineItem }
  | { threadId: string; seq: number; type: 'status'; status: RunStatus; reason: string | null; queuePosition: number | null; queueReason: QueueReason | null }
  | { threadId: string; seq: number; type: 'todo'; todo: TodoItem[] }
  | { threadId: string; seq: number; type: 'diff'; diff: DiffStat }
  | { threadId: string; seq: null; type: 'delta'; itemId: string; field: 'text' | 'reasoning' | 'output' | 'args'; text: string; offset: number }
  | { threadId: string; seq: null; type: 'meter'; meter: ContextMeter; tokens: TokenTotals; costUsd: number };

export interface CodeApi {
  getState(): Promise<CodeState>;
  listProjects(): Promise<CodeProject[]>;
  /** Native folder picker in main; must be a git repository. Null when cancelled. */
  addProject(): Promise<CodeProject | null>;
  removeProject(projectId: string, opts?: { removeWorktrees?: boolean }): Promise<void>;
  /** Native dialog listing the instruction files, MCP commands and permission files to trust. */
  trustProject(projectId: string): Promise<CodeProject>;
  updateProject(projectId: string, patch: { name?: string; setupCommand?: string | null; worktreeDir?: string }): Promise<CodeProject>;
  listThreads(opts?: { projectId?: string; archived?: boolean }): Promise<CodeThreadSummary[]>;
  getThread(threadId: string): Promise<CodeThread>;
  getTimeline(threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }): Promise<{ items: TimelineItem[]; hasMore: boolean; lastSeq: number }>;
  createThread(projectId: string, init: { title?: string; strategy: ThreadStrategy; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread>;
  /** Loosening (isLoosening, §9.4: mode, caps, network, webFetch, computerId, window) shows a native confirmation in main. */
  updateThread(threadId: string, patch: { title?: string; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread>;
  archiveThread(threadId: string, opts: { removeWorktree: boolean; deleteBranch: boolean }): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  send(threadId: string, text: string): Promise<{ runId: string; turn: number; budgetWarning: string | null }>;
  /** Queued into the running turn after the current step. */
  steer(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  /** Continues an interrupted or stopped run. */
  resume(threadId: string): Promise<{ runId: string }>;
  /** Main refuses decisions outside `allowedDecisions` and shows a native dialog for persistent or broader grants. */
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  listPendingApprovals(): Promise<ApprovalRequest[]>;
  getDiff(threadId: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }): Promise<DiffFile[]>;
  getFileDiff(threadId: string, path: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }): Promise<DiffFile>;
  /** `path` must be in the thread's current diff list (literal pathspec). */
  discardFile(threadId: string, path: string): Promise<void>;
  restoreCheckpoint(threadId: string, checkpointId: string): Promise<void>;
  commit(threadId: string, message: string): Promise<{ sha: string }>;
  suggestCommitMessage(threadId: string): Promise<{ message: string; costUsd: number | null }>;
  /** Native confirmation; the project root must be clean. */
  mergeToBase(threadId: string, method: 'merge' | 'squash'): Promise<{ sha: string }>;
  /** Native save dialog. Null when cancelled. */
  exportPatch(threadId: string): Promise<string | null>;
  revealWorktree(threadId: string): Promise<void>;
  readSpill(threadId: string, spillId: string): Promise<{ text: string; truncated: boolean }>;
  listRules(opts?: { projectId?: string }): Promise<PermissionRule[]>;
  deleteRule(ruleId: string): Promise<void>;
  listMcpServers(opts?: { projectId?: string }): Promise<McpServerStatus[]>;
  /** stdio servers need a native confirmation showing the exact command; env values go to the secure store. */
  addMcpServer(config: Omit<McpServerConfig, 'id'>, env?: Record<string, string>): Promise<McpServerStatus>;
  /** Enabling a server or setting a tool to 'allow' is a loosening (native confirmation). */
  updateMcpServer(id: string, patch: Partial<Pick<McpServerConfig, 'enabled' | 'toolPolicy' | 'name'>>): Promise<McpServerStatus>;
  removeMcpServer(id: string): Promise<void>;
  /** OAuth in the system browser (main). */
  authorizeMcpServer(id: string): Promise<McpServerStatus>;
  getGatewayStatus(): Promise<GatewayStatus>;
  /** Re-runs the sandbox self-test. */
  checkSandbox(): Promise<CodeState>;
}
```

**Events** (added to `GmiEvents` / `EVENT_NAMES`):
```ts
'code:state': CodeState;                                   // throttled ≤ 1/s
'code:threads': CodeThreadSummary[];
'code:event': CodeThreadEvent;                             // durable events in thread_seq order; deltas/meters ephemeral, batched once in the host
'code:approval': { request: ApprovalRequest; resolved: boolean };
'code:gateway': GatewayStatus;                             // throttled 1/s, only while the Code page or Usage is visible
```

### 13.2 `src/shared/contracts/gateway.ts` (new) and the `core/services.ts` interface

```ts
import type { RouterMode } from './app';
import type { ReasoningEffort, RoutingInfo, TokenUsage } from './chat';
import type { GmiErrorShape } from './errors';

export type GatewayPurpose = 'chat' | 'agent' | 'subagent' | 'compaction' | 'title' | 'commit_message' | 'probe' | 'eval';
export type GatewayPriority = 'interactive' | 'foreground' | 'background' | 'idle';

export type GwPart = { type: 'text'; text: string };
export interface GwToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it (replayed byte-for-byte). */
  arguments: string;
}
export interface GwMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | GwPart[];
  toolCalls?: GwToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: { text: string; family: string } | null;
}
export interface GwToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GatewayScope {
  threadId: string | null;
  turnId: string | null;
  runId: string | null;
  step: number | null;
}

export interface GatewayRequest {
  requestId: string;
  /** purpose, priority and scope of host requests are validated against the runs main tracks (§4.4). */
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  scope: GatewayScope;
  /** GMI Router accepts plain text only (tools must be absent). */
  target: { model: string } | { router: RouterMode };
  messages: GwMessage[];
  tools?: GwToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  parallelToolCalls?: boolean;
  maxOutputTokens: number;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  /** Diagnostics only. Token estimates are main's own (§4.4); the request carries none. */
  prefixHash: string | null;
  cacheKey?: string | null;
}

export type GatewayFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export type GatewayEvent =
  | { type: 'queued'; position: number; etaMs: number | null; reason: 'tpm' | 'concurrency' | 'breaker' | 'budget' | 'offline' }
  | { type: 'started'; attempt: number; model: string | null; api: 'chat' | 'responses' | 'router' }
  | { type: 'retry'; attempt: number; delayMs: number; code: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id: string | null; name: string | null; argumentsDelta: string }
  | { type: 'tool_call'; call: GwToolCall }
  | { type: 'model'; model: string }
  | { type: 'routing'; routing: RoutingInfo }
  | { type: 'usage'; usage: TokenUsage; cacheWriteTokens: number | null; costUsd: number | null; estimated: boolean; maybeBilled: boolean }
  | { type: 'finish'; reason: GatewayFinishReason; raw: string | null }
  | { type: 'error'; error: GmiErrorShape; afterOutput: boolean };

export interface GatewayModelState {
  model: string;
  breaker: 'closed' | 'open' | 'half_open';
  reopenAt: string | null;
  inFlight: number;
}

export interface GatewayStatus {
  /** False while the connectivity gate is closed (§4.6). */
  online: boolean;
  tpmLimit: number;
  tpmEffective: number;
  tpmUsedLastMinute: number;
  queued: number;
  inFlight: number;
  models: GatewayModelState[];
  cacheHitRatio24h: number | null;
  last429At: string | null;
  updatedAt: string;
}

export const GATEWAY_TPM_TIERS = { t1: 1_000_000, t2: 3_000_000, t3: 50_000_000, t4: 100_000_000, t5: 300_000_000 } as const;
```

```ts
// src/main/core/services.ts (addition)
export interface ThreadCaps {
  perTurnUsd: number | null;
  perThreadUsd: number | null;
}

export interface GmiGateway {
  /**
   * Upstream failures end the stream with an `error` event; throws only GmiError('invalid_input').
   * `owner` is set by the harness supervisor (never by the host message): abortOwner() ends these requests.
   */
  stream(req: GatewayRequest, signal: AbortSignal, owner?: { hostId: string } | null): AsyncIterable<GatewayEvent>;
  /** Main's own estimate from the body: the worst-case reservation and the display estimate (§4.4). */
  estimate(req: Pick<GatewayRequest, 'target' | 'messages' | 'tools' | 'maxOutputTokens' | 'scope'>): {
    promptTokens: number;
    expectedCachedTokens: number;
    reserveUsd: number | null;
    expectedUsd: number | null;
  };
  status(): GatewayStatus;
  /** Aborts every request of a host that exited, settles them (estimated) and releases their reservations. */
  abortOwner(hostId: string): void;
  /** Runs main tracks; host requests outside a running run are refused (§4.4). */
  openRun(scope: { threadId: string; turnId: string; runId: string }): void;
  closeRun(runId: string): void;
  /** Persisted (gateway-threads.json). Accepted only when it tightens the stored caps. */
  setThreadCaps(threadId: string, caps: ThreadCaps): void;
  /** Called only by the code slice after its native loosening dialog. */
  approveThreadCaps(threadId: string, caps: ThreadCaps): void;
  /** Persisted spend, including unflushed agent spend. */
  threadSpend(threadId: string, turnId?: string | null): { turnUsd: number; threadUsd: number };
}
```

### 13.3 Main ↔ host protocol (`src/harness/protocol.ts`; not a renderer contract)

```ts
export const HARNESS_PROTOCOL = 1;
export type HarnessCommand =
  | { op: 'project.add'; project: CodeProject } | { op: 'project.update'; project: CodeProject } | { op: 'project.remove'; projectId: string; removeWorktrees: boolean }
  | { op: 'thread.create'; projectId: string; init: Parameters<CodeApi['createThread']>[1] } | { op: 'thread.update'; threadId: string; patch: Parameters<CodeApi['updateThread']>[1] }
  | { op: 'thread.archive'; threadId: string; removeWorktree: boolean; deleteBranch: boolean } | { op: 'thread.delete'; threadId: string }
  | { op: 'run.send'; threadId: string; text: string } | { op: 'run.steer'; threadId: string; text: string }
  | { op: 'run.interrupt'; threadId: string } | { op: 'run.resume'; threadId: string }
  | { op: 'query'; name: 'threads' | 'thread' | 'timeline' | 'diff' | 'fileDiff' | 'rules' | 'mcp' | 'spill' | 'approvals'; args: unknown }
  | { op: 'git'; name: 'discard' | 'restore' | 'commit' | 'merge' | 'exportPatch'; args: unknown }
  | { op: 'rules.delete'; ruleId: string } | { op: 'mcp.upsert' | 'mcp.remove'; args: unknown } | { op: 'sandbox.selftest' };

export type MainToHost =
  | { t: 'init'; protocol: 1; dataDir: string; installId: string; settings: unknown; platform: NodeJS.Platform }
  | { t: 'cmd'; id: string; cmd: HarnessCommand }
  | { t: 'gw.events'; reqId: string; events: GatewayEvent[] }           // batched per request every 16–40 ms
  | { t: 'rpc.result'; id: string; ok: true; data: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: GmiErrorShape }
  | { t: 'approval.decision'; requestId: string; decision: ApprovalDecision }
  | { t: 'ping'; at: number }
  | { t: 'shutdown'; graceMs: number };

export type HostRpc =
  | { method: 'mcp.gmi.call'; params: { tool: GmiToolName; args: Record<string, unknown>; requestId: string | null } } // paid tools: main checks its one-shot token for requestId
  | { method: 'mcp.oauth.token'; params: { serverId: string } }
  | { method: 'secrets.mcpEnv'; params: { serverId: string } }
  | { method: 'compute.call'; params: { grantId: string; op: string; args: unknown; toolCallId: string } } // main derives the Idempotency-Key
  // No 'loosen' kind and no free text: main builds the dialog from validated fields, strips control, bidi and
  // zero-width characters, and caps lengths (command 2 KiB, ≤ 20 paths × 256 characters).
  | { method: 'dialog.confirm'; params: { kind: 'trust' | 'destructive' | 'sensitive_write'; subject: { tool: string; command?: string; cwd?: string; paths?: string[]; risk: RiskFlag[] } } };

export type HostToMain =
  | { t: 'ready'; protocol: 1; version: string; sandbox: CodeState['sandbox']; git: CodeState['git']; ripgrep: boolean }
  | { t: 'cmd.result'; id: string; ok: true; data: unknown }
  | { t: 'cmd.result'; id: string; ok: false; error: GmiErrorShape }
  | { t: 'gw.request'; reqId: string; req: GatewayRequest }
  | { t: 'gw.cancel'; reqId: string }
  | { t: 'rpc'; id: string; call: HostRpc }
  | { t: 'event'; event: CodeThreadEvent }
  | { t: 'threads'; threads: CodeThreadSummary[] }
  | { t: 'approval.request'; request: ApprovalRequest }
  | { t: 'approval.withdrawn'; requestId: string }
  | { t: 'run.ended'; threadId: string; runId: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; message: string; meta?: Record<string, unknown> }
  | { t: 'pong'; at: number; phase: 'starting' | 'migrating' | 'recovering' | 'ready' };
```

Main validates each `HostToMain` message with zod. A `gw.request` gets the full main-side checks (§4.4):
- purpose in `agent | subagent | compaction | title | commit_message`, priority at most `foreground`, and a scope whose
  thread, turn and run main tracks as running (refused after an interrupt);
- the model allowlist and ≤ 128 tools;
- size caps: ≤ 4 MiB and ≤ 2,048 messages. A refusal is reported as `context_overflow`, so compaction layer 2 handles
  it (§7.5);
- main's own estimate, reservation and thread caps (persisted).
`dialog.confirm` from the host is **only** for decisions that tighten or ask; loosening is always started by the user
through CodeApi and decided by `isLoosening` (§9.4).

---

## 14. Modules and file layout

| Area | Files |
|---|---|
| Gateway (main) | `src/main/services/gateway/{index.ts, types.ts, gateway.ts, capabilities.ts, messages.ts, body-chat.ts, body-responses.ts, body-router.ts, parsers/{common,chat,responses,router,think}.ts, meter.ts, estimate.ts, reservations.ts, threads.ts (persisted thread ledger + agent SpendSource), scheduler.ts, retry.ts, breaker.ts, connectivity.ts, trace.ts, status.ts, mock.ts, probes.ts (dev-only)}` |
| Harness bridge (main) | `src/main/services/harness/{index.ts, supervisor.ts, bridge.ts (zod schemas, rpc router), approvals.ts (broker, one-shot tokens, structured native dialogs), readonly-db.ts (view-only fallback), mcp-bridge.ts (GMI MCP proxy with token enforcement, OAuth tokens, env secrets), env.ts (spawn env allowlist)}` |
| Code slice (main) | `src/main/services/code/{index.ts, types.ts, api.ts (CodeApi → host), projects.ts (picker, validation), trust.ts (trusted snapshot), loosen.ts (isLoosening), caps.ts (thread caps → gateway)}` |
| Shared | `src/shared/lib/git-safe.ts` (argv and env builder for every host git call, used by the host and by main's project checks) |
| Registration | `src/main/slices/{gateway,harness,code}.ts` (stubs from F0, filled by H1-0, H2-0, H3-0) |
| Host | `src/harness/{host.ts, worker.ts, protocol.ts, types.ts, gateway-client.ts, store/*, loop/{runner,batch,context,tokens,caps,doom,prompts,compaction,summary-prompt,side-tasks,steer}.ts, tools/{registry,fs,edit,patch,grep,glob,list,output,todo,question,task,web,shell}.ts, sandbox/{paths,bwrap,profiles,netproxy,forwarder,seatbelt,runner,env,selftest}.ts, perm/{engine,modes,command,flags,rules}.ts, mcp/{manager,stdio,http,gmi,trust,tool-search,sandbox}.ts, git/{worktrees,checkpoints,objects,diff,refguard,locks,recover,sensitive}.ts, runtime/{adapter,native}.ts}` |
| Prompts | `src/harness/loop/prompts/system-v1.md`, `summary-v1.md`, `continuation.md`, `max-steps.md` (bundled as strings; the version is part of the prefix hash) |
| Renderer | `src/renderer/pages/code/{index.tsx, ThreadList.tsx, ThreadRow.tsx, Timeline.tsx, items/*.tsx, Composer.tsx, Meter.tsx, ModeSelect.tsx, RightPanel.tsx, hooks.ts, stream-apply.ts}`, `pages/code/review/*`, `pages/code/approvals/*`, `pages/code/settings/*`, `pages/usage/GatewayCard.tsx` |
| Build (F0) | `scripts/build-electron.mjs` gains the entry `src/harness/host.ts` → `dist-electron/harness.cjs` (platform node, `electron` external) and the proxy forwarder asset; `tsconfig.node.json` includes `src/harness`; `vitest.config.ts` alias `@harness` |

---

## 15. Mock mode and fixtures

- **Gateway mock** (`services/gateway/mock.ts`, when `ctx.mock`). A scripted "mock model" that:
  - replays chat fixtures for chat (as today);
  - for agent purposes, emits deterministic tool-call sequences chosen by keywords in the last user message
    ("fix the failing test" → `read`, `grep`, `edit`, `bash npm test`, final answer);
  - produces realistic usage (cached ratio rising after step 1), so meters and costs look real.
- **Demo project:** on first mock start, main creates `<mockUserData>/demo-repo` (git init; a tiny TypeScript project
  with one failing test) and registers it as a trusted project.
  - Mock threads (`fixtures/code/demo-threads.json`) are imported into the mock DB, with fixed ids
    `c0de0000-0000-4000-8000-00000000000{1..4}` for screenshots.
- **`GMI_DESK_MOCK_CODE=<flags>`** (mock only; in `DEV_ENV_VARS`): `approval_pending`, `awaiting_user`, `doom_loop`,
  `overflow`, `rate_limited`, `queued`, `queued_budget`, `offline`, `sandbox_unavailable`, `no_proxy`, `host_crash`,
  `view_only`, `mcp_changed`, `mcp_unpinned`, `budget_cap`, `git_tampered`, `execution_sensitive`, `economy_disabled`.
- **Shell in mock:** the real sandbox runner on the demo repo when bwrap works, otherwise a fake runner with canned
  outputs, so screenshots are deterministic either way.
- **Screenshot pages:** `code`, `code?thread=<id>`, `code?thread=<id>&panel=changes`, `code?thread=<id>&review=1`,
  `code?approvals=1`, `settings?section=code`; both themes.

---

## 16. Tests, including the eval harness

**Unit and integration tests** (vitest, Node environment; `test/gateway/**`, `test/harness/**`, `test/code/**`)

- **Gateway:**
  - golden request bodies per route and family, including chat parity;
  - parser cases: tool-call delta assembly, Responses function calls, cache-write usage, stream errors;
  - the meter: cached, tiers, write, discount, estimated; the prompt charged on a 2xx without output; maybe-billed
    attempts;
  - reservations: the worst case from main's own estimate (the protocol has no host-supplied counts); **10 parallel
    cache-miss requests near a cap never exceed it**; check-and-insert with no interleaving; `queued(budget)` versus
    refusal; release in `finally`; no time expiry; the display estimate from the common prefix (after compaction, at a
    new user turn, after a TTL gap → 0);
  - the persisted thread ledger: restart main with the same file and the remaining thread budget is unchanged; host
    caps only tighten; per-turn ledger rows and the `SpendSource` never count the same spend twice;
  - host-port validation: wrong purpose, `interactive` priority, unknown or interrupted scope → refused; killing a fake
    host mid-stream aborts the fetch, charges the ledger and brings outstanding reservations to 0;
  - the scheduler with a fake clock: TPM window, AIMD on 429, priorities, DRR fairness, aging, head-of-line (a large
    request is not starved by a stream of small ones), per-model and per-thread caps;
  - the retry matrix: not-billed requeue; a 429 is never surfaced before 10 minutes; maybe-billed charge and one retry
    (none above 32k); the first-byte watchdog scaling; the breaker counting only 5xx and timeouts; the offline gate (no
    breaker opens while offline; resume after the probe);
  - defaults: for GLM-5.3 and DeepSeek-V4-Flash at `CODE_DEFAULTS`, the ceiling is ≤ 160k and a cache-cold step at the
    ceiling fits the per-turn cap.
- **Host protocol:** zod rejects malformed, oversized and unknown messages; command receipts make commands idempotent;
  supervisor restart and crash-loop behaviour (fake utilityProcess); the watchdog is armed only after `ready`; a host
  that writes 10 MB to stderr never blocks; quarantine after two recovery crashes; the view-only fallback serves
  threads while `crashed`.
- **Loop**, with a scripted fake gateway: every invariant (§6.1) after stream cuts, 429s, overflow, invalid JSON, tool
  hangs, cancel mid-tool and a host crash (process killed between `tool.started` and `tool.finished` → synthetic
  result on replay); caps (the wall clock pauses while awaiting approval); steering placement; continuation on
  `length`; and:
  - mixed batches: `[read X, edit X, read X]` returns the old, then the new content; `task` and `question` are
    barriers;
  - unpaired calls: a step-cap answer with tool calls, a cut stream with incomplete deltas (re-issued, never stored),
    and `length` inside arguments (no invalid-JSON budget used) all leave every stored call paired;
  - ids: two threads and two turns whose provider emits identical ids (`call_0`) → no primary-key conflict, distinct
    spill files and idempotency keys, byte-stable stored history;
  - contexts: a subagent's reads and messages never reach the parent; one `general` subagent at a time;
  - doom signals, including the golden 30-step empty-content tool loop that trips none;
  - `thread_seq` stays contiguous with two interleaved threads; deltas are never persisted.
- **Prefix stability (golden):**
  - serialise the context for a fixed thread across 10 steps and assert that `[system]+[tools]+[user#0]` is
    byte-identical and history only appends;
  - snapshot files `test/harness/golden/prefix-v1/*.txt`. A prompt change must bump the prompt version and update the
    snapshot on purpose.
- **Compaction:** thresholds; the message-count and cost triggers; the economy formula (Qwen3-Coder at the 32k and
  128k tiers, MiniMax-M3 at 512k; disabled where too small); anchor selection never between a call and its result;
  the pinned current-turn block byte-identical after compaction inside a 50-step turn; precompute swap conditions;
  hysteresis; layer-2 shrink levels (also for main's size refusals); the range ledger; the file ledger.
- **Tools and path policy:**
  - `..`, symlink escapes (inside → outside, chained, swapped after the check via `O_NOFOLLOW`), hard links, case
    folding on darwin, the deny list, the execution-sensitive list;
  - edit staleness; apply_patch in both formats with path checks; output truncation and spill;
  - read dedupe by range: paging a 9k-line file shows every page; three chained edits need no re-read; a formatter
    run through bash invalidates the row;
  - host-side rg with `--pre=sh` as the pattern, the glob and the path never runs anything.
- **Sandbox:** bwrap argv snapshot tests; the self-test uses the production builder. **Live tests run when bwrap is
  available** (as on this machine; skipped elsewhere):
  - writing outside the worktree fails; `$HOME` is empty except toolchains and caches; `cat .env` reads `/dev/null`;
  - `connect()` to every socket path in the host's `/proc/net/unix` fails, and so does `docker version`;
  - without a network approval `curl` fails; with one, the proxy reaches a public test host but refuses 127.0.0.1, an
    RFC 1918 address, 169.254.169.254 and an IPv6 ULA (unit tests use a fake resolver);
  - git: rewriting `<worktree>/.git`, `gitdir` or `commondir` fails; `rm -rf <common>/objects`, `git branch -f main`
    and `git worktree prune` fail; `git worktree prune` in thread A leaves thread B working; a commit on the thread's
    own branch works, and its objects are imported and verified;
  - a planted `~/.bash_profile` is not sourced (fresh HOME per command, `--noprofile --norc`);
  - the `readonly` profile cannot write anywhere;
  - `/run/user/$UID/bus` is absent; killing the parent kills the children; env has no `*_KEY`.
- **Permissions:** a table-driven engine (≈ 80 cases): modes × tools × patterns × hard denies × project-file rules
  that cannot add allows; the command lexer (compound and destructive detection); the flag rules (`rg --pre`,
  `--pre-glob`, `git -c`, `--output`, `--ext-diff`, `git branch -D/-f/-m main`, `find -fprint/-fls/-execdir/-ok`,
  `tree -o`); `allowedDecisions` (no `allow_thread` or `allow_always` for `costs_money` and `upload_media`); rules
  broader than `suggestedRule` and wildcard tools refused without a native dialog.
- **Git:**
  - temp repos; worktree create (locked) and archive (no blanket prune); a crash during `setting_up` → rollback; stale
    lock files of ours removed, others reported;
  - **the SC-1 proof of concept:** a redirected `.git` file with a `filter.x.clean` driver and a `.gitattributes`
    selecting it → the host's checkpoint, diff, apply and ref-guard calls refuse (pointer mismatch) and nothing runs;
    the same with `diff.external`, `core.pager` and `textconv`;
  - pathspec magic (`:(top)`, `:/`, `*`) is literal in discard and diff;
  - checkpoints: a turn that changes files only through bash is restorable; restore keeps ignored files and removes new
    tracked files; the user's index is never touched; an unchanged 50k-file worktree checkpoints in < 2 s;
  - the ref guard detects a moved ref, also after a host crash (`ref_snapshots`); the safe git flags defeat a
    malicious `core.fsmonitor` in the repo config.
- **MCP:** an in-process fake server (SDK in-memory transport); stdio through the fake runner; trust hash changes;
  tool-description pin changes; an unpinned `npx` server is flagged; the deferred `tool_search`; timeouts; the GMI MCP
  policy (free reads auto-allowed; a paid tool call without main's one-shot token, or with different arguments, is
  refused in `mcp-bridge.ts`); OAuth token RPC.
- **Renderer:** react-dom/server markup tests for the thread list, timeline items, approval card, meter and review;
  `stream-apply` (thread_seq gaps → refetch; ephemeral deltas by offset; no refetch with interleaved threads).

**Eval harness** (`test/eval/`, `scripts/eval.mjs`)

- **Tasks:** about 20 small, self-contained repos in `test/eval/tasks/<id>/`: fix a failing test, rename a symbol
  across files, add a function + test, a config change, an explain-only question, a multi-file refactor, a bug needing
  a grep, a long-output trap, a doom-loop trap. Each has `task.json` (prompt, mode, caps) and `grade.mjs` (runs the
  tests inside the sandbox runner, checks diff constraints).
- **Determinism.** In eval mode the host injects a fixed clock, a fixed `<environment>` block (worktree
  `/work/<task>`, fixed tool flags and sandbox mode) and a fixed budget line, so requests do not depend on the day or
  the machine.
- **Cassettes:** `test/eval/cassettes/<task>/<model>.jsonl`. Each line is `{reqHash, events: GatewayEvent[],
  toolResults}`, recorded **at the gateway boundary** after normalisation, with request ids and org ids sanitised. Tool
  results are recorded as well.
  - `reqHash` = sha256 of the canonical `{messages, tools, target}` after normalising temp paths and durations.
    `requestId`, `scope`, `prefixHash` and every estimate or cache field are excluded.
- **Replay** (in `npm test`, deterministic and free): a fake gateway serves the cassette and the recorded tool results
  are replayed. A mismatch prints a structural diff (message index and field). That catches prefix-stability and prompt
  regressions as well as behaviour changes. A separate **live-tools** mode runs the real tools, for grading only.
- **Record / live eval** (paid; user only) runs **inside the app**: a dev-only Diagnostics action "Record eval"
  (budget-capped, confirmed in a native dialog) reads `test/eval/tasks`, drives the gateway in main and writes the
  cassettes and a report: success, steps, prompt / cached / output tokens, cache-hit %, $ per task, wall time.
  `scripts/eval.mjs` only prepares inputs and reads outputs. The real profile never gets a listening socket or a debug
  port for this (ground rules 3 and 9).
- **Default-model choice (DH9)** comes from this report.

---

## 17. Failure modes and recovery

| Failure | Detection | Recovery / user sees |
|---|---|---|
| Host crash or hang | exit / no pong for 15 s after `ready` | Main aborts the host's upstream requests (`abortOwner`), settles them and releases their reservations; restart with backoff; runs → `interrupted`, synthetic results; "Continue" per thread; crash loop → banner and the view-only fallback; a thread that crashes recovery twice is quarantined |
| Slow host start (large migration) | startup budget (5 min) with heartbeats | Progress shown; no kill while heartbeats arrive |
| Main crash | — | The host dies with the parent (utilityProcess). On relaunch the log replays as above, and thread spend reloads from `gateway-threads.json`. |
| SQLite corrupt or locked | open/integrity error | Main opens the file read-only (a view-only Code tab) with a banner; offer "Restore backup <v>"; never delete. |
| Gateway 429 storm | AIMD | Requests requeue and are not surfaced for 10 minutes; effective TPM shrinks; the UI shows `queued(tpm)`, positions and ETA; threads keep running. |
| Offline or sleep | DNS/connect failures, `net.isOnline()`, `powerMonitor` | Connectivity gate: "Offline", nothing admitted, no breaker opens, no retry budget used; resumes after one probe. |
| Model outage | breaker `open` (5xx, timeouts) | Agent threads wait in `queued(breaker)`; chat fails fast with "Try anyway"; suggest switching the model (next turn). |
| Maybe-billed failure (5xx, first-byte timeout) | status | Estimated prompt charge; at most one retry (none above 32k tokens); then `stopped` with "Continue". |
| Overflow despite compaction | `context_overflow` after layer 2 | `stopped(overflow)` + "New thread from summary". |
| `length` twice | finish reason | `stopped(output_limit)` with a hint to raise `maxOutputTokens` or split the work. |
| Invalid tool calls | parser | Error results (≤ 2 per step) → `stopped(model_error)` with the model's last text. |
| Doom loop | §6.4 | `awaiting_user` with options. |
| Budget/cap reached mid-turn | reservation refused on actual spend | `stopped(cost_cap\|budget)` + summary from the log; "Raise cap" (native confirmation). Waiting only on other reservations → `queued(budget)`. |
| Tool timeout | timer | Process group killed; `timeout` result; the loop continues. |
| bwrap missing or broken | self-test with the production argv | `sandbox_unavailable` notice; every shell command asks; auto modes off. |
| Network proxy cannot start | self-test | Network approvals per command only, with the `local_network` flag. |
| MCP server dies | transport close | Its tools return errors "server stopped"; restart with backoff (3); the state shows `error`. |
| MCP description or package version changed | pin mismatch / resolved version | Tool or server hidden + re-trust (`changed_tool`, `unpinned`). |
| Worktree removed externally | fs check before each run | `failed` with "Recreate worktree from branch" or "Archive". |
| Setup interrupted (crash in `creating` or `setting_up`) | host start | Reconcile with `git worktree list --porcelain`: continue or roll back; "Re-run setup" / "Retry". |
| Stale git lock | `*.lock` with no git process of ours | Removed (in our paths) or reported (elsewhere). |
| Git metadata tampered | pointer files differ from the record | git-safe refuses; `git_tampered` notice; nothing runs. |
| A command changed an execution-sensitive file | hashes before and after the run | `execution_sensitive` notice + review entry; listed in the merge dialog. |
| Ref moved | ref guard (persisted snapshot) | Warning notice + "Restore ref". |
| Merge conflict | git exit code | `git merge --abort`; explain; offer "Ask the agent to rebase in its worktree". |
| Renderer reload mid-run | — | Runs continue in the host; the renderer re-subscribes and pages the timeline from `lastSeq` (thread_seq). |
| Usage chunk missing | no usage | Estimated, flagged `estimated`; the prompt is charged whenever a 2xx arrived. |

---

## 18. Security model and threat model

### 18.1 Trust levels

| Component | Trust | Holds |
|---|---|---|
| Main | trusted | inference key / OAuth tokens, compute key, MCP OAuth tokens, budgets, native dialogs |
| Renderer | untrusted for authority (it renders model output) | nothing secret; it can request, never loosen |
| Harness host | semi-trusted: our code, but it handles untrusted data | no GMI credentials; short-lived MCP access tokens in memory; declared MCP env at spawn |
| Sandboxed processes (bash, stdio MCP) | untrusted (model- or third-party-controlled) | the worktree (rw), this thread's worktree metadata, branch refs and object dir (rw), the rest of the git metadata and toolchains (ro), a fresh HOME plus thread caches |
| Model output, files, web pages, MCP results | untrusted data, assumed hostile (prompt injection) | — |

### 18.2 Threats → mitigations

| # | Threat | Mitigations | Residual |
|---|---|---|---|
| H-T1 | **Prompt injection via files, web or MCP** makes the agent misbehave | Outputs are data; no tool output can change permissions or modes; loosening only through user-started native dialogs (`isLoosening`); a project's own files cannot pre-approve (project rules add denies only); instructions and MCP config come from the trusted snapshot; web and MCP output wrapped and labelled; tool-description pinning; `auto` and `full-access` are opt-in with native dialogs; network off by default | Within an approved scope (e.g. `auto`), injected instructions can still make bad edits in the worktree → checkpoints, review, ref guard |
| H-T2 | **Secret exfiltration** (GMI keys, SSH keys, `.env`, cloud creds) | GMI credentials never in the host or sandboxes (env scrubbed at both spawns); allowlisted root (`$HOME`, `/run`, `/var`, `/srv`, `/opt` not mounted); `.env*` and key files masked with `/dev/null` binds and hard-denied for the fs tools; network only through the proxy and only when approved; web fetch and the proxy block private IPs; assistant Markdown never auto-loads images (D11); links open after a confirmation showing the full URL; `sandbox_upload_tree` excludes `.git`, ignored files and secrets; agent sandboxes default to deny-all egress | With network approved, a command can send readable worktree contents to a public host → approvals show the command; persistent network grants need a native dialog. An allowed upload-capable host can receive the uploaded tree (H4) |
| H-T3 | **Destructive commands** | Sandbox: only the worktree, this thread's worktree metadata, its own branch refs and its own object dir are writable; the shared object store, other refs, other threads and the user's index are read-only; checkpoints live in a snapshot repo no sandbox mounts; the destructive class always asks; ref guard (persisted) + restore | Deleting untracked, ignored files in the worktree (e.g. `.env` is masked, but `data/` is not) → ignored files are not checkpointed (documented) |
| H-T4 | **Path traversal and symlinks** | §8.2: realpath containment, `O_NOFOLLOW` on the final component, temp file + rename, hard-link `nlink` check, case folding, NUL/`~` rejection; apply_patch targets checked; spill reads limited to the thread | A TOCTOU race on intermediate directories by a concurrent sandboxed process of the same thread → mitigated by the worktree mutation lock |
| H-T5 | **Worktree escape and host code execution through git metadata** | bwrap mounts (§8.3): the `.git` pointer, `gitdir`, `commondir` and `config.worktree` read-only, `.git/hooks` and config read-only; every host git call through git-safe with paths from the record, pointer verification, global/system config and attributes off for checkpoint/diff/apply/ref guard, and no filters, textconv, external diff, pager, signing or credential helpers; repo-local exec-capable keys added after trust need a native dialog before commit or merge; execution-sensitive files read-only and hashed; worktree dir validated (not root, not home, not userData) | Commit and merge keep the user's own global config by design (LFS, signing); in-tree `.gitattributes` can select filter drivers defined there |
| H-T6 | **MCP server trust** | Never auto-start project servers; native trust dialog with exact commands; config-hash re-trust; package versions pinned or flagged `unpinned` and re-trusted on change; stdio in the `exec` profile (no host sockets, proxy-only network, only if declared); secrets from main per server; OAuth in main; per-tool policies; third-party tools never auto-allowed by hints; output size caps; description pinning | A trusted server is still arbitrary code with what it declared (network + its secrets) |
| H-T7 | **Compromised renderer** (XSS through Markdown, a malicious model output) | Cannot reach the host or keys; can only call CodeApi. One `isLoosening()` in main covers mode, network, webFetch, computerId, window, caps, MCP enable/allow and approval decisions; main fills `allowedDecisions`; allow rules must name the exact tool with a pattern no broader than suggested; every loosening, merge, trust or MCP add shows a native dialog | A renderer could click "Allow once" on pending requests → those are already scoped requests; high-risk kinds (unsandboxed, destructive, `costs_money`) use the native dialog |
| H-T8 | **Runaway cost** | Main-computed worst-case reservations at admission (no host numbers), synchronous check-and-insert; persisted thread spend and caps (tighten-only from the host); the 160k default window and the compaction cost trigger; scheduler; doom-loop guard; subagent and side-task caps; paid GMI MCP and sandbox tools only with one-shot tokens, a native dialog and a thread reservation; maybe-billed attempts charged; no paid cache warming; compaction cost metered | Within caps, by design; estimated charges may differ from GMI's bill (flagged `estimated`) |
| H-T9 | **SSRF / local network attacks** via web fetch, shell network or previews | IP checks after DNS in `lookup`, shared by web fetch and the shell proxy; the sandbox never shares the host network namespace; https only for web fetch; redirects re-validated; previews block private IPs (compute.md) | IPv6 edge cases → table-driven tests; the per-command `--share-net` fallback when the proxy cannot start (flagged `local_network`) |
| H-T10 | **Loopback gateway abuse** (when built) | Random port, per-runtime bearer, Host check, `Origin` rejected, body cap, model allowlist, revoked at exit | Same-user malware could read the bearer from the runtime's memory (out of scope) |
| H-T11 | **Supply chain** | No new runtime dependencies; pinned versions; external runtimes pinned, never self-updating | `@modelcontextprotocol/sdk` transitive dependencies (express, hono) are unused server code → bundling leaves out what is not imported |
| H-T12 | **Data at rest** (transcripts with code or secrets) | 0700/0600 permissions; no prompts or outputs in logs; delete thread removes rows, spills and snapshot refs; export only on request | Not encrypted (same as chat); option later |
| H-T13 | **Log leakage** | Structured logs carry ids, counts and codes; the logger redacts bearer, JWT and key names; the trace mode is dev-only, passes the gateway sanitiser and the logger's key-name `sanitize()`, and is stripped when packaged | — |
| H-T14 | **Host Unix sockets and local services** reached from the sandbox (Docker → root, system D-Bus, databases, the Vite server, Ollama, the app's loopback listeners) | Allowlisted root; `/run`, `/var/run`, `/tmp` and `$HOME` are fresh tmpfs; network namespace always unshared; the proxy refuses loopback and private ranges; live tests connect to every host socket and run `docker version` | A socket created inside the worktree itself is reachable (rare; it belongs to the project) |
| H-T15 | **Persistent injection through repo files** (AGENTS.md, `.mcp.json`, hooks, `.envrc`) | Instructions, MCP config and permission files read only from the trusted snapshot; instruction and execution-sensitive files read-only in the sandbox; hashes before and after every run; changes in the project root need re-trust; the merge dialog lists execution-sensitive changes | The user re-trusts or merges a poisoned file |
| H-T16 | **Option and pathspec injection** into host tools (rg, git) | Fixed argv builders (`-e`, `-g`, `--`), `--no-config`, `RIPGREP_CONFIG_PATH` removed, `GIT_LITERAL_PATHSPECS=1`, paths checked against the diff list, positional values starting with `-` rejected | — |
| H-T17 | **Spoofed native dialogs** (model-written commands with newlines or bidi overrides) | Main builds dialog text from structured, validated fields; control, bidi and zero-width characters stripped; lengths capped; no host-built free text | — |

---

## 19. Cost model

**Formula per step:**
`((P − C)·in + C·read + O·out) × (1 − discount)`, where `P` = prompt tokens, `C` = cached tokens and `O` = output
tokens. Prices are list $/M `[V: RH §1.3]`.

| Scenario (list prices, before the org discount) | Cost |
|---|---|
| GLM-5.3, 60k prompt, 90 % cached, 1k out, one step | 6k×1.40 + 54k×0.26 + 1k×4.40 = **$0.027** (uncached: $0.088) |
| GLM-5.3 step at the **old** 1M-window ceiling (~743k prompt) | 743k×0.26 ≈ **$0.19** fully cached; 743k×1.40 ≈ **$1.04** cold, above the $1 turn cap |
| GLM-5.3 step at the **160k default** ceiling (~120k prompt, 1k out) | 120k×0.26 + 1k×4.40 ≈ **$0.036** cached; 120k×1.40 ≈ $0.17 cold |
| Worst-case reservation for that step (held only while it runs) | 120k×1.40 + 16,384×4.40 ≈ $0.24 |
| GLM-5.3, 100 steps at 60k prompt, 90 % cache | **$2.24 + output** (vs $8.40 uncached) `[RH]`; at the org's 0.50 discount ≈ $1.12 |
| DeepSeek-V4-Pro, same | $1.83 vs $10.44 uncached `[RH]` |
| Compaction of 200k on DeepSeek-V4-Flash (8k summary) | 200k×0.14 + 8k×0.28 ≈ **$0.030** |
| Compaction on the thread's own model with a cache hit (GLM-5.3) | 200k×0.26 + 8k×4.40 ≈ $0.087 → hence Flash by default |
| Explore subagent (V4-Flash, 15 steps × 20k, 80 % cached, 500 out) | 15×(4k×0.14 + 16k×0.028 + 0.5k×0.28) ≈ **$0.017** |
| Thread title / commit message (GLM-5.3-Flash, 2k in, 60 out) | ≈ $0.0003 |
| Qwen3-Coder at 40k prompt (over 32k ×1.8 tier) vs 31k in economy mode | input rate 1.62 vs 0.90 → economy saves 44 % per step |

- **Defaults:** turn cap $1, thread cap $5, and the app's daily and monthly budgets.
- **TPM:** at T1 (1M TPM), 60k-token steps → about 16 steps/min for the whole org; at the 120k ceiling about 7. The
  scheduler queues; it does not
  fail.

---

## 20. Performance budgets

| Item | Budget |
|---|---|
| Context build per step (200k-token thread) | < 50 ms (token estimates cached per message; prefix cached per thread) |
| Gateway overhead (scheduling + normalisation) | < 5 ms per request, excluding queue wait |
| First token shown after GMI's first byte | < 60 ms (main batches `gw.events` ≤ 16 ms, the host batches deltas 40 ms, main does not batch again) |
| SQLite append (durable event, `synchronous=FULL`) | < 2 ms p95; deltas are not persisted |
| Host memory with 10 active threads | < 300 MB; main unaffected |
| Host cold start + sandbox self-test | < 1 s + < 300 ms |
| Timeline render (1,000 items) | Virtualised; < 16 ms per frame while streaming |
| Diff for 200 files | Stat < 500 ms; per-file hunks lazily |
| Parallel threads | 10+ on T1 without errors (queued) |
| MessagePort payload | ≤ 4 MiB per message. At the 160k default a request is about 0.6 MB; larger ones are refused as `context_overflow` and compacted (§7.5) |
| Host event loop | No synchronous block over 1 s (heavy work in the worker) |
| Checkpoint of an unchanged 50k-file worktree | < 2 s (persistent snapshot index) |
| Object import after a run (≈ 100 new objects) | < 200 ms |

---

## 21. Observability (structured, no secrets)

- **Gateway** (`gateway.request`, info): `{reqId, purpose, priority, threadId, runId, step, model, api, attempt,
  queueMs, ttfbMs, totalMs, promptTokens, cachedTokens, cacheWriteTokens, completionTokens, reasoningTokens, costUsd,
  estimated, status, code, prefixHash8}`. Debug: retry decisions, breaker transitions, AIMD changes.
- **Host** logs are forwarded as `{t:'log'}`; the host sanitises before sending, and main sanitises again:
  - `run.transition {threadId, runId, from, to, reason}`;
  - `tool.finished {tool, status, ms, outBytes, spilled, exit}` (**never** args contents for fs or bash: only the
    tool, a sha8 of the args and the byte counts);
  - `permission.decision {tool, effect, via: rule|mode|user, risk}`;
  - `compaction {before, after, model, ms, costUsd}`;
  - `sandbox.selftest {kind, ok}`;
  - `mcp.state {server, state}`.
- **Never logged:** prompts, completions, reasoning, tool outputs, file contents, commands' full text (only at debug
  level in unpackaged builds), env values, keys, tokens, MCP args.
- **Dev trace** (`GMI_DESK_TRACE=1`, stripped when packaged): request and response bodies of gateway probes go to
  `logs/trace-gateway-*.jsonl`, through the gateway's sanitiser and then the logger's key-name `sanitize()`. Trace files
  written on the real profile are deleted when the live session ends. Probe results are captured this way; eval
  cassettes are written by the in-app record action (§16).
- **Metrics** (in memory → Settings › About › Diagnostics, and `GatewayStatus`): TPM utilisation, queue length, wait
  p50/p95, cache-hit 1 h / 24 h, breaker states, runs by status, approvals pending, tool error rate, host restarts.
- **Run report:** "Copy run report" on a thread gives redacted JSON (steps, usage, tool names and status, notices) for
  bug reports.

---

## 22. Dependencies

**No new runtime dependencies** for H1–H4.

| Need | Choice | Notes |
|---|---|---|
| SQLite | `node:sqlite` (built into Node 24.22 in Electron 45 `[V: RH S7]`) | Behind the `Db` interface; no native rebuild |
| MCP client | `@modelcontextprotocol/sdk` 1.32.2 (present, MIT) | v2 packages (Apache-2.0) later |
| Validation | `zod` 4.6.7 (present) | Protocol schemas |
| Search | system `rg` (present here: 14.1.0) → JS walker fallback | `@vscode/ripgrep` (MIT; 5.7 MB per-platform binary, postinstall download) only if packaging needs it: a separate decision |
| Shell sandbox | system `bwrap` (present here: 0.11.0) / macOS `sandbox-exec` | Detected; never bundled |
| Git | system `git` (2.43 here) | Required; version ≥ 2.38 checked (worktree and restore features) |
| Diff rendering | parse `git diff` output | No `diff` package |
| HTML → text | small in-house extractor | No `turndown` |
| Tokeniser | calibrated estimator | No tokenizer packages (GMI models differ) |

---

## 23. GMI facts still unverified, and the cheapest probe for each

All probes run through the app's **dev-only Diagnostics › "Run inference probes"** action:
- the user must be present (ground rule 9) and must have added an inference key through Connect chat;
- a budget must be set;
- each paid batch is approved in the conversation **and** confirmed in a native dialog;
- `GMI_DESK_TRACE=1` records sanitised bodies;
- results go into `data/gateway-capabilities.json` and test fixtures.

Costs are list prices.

| Id | Unverified | Probe | Cost |
|---|---|---|---|
| H-P1 | Automatic prefix caching on open models; `prompt_tokens_details.cached_tokens` in the final stream chunk; whether `prompt_tokens` includes cached | 2 identical ~2k-token requests to DeepSeek-V4-Flash, `max_tokens` 16 | ≈ **$0.0006** |
| H-P2 | Cache affinity and TTL; does `prompt_cache_key` / `user` help | 6 more of those, at +1, +5 and +15 min, with and without the keys | ≈ $0.002 |
| H-P3 | `context_length_exceeded_behavior:"error"` accepted per default family (GLM-5.3, DeepSeek-V4-Pro/Flash, Kimi-K2.7-code, Qwen3-Coder-480B, MiniMax-M3, GLM-5.3-Flash) | One 200-token request each, `max_tokens` 8 | ≈ $0.002 |
| H-P4 | Overflow error shape and code; real max output per model | The prompt "Reply with exactly: OK" with `stop: ["OK"]` and `max_tokens = contextLength`: expect an immediate 400 when above the model's limit; an accepted request costs a few tokens even if GMI ignores a client disconnect. Binary search on 400 rejections only. The probe's reservation is capped at $0.05 per request, and the native dialog states the worst case if a model ignored both the instruction and `stop` (`max_tokens × output price`, e.g. GLM-5.3 ≈ $4.61) | ≈ $0.001 |
| H-P5 | Tool calling per family: `tool_choice` auto/required/none, `parallel_tool_calls`, `strict`; argument streaming shape | 3 requests per family: one tool call, the result, the final answer (~1.5k tokens) | ≈ $0.02 |
| H-P6 | Reasoning replay rules (DeepSeek, Kimi, GLM): include / omit / empty on tool-loop messages; past turns | Within H-P5, variants per family | ≈ $0.01 |
| H-P7 | `/responses` on `bytedance/seed-2.0-mini` (and a GPT if listed): `store:false`, function calls, `reasoning.encrypted_content` pass-through | 2–3 tiny requests | ≈ $0.002 |
| H-P8 | GMI Router stream usage chunk and `routing_metadata` (STATUS backlog 1) | One Auto reply in `cost` mode | ≈ $0.001 |
| H-P9 | Rate-limit headers (names) and the 429 body / `Retry-After` | Headers from all of the above (names only); a 429 is **not** provoked (it would need about 1M tokens/min) → **ask GMI** | free |
| H-P10 | Do cached tokens and `max_tokens` count toward TPM | **Ask GMI** | — |
| H-P11 | `cache_control` / write billing on kimi-k3.1-pro, Qwen3.8-Max, GPT | Optional; only if one becomes a default: 2 × 2k requests each | ≈ $0.03 |
| H-P12 | The org's TPM tier | Ask the user (console usage tier); otherwise T1 + AIMD | — |
| H-P13 | Tool-loop quality per model (picks the DH9 defaults) | Eval through the in-app Diagnostics › Record eval: ~20 tasks × 3 models, a $6.00 hard cap (≈ $3 after the org's discounts `[I]`) | ≤ **$6** |
| H-P14 | Does GMI stop generating and billing when the client disconnects? | **Ask GMI**. The design does not depend on it: probes self-terminate and reservations are worst case | — |
| H-P15 | Are 5xx responses and timeouts after the body was sent billed? | **Ask GMI**. Until answered, such attempts are charged as estimates (§4.6) | — |

**Total before the eval:** about **$0.04**.

---

## 24. Implementation plan

**Rules:**
- **F0 runs first** (compute.md §21.0). It owns every file that both documents change outside their own slices:
  all contracts (including `gateway.ts` and `code.ts`), `money.ts`, core services, the ledger's kinds and budget
  sources, `durableWriteFile`, the build (harness entry, `ws` externals), `tsconfig.node.json`, `vitest.config.ts`, the
  renderer shell, store and page registry, the Diagnostics action registry, and the registration stubs in
  `src/main/slices/`. After F0, contract files are frozen; additive fixes are collected and applied by the integrator
  at a sync point, never by two slices.
- After F0 the **harness track** (H1 → H2 → H3) and the **compute track** (C1 → C2) run in parallel; they own disjoint
  files. Each phase starts with a phase-0 slice that owns only its internal interfaces and its registration file
  under `src/main/slices/`; phase-0 slices of the two tracks may run at the same time.
- H2 starts after H1, H3 after H2. **H4 starts after H3 and compute C2.**
- Docs (`docs/{STATUS,DECISIONS,ARCHITECTURE}.md`, `AGENTS.md`) are edited only by each phase's integrator step, and the
  integrator steps of the two tracks never run at the same time.
- Each slice owns only the files listed, plus its tests; anything else is requested from the phase-0 owner or the
  integrator. Ownership of a stub passes once, in order, from F0 to the slice named in its row.
- `npm run check` must pass at every slice end; UI slices render screenshots in both themes.
- No commits unless the user asks (AGENTS.md rule 1).

### H1: gateway + chat migration

**Order:** H1-0 → (H1-A ∥ H1-B) → H1-C → H1-D → review → integrator → **H-live-1** (user).

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **H1-0 Gateway interfaces** | `src/main/services/gateway/types.ts`, `src/main/slices/gateway.ts` (F0's stub), `test/gateway/types.test.ts` | Frozen internal interfaces: `Estimator`, `Meter`, `Reservations`, `ThreadLedger`, `RunRegistry`, `Scheduler`, `RetryPolicy`, `Breaker`, `ConnectivityGate`; the gateway registered before chat | `npm run check`; the fakes used by H1-A/B conform to the interfaces |
| **H1-A Gateway core** | `src/main/services/gateway/{index,gateway,capabilities,messages,body-chat,body-responses,body-router,mock}.ts`, `.../parsers/**`, `test/gateway/{bodies,parsers,capabilities,gateway,mock}.test.ts` | §4.1–4.2, §4.7; parsers moved (copied) from chat and extended with tool calls; owner tagging and `abortOwner`; host-port validation; `gw.events` batching | Golden bodies per family; tool-call assembly; parity bodies for chat routes; the mock serves chat fixtures; owner abort; refused purposes, priorities and scopes |
| **H1-B Money + flow** | `src/main/services/gateway/{meter,estimate,reservations,threads,scheduler,retry,breaker,connectivity,trace,status}.ts`, `test/gateway/{meter,estimate,reservations,threads,scheduler,retry,breaker,connectivity,defaults}.test.ts` | §4.3–4.6 | The gateway tests of §16: worst-case reservations; 10 parallel cache-miss requests never exceed; synchronous insert; the persisted ledger across a restart; tighten-only caps; per-turn ledger rows without double counting; head-of-line; `queued(budget)`; the retry matrix with maybe-billed; 429 requeue; the offline gate; breaker counting; the defaults test |
| **H1-C Chat migration** | `src/main/services/chat/**`, `test/chat/**` | §4.8; deletes chat's old `stream-*.ts` and `think-parser.ts` after switching | Every existing chat test passes (adapted to a fake gateway); `context_overflow` UX; `budgetWarning` semantics unchanged; breaker-open fast fail with "Try anyway"; the mock chat works (screenshots `chat?thread=…` unchanged) |
| **H1-D Gateway status UI** | `src/renderer/pages/usage/GatewayCard.tsx` (F0 creates the stub and mounts it), `test/gateway/ui-status.test.tsx` | A card with TPM use, queue, breakers, online state and cache-hit % | Markup test; screenshot `usage` both themes |

**H-live-1 (user; ≈ $0.04).** Inference key added through Connect chat; budget set; with `GMI_DESK_TRACE=1`, H-P1…P9
and one real chat through the migrated slice. Update the capability table and fixtures; the integrator updates
STATUS.md.

### H2: harness core (no Code UI yet; driven by tests and a dev-only Diagnostics runner)

**Order:** H2-0 → (H2-A ∥ H2-B ∥ H2-C ∥ H2-D ∥ H2-E ∥ H2-G) → integration by H2-0 → security review (sandbox, paths,
git, permissions lenses) → fixers → integrator.

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **H2-0 Foundation** | `src/harness/{host.ts (F0's stub entry), worker.ts, protocol.ts, types.ts, gateway-client.ts}`, `src/main/services/harness/**` except `mcp-bridge.ts`, `src/main/slices/harness.ts` (F0's stub), `test/harness/{protocol,supervisor,env}.test.ts` | Process, protocol, supervisor (watchdog after `ready`, stderr drain, quarantine, `abortOwner` on exit), RPC router, approval broker (one-shot tokens, structured dialogs), the view-only DB fallback. Frozen internal interfaces in `types.ts`: `Store`, `ToolRegistry`, `PermissionEngine`, `SandboxRunner` (profiles `exec` and `readonly`), `Compactor`, `GitService` (incl. `sandboxMounts()`, `importObjects()`, `checkpoint()`), `MutationLock`, `Worker` | Protocol zod tests; supervisor restart and crash-loop tests (fake utilityProcess); `harness.cjs` builds; env allowlist test (no `*_KEY` in the child env); stderr flood test |
| **H2-A Store** | `src/harness/store/**`, `test/harness/store/**` | §5.2 schema (thread_seq, context_id, internal tool-call ids, read ranges, partial rows, ref snapshots, trusted files), migrations in the worker, projections, receipts, backup | Migration from an empty DB and from v1 fixtures; WAL + FULL; `thread_seq` contiguous under interleaving; the projection rebuild equals the incremental one; receipts make commands idempotent |
| **H2-B Loop** | `src/harness/loop/{runner,batch,context,tokens,caps,doom,prompts,steer,side-tasks}.ts` + `loop/prompts/**`, `test/harness/loop/**`, `test/harness/golden/**` | §6, §7.1–7.2 | The loop tests of §16; golden prefix |
| **H2-C Compaction** | `src/harness/loop/{compaction,summary-prompt}.ts`, `test/harness/compaction/**` | §7.3 range ledger hooks, §7.4–7.5 | The compaction tests of §16 |
| **H2-D File tools** | `src/harness/tools/{registry,fs,edit,patch,grep,glob,list,output,todo,question}.ts`, `src/harness/sandbox/paths.ts`, `test/harness/tools/**`, `test/harness/paths/**` | §8.1 (non-shell), §8.2 path policy and the fixed rg argv, §8.7 | The path-policy attack suite; read-dedupe ranges; chained edits; both patch formats; spill by internal id; the `--pre=sh` cases |
| **H2-E Shell, sandbox, permissions, web** | `src/harness/sandbox/{bwrap,profiles,netproxy,forwarder,seatbelt,runner,env,selftest}.ts`, `src/harness/perm/**`, `src/harness/tools/{shell,web}.ts`, `test/harness/{sandbox,perm,shell,web}/**` | §8.3–8.5, §9 | The live bwrap tests of §16 (sockets, proxy, git mounts, profiles, fresh HOME); env scrub; the lexer, destructive class and flag rules; the mode table; the SSRF IP table (IPv4/IPv6) shared by web_fetch and the proxy |
| **H2-G Git** | `src/harness/git/**`, `src/shared/lib/git-safe.ts`, `test/harness/git/**` | git-safe; worktrees (`--lock`, per-repo mutex, recovery, stale locks); snapshot-repo checkpoints; object import; diff parser; ref guard (persisted); sensitive-path hashing | The git tests of §16, including the SC-1 proof of concept |

### H3: Code tab

**Order:** H3-0 → (H3-A ∥ H3-B ∥ H3-C ∥ H3-D ∥ H3-E ∥ H3-R ∥ H3-M) → review (4 lenses: security, loop/cost,
GMI integration, UX) → fixers → integrator → **H-live-2** (user).

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **H3-0 Code registration** | `src/main/slices/code.ts` (F0's stub), `src/renderer/pages/registry.code.ts` (F0's stub), `src/main/services/code/types.ts` | The `code` namespace served by the real slice (nav ⌘/Ctrl+6, palette entries, query keys and `useCodeEvents` already come from F0); internal interfaces of the code slice (`ProjectStore`, `TrustService`, `Loosening`) | `npm run check`; screenshot of the page shell |
| **H3-A Code main** | `src/main/services/code/**` except `types.ts`, `test/code/main-*.test.ts` | `CodeApi` (forwarding, projects, trust with the trusted snapshot, `isLoosening` for every path in §9.4, caps → `setThreadCaps` / `approveThreadCaps`, run open and close) | FakePlatform `confirms` asserted for every loosening path of §9.4, merge, trust and MCP add; caps reach the gateway; `allowedDecisions` enforced |
| **H3-B Thread UI** | `src/renderer/pages/code/{index.tsx, ThreadList.tsx, ThreadRow.tsx, Timeline.tsx, items/**, Composer.tsx, Meter.tsx, ModeSelect.tsx, RightPanel.tsx, hooks.ts, stream-apply.ts}`, `test/code/ui-thread*.test.tsx`, `test/code/stream-apply.test.ts` | §12.3 list, timeline, composer, meter | Markup tests per item kind; thread_seq/offset application; screenshots (mock threads) both themes |
| **H3-C Review + approvals UI** | `src/renderer/pages/code/{review/**, approvals/**, settings/**}` (F0 created the `settings/index.tsx` stub), `test/code/ui-review*.test.tsx` | Diff view, actions, approval cards (only `allowedDecisions` shown), the Settings › Code panels | Markup tests; screenshots of review, approval (each risk flag) and settings |
| **H3-D MCP** | `src/harness/mcp/{manager,stdio,http,gmi,trust,tool-search}.ts`, `src/main/services/harness/mcp-bridge.ts`, `test/harness/mcp/**` | §10.1–10.3 (package pinning; one-shot tokens enforced in main) | Fake servers; pins; trust; GMI policy; refused paid calls without a token; OAuth RPC |
| **H3-E Subagents** | `src/harness/tools/task.ts`, `test/harness/subagent/**` | §8.6 (context ids, one `general` at a time, the mutation lock, barrier) | Depth, caps, tools, report size; scheduler priority; context isolation |
| **H3-R Runtime adapter** | `src/harness/runtime/**`, `test/harness/runtime/**` | §11 interface + the native adapter | Contract tests any adapter must pass (reused for OpenCode later) |
| **H3-M Mock + eval** | `src/main/mock/code.ts`, `src/main/mock/fixtures/code/**`, `src/main/dev/eval-record.ts`, `test/eval/**`, `scripts/eval.mjs` | §15; §16 eval harness: deterministic replay in `npm test` and the in-app record action (registered through F0's Diagnostics registry) | Replay passes for the bundled cassettes (synthetic from the mock model until H-live-2); hash normalisation; structural diff on mismatch |

**H-live-2 (user; ≤ $6).** Eval record run on 3 candidate models (H-P13), then DH9 defaults set. Then one real thread
on a scratch repo of the user's choice, end to end: worktree, edits, sandboxed tests, approvals, review, commit.

### H4: sandbox MCP + agent-driven computer (needs compute C2)

| Slice | Owns (exclusive) | Delivers | Acceptance + tests |
|---|---|---|---|
| **H4-A Sandbox MCP** | `src/harness/mcp/sandbox.ts`, `test/harness/mcp/sandbox.test.ts` | §10.4 tools in the host | Idempotency key derived by main (hashed, ≤ 64 ASCII); explicit `execution_timeout_seconds`; upload-tree exclusions (`.git`, ignored files, secrets); output truncation; policies per mode |
| **H4-B Compute broker** | `src/main/services/compute/broker.ts`, `test/compute/broker.test.ts` | Grants and validation; slots through `ExecPort.acquire({priority: 'agent'})` (≤ 6), held until terminal; cancel on interrupt, revoke and run end; in-flight eids persisted through C1-C's `Registry`; one-shot tokens, native dialog and thread reservation for create/resume/extend; the secret-substring check on inputs; audit events; activity → guard during runs | A grant for another resource or an expired grant is refused; no tokens in host messages; a 25 s wait timeout keeps the slot; interrupt sends cancel; a restart cancels persisted eids before granting; create/resume/extend refused without a token |
| **H4-C Renderer** | `src/renderer/pages/code/AttachComputer.tsx`, `src/renderer/components/computer/AgentLane.tsx`, `test/code/ui-attach.test.tsx`, `test/computer/ui-agent-lane.test.tsx` | Attach picker (create a sandbox from a thread = compute's create flow, deny-all egress by default); the Agent lane in the dock | Markup tests; screenshots |
| **H4-D Audit** | read-only review + fix briefs (`.review/h4/`) | A multi-lens adversarial review of H1–H4 (security, cost, loop, GMI); paid end-to-end with the user: an agent sets up a repo in a SMALL sandbox and runs its tests (≈ $0.05) | Findings fixed with regression tests; the integrator updates STATUS.md |

---

## 25. Decisions to record (proposed)

- **D22: GMI gateway in main.**
  - All model traffic, chat included, goes through it.
  - Metering with cached, cache-write and tier pricing; the prompt charged on 2xx; maybe-billed attempts charged as
    estimates.
  - Worst-case reservations computed by main from the body, at admission, released at settle; thread spend and caps
    persisted in main, tighten-only from the host; host requests validated against tracked runs.
  - One TPM scheduler with priorities, fairness and head-of-line; 429s requeue; retries only where GMI cannot have
    billed; breakers on 5xx only; a global offline gate.
  - `context_length_exceeded_behavior: "error"`; Chat Completions by default, Responses with `store: false`.
  - (DH2, DH4–DH6)
- **D23: Own harness in a utilityProcess** rather than OpenCode or Pi, behind a runtime adapter.
  - `node:sqlite` event log (durable events with a contiguous per-thread seq; deltas ephemeral; `synchronous=FULL`).
  - Byte-stable prefix, a 160k default working window and layered compaction (token, message-count and cost triggers;
    the current request pinned).
  - Caps and doom-loop guard; crash replay without automatic resume; heavy work in a worker; view-only fallback.
  - (DH1, DH3, DH7, DH9, DH10)
- **D24: Agent safety.**
  - Permission rules and modes (default auto-accept edits, ask shell); loosening only through native dialogs decided by
    one `isLoosening()`; paid tools only with one-shot tokens minted by main.
  - bubblewrap on an allowlisted root (no host sockets), network only through the app's CONNECT proxy, git metadata
    read-only except per-thread refs, worktree dir and object dir; read-only profile for allowlisted commands; fresh
    HOME per command.
  - Every host git call through git-safe (paths from the record, pointer verification, no filters, pagers, hooks or
    signing); path policy; execution-sensitive files read-only and hashed; instructions from the trusted snapshot.
  - Project files can only add denies. MCP trust with config, description and package-version pinning.
  - (DH8)
- **D25: Code tab.**
  - T3-style projects and threads on locked worktrees under the XDG data dir, branches `gmi/<id6>/<slug>`.
  - Per-turn checkpoints in a separate snapshot repo (DH11).
  - Review / commit / merge flow with native confirmations listing execution-sensitive changes.
  - Per-thread model, caps and meter.
  - The sandbox MCP with scoped grants (H4).

---

## 26. Review log (2026-11-02)

Two adversarial reviews: **SC** = security-cost lens (32 findings), **RL** = reliability-loop lens (34 findings),
numbered in the order they were reported. Each was checked against the research documents, the code and, where it
claimed something about this machine, by reproducing it in a scratch directory (bwrap 0.11.0, git 2.43, rg 14.1.0).
**No finding was rejected.** Five were accepted with a change, stated below. Compute-only findings are logged in
compute.md §23.

| Id | Finding | Verdict | Where |
|---|---|---|---|
| SC-1 | Host git calls can be redirected through the sandbox-writable `.git` file / `gitdir` / `commondir` to an attacker git dir whose filters run on the host | Accepted; **verified** (a `filter.x.clean` driver ran during the host's `add -A` with the old flags; not with `--git-dir` from the record) | §8.2 git-safe, §8.3 mounts, §5.2 `threads`, §16 Git, H-T5 |
| SC-2 | `--ro-bind / /` leaves Docker and system D-Bus sockets connectable | Accepted; **verified** (`connect()` to `/var/run/docker.sock` and `/run/dbus/system_bus_socket` succeeded). Changed: no seccomp `AF_UNIX` filter, because no host socket path is mounted any more and in-sandbox IPC needs Unix sockets; the live test covers it | §8.3, §16 Sandbox, H-T14 |
| SC-3 | "Read-only" allowlist commands can execute or write (`rg --pre`, `git -c`, `--output`, `find -fprint` …) | Accepted; **verified** (`rg --pre` ran a file) | §9.2 (readonly profile + flag rules), §9.3, §16 |
| SC-4 | Host-side rg and git take model-chosen values as options | Accepted | §8.2 fixed argv, §16, H-T16 |
| SC-5 | A writable common dir allows irreversible data loss (objects, reflogs, other threads) | Accepted. Changed for reftable: the git metadata is read-only in the sandbox for every strategy (and `root` is not offered), instead of disabling the auto modes | §8.3, §7.7 snapshot repo, §12.2 branch scheme, H-T3 |
| SC-6 | Paid GMI MCP calls are approved only by the host's engine; "Always" possible; media spend outside thread caps | Accepted | §10.3, §9.4, §13.3 |
| SC-7 | Reservations are not worst case and use host-supplied estimates, purpose and scope; no interrupt check; 15-min expiry | Accepted (merged with RL-4 and RL-6) | §4.4, §4.1, §13.2, §13.3 |
| SC-8 | Approved network shares the host netns (localhost, LAN, metadata IP) | Accepted: an app-run CONNECT proxy with web_fetch's IP checks. pasta and slirp4netns are not used: not guaranteed on users' machines and they do not apply the host policy | §8.3, §8.5, H-T9 |
| SC-9 | The production bwrap argv is invalid while the self-test passes | Accepted; **verified** (exit 1, "--disable-userns requires --unshare-user"; with `--unshare-user` it passes) | §8.3, §16 |
| SC-11 | The renderer can loosen MCP policy, thread settings and approval scope without the native broker | Accepted | §9.4 `isLoosening` and `allowedDecisions`, §13.1, H-T7 |
| SC-12 | Execution-sensitive and instruction files are protected only against fs tools | Accepted | §8.2.6, §7.1, §12.1, §12.3, H-T15 |
| SC-16 | H-P4 could cost `max_tokens × output price` if GMI keeps generating after a disconnect | Accepted | §23 H-P4 and H-P14, §4.4 probe purpose |
| SC-17 | Agent egress allowlist allows exfiltration (GitHub, npm, PyPI uploads) | Accepted (both documents) | §10.4; compute.md §7.1 |
| SC-19 | Dev traces can contain sandbox tokens and data-plane bodies | Accepted (both documents) | §21; compute.md §17 |
| SC-20 | `tool_calls.id` is the provider's id: PK conflicts, idempotency-key reuse | Accepted (merged with RL-8). Changed: the Idempotency-Key is `base32(sha256(grantId:runId:tc_id))[:40]`, because `<grantId>:<id>` can exceed v2's 64-character limit | §5.2, §7.1, §10.4 |
| SC-21 | Retries after 5xx or a timeout are not metered although GMI may bill them | Accepted (merged with RL-20) | §4.3, §4.6 |
| SC-23 | Pathspec magic (`:(top)`, `*`) in discard and diff | Accepted | §8.2, §12.3, §13.1 |
| SC-24 | `npx`/`uvx` MCP servers are not pinned to a version | Accepted | §10.2, §13.1 |
| SC-27 | `bash -lc` with a persistent HOME sources planted profiles | Accepted | §8.3 |
| SC-28 | `dialog.confirm` has a `loosen` kind and host-built free text | Accepted | §13.3, H-T17 |
| SC-29 | Eval record mode would need a socket or debug port into main | Accepted: recording runs inside the app | §16, §23, §24 H3-M |
| SC-30 | Secret check only for equal env values | Accepted (compute.md §6.1); also applied to the H4 broker | §10.4 |
| RL-1 | Compaction tuned to 1M windows: $0.19–1.04 per step, TPM hogging, MessagePort limits | Accepted | DH10, §7.4, §13.1, §19, §20 |
| RL-2 | Economy mode gives a negative ceiling (Qwen3-Coder 32k) | Accepted | §7.4 |
| RL-3 | Thread spend and caps not persisted; null threadId skips caps | Accepted | §4.4, DH4, §13.2 |
| RL-4 | Reservations from host numbers; `C` wrong after compaction, new turns, TTL; async race | Accepted (merged with SC-7) | §4.4, §7.1 |
| RL-5 | The ledger's 20k cap evicts current-month rows; `KINDS` drops `agent`; ownership by a compute slice | Accepted; **verified** in `services/usage/ledger.ts` | §4.3; F0 in compute.md §21.0 |
| RL-6 | A host crash leaves paid streams running; 15-min expiry fires on live requests | Accepted | §4.4, §5.1 |
| RL-7 | Subagents have no context dimension in storage; two `general` subagents can edit at once | Accepted | §5.2, §6.1, §8.6 |
| RL-8 | Tool-call ids repeat across steps, turns and threads | Accepted (merged with SC-20) | §7.1, §5.2 |
| RL-9 | Read dedupe ignores ranges; chained edits force re-reads | Accepted | §7.3, §8.1 |
| RL-10 | "Identical text" doom signal fires on empty-content tool loops; token-based no-success signal | Accepted | §6.4 |
| RL-11 | Per-thread gap detection on a global seq; double batching; unbounded tool output | Accepted | §6.6, §5.2, §13.1, §20 |
| RL-12 | Threads are not isolated in the common dir (prune, root index) | Accepted. Changed: a per-thread object dir (SC-5) instead of a writable `<common>/objects`, which would still allow deleting objects | §8.3, §12.2 |
| RL-14 | The two implementation plans share files without an order | Accepted: one shared F0, registration files per feature, serialised integrators | §24; compute.md §21 |
| RL-15 | Eval replay is not deterministic (dates, paths, estimates in the hash) | Accepted | §16 |
| RL-17 | Exec slots are released before the remote execution ends | Accepted (both documents) | §10.4; compute.md §8.1 |
| RL-18 | A 429 after 3 attempts stops the thread | Accepted | §4.6, §6.2, §17 |
| RL-19 | Large requests starve; reserving before queueing fails threads that could wait | Accepted | §4.4, §4.5 |
| RL-20 | Prompts accepted during a long prefill go uncharged; maybe-billed retries | Accepted (merged with SC-21) | §4.1, §4.3, §4.6 |
| RL-21 | Mixed tool batches have no defined order | Accepted | §6.2 |
| RL-22 | Cap summaries, cut streams and `length` in arguments leave unpaired tool calls | Accepted | §6.1, §6.2, §6.3 |
| RL-23 | The compaction anchor can paraphrase the current request | Accepted | §7.4 |
| RL-24 | Main's 2,048-message cap fails runs that compaction never triggers on | Accepted | §7.4, §4.6, §13.3 |
| RL-25 | Bash-only turns get no checkpoint; an empty temp index re-hashes everything | Accepted. Changed: a persistent index in the snapshot repo instead of copying the worktree's index, which the agent can write and which could misstate content | §7.7 |
| RL-26 | No recovery for half-made worktrees, stale locks, concurrent repo writes, `gc --auto`, lost ref-guard snapshots | Accepted | §5.1, §8.2, §8.4, §12.2 |
| RL-27 | The 15 s watchdog kills long synchronous work; no process serves "read-only mode"; stderr can block | Accepted | §5.1, §17 |
| RL-28 | Going offline opens every breaker and burns retries | Accepted | §4.6 |
| RL-29 | Deltas persisted twice; `synchronous=NORMAL` can lose `tool.started` | Accepted | §5.2, §6.6 |
| RL-34 | The wall-clock cap counts time waiting for approval | Accepted | §6.1, §6.3 |
