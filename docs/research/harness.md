# Coding-agent harness for the Code tab and Agentbox agents (research, 2026-11-02)

Scope: the agent loop that will drive GMI models for (a) T3-style coding threads on git worktrees and (b) agents that
operate Agentbox sandboxes. Compares (A) OpenCode as a sidecar, (B) Pi in-process, (C) our own TypeScript harness,
and gives GMI-specific efficiency, loop-safety, permission, MCP and gateway designs. Agentbox endpoints themselves:
[agentbox.md](agentbox.md). Nothing here was paid for: no inference call, no resource created.

**Legend.** `[V:Sx]` verified against source Sx on 2026-11-02 (or the date given) · `[I]` inferred from verified facts ·
`[U]` unverified / open. Prices are GMI **list** USD per 1M tokens; charged = list × (1 − `discount_to_user`).

| Id | Source |
|---|---|
| S1 | OpenCode source, `github.com/anomalyco/opencode` (the project's current home; `git remote`), branch `dev` @ `bf544cd` (2026-10-31), packages `core`, `server`, `protocol`, `cli`, `ai`, `schema` = v2.2.5 |
| S2 | npm registry (`npm view …`, 2026-11-02) |
| S3 | Pi npm tarballs `@earendil-works/pi-{coding-agent,agent-core,ai,mcp}@1.4.0` (`docs/`, `dist/*.d.ts`, settings defaults) |
| S4 | T3 Code clone `pingdotgg/t3code` @ `9c0fb54` (2026-10-31): `apps/server/src`, `packages/{contracts,provider-core,provider-opencode}` |
| S5 | GMI MCP `get_model` / `search_models kind=llm limit=100` (2026-11-02; prices = list, `discount_to_user` = this org) |
| S6 | GMI docs: `docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference.md` (curl, UA `gmi-client-research/0.1`), `search_docs` hits cited by URL |
| S7 | `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e process.versions` in gmi-desk → Electron 45.2.1, **Node 24.22.1, `node:sqlite` present** |
| S8 | This app: `src/main/services/chat/{stream-common,cost}.ts`, `services/catalog/opencode.ts`, `package.json` |

## 0. TL;DR

1. **Recommendation: (C) our own harness**: loop, tools, compaction, permissions and MCP in an Electron `utilityProcess`,
   model traffic only through a **GMI gateway in main**. Borrow OpenCode's and Pi's *algorithms* (numbers below), not
   their binaries. Keep a runtime-adapter interface (T3-style) so OpenCode can be added later as an optional
   "external runtime" that also goes through the gateway. Weighted score: C 81, B 69, A 59 out of 95 (§6).
2. Caching is the biggest cost lever on GMI: cache reads cost **1–20 % of fresh input**, mostly ~20 % (GLM-5.3 0.26 vs 1.40;
   DeepSeek-V4-Pro 0.145 vs 1.74) [V:S5]. A 100-step session at 60k prompt tokens/step costs about $8.40 → $2.24 on GLM-5.3 and
   $10.44 → $1.83 on DeepSeek-V4-Pro at a 90 % hit rate [I: arithmetic on S5]. Open-model rows have a read price but **no
   write price** → automatic prefix caching is likely [I]; whether GMI reports `prompt_tokens_details.cached_tokens` is
   unconfirmed live [U] (GMI's own `@gmicloud/ai-sdk-provider` types that field: `src/gmicloud-types.ts`, copy from the
   2026-10-31 research run).
3. GMI **silently truncates** over-long prompts by default: `context_length_exceeded_behavior` = `"truncate"` (or
   `"error"`) [V:S6]. A harness must send `"error"`, or compaction never triggers and the model loses context without a signal.
4. Org rate limit is **TPM only** (Tier 1 = 1M TPM; RPM unlimited) [V: docs changelog 06-24-2026]. At 60k tokens/step
   that is about 16 steps/min **for the whole org** → parallel worktree threads need one shared token-bucket scheduler.
5. Price tiers by prompt size exist (Qwen3-Coder-480B ×1.8 above 32k and ×3 above 128k; GPT above 272k; MiniMax-M3 above 512k;
   Grok above 200k) [V:S5] → the compaction ceiling should respect the tier boundary in an "economy" mode.
6. OpenCode 2.x is mature (precomputed compaction, snapshots, MCP + OAuth + elicitation, permissions) but ships as a
   **~253 MB Bun binary per platform**, releases every 1–2 days, and its shell tool **inherits the server's env** [V:S1,S2].
7. Pi is small and hookable (`beforeToolCall`, `transformContext`) but has **no approval system**, defaults to
   **install telemetry on** and **cache warming that sends paid requests** [V:S3].

## 1. GMI facts that shape the harness

### 1.1 Inference API (`https://api.gmi-serving.com/v1`, Bearer `ie_model` key) [V:S6 unless marked]
- `POST /chat/completions` params: `model, messages, tools, max_tokens (default 2000; the docs' "(1-128)" range is
  likely a doc error [U]), temperature, top_p, top_k, ignore_eos, stop (≤4), response_format (json_object only),
  stream, context_length_exceeded_behavior ("truncate" default | "error")`. "Parameter support varies by model";
  `tool_choice: "auto"` shown in model quickstarts (e.g. `/model-quickstarts/text/openai-gpt-5-1-chat#functions`).
- Streaming: SSE, usage in the final chunk with `stream_options.include_usage`; `delta.reasoning_content` [V: RESEARCH.md].
- Error shape (wrapped upstream errors): `{"error":{"message":"Backend request failed with status 400","type":
  "backend_error","code":400,"details":{"error":{"message","type","param","code":"unsupported_parameter"}}}}`, e.g.
  GPT-5.x rejects `max_tokens` → use `max_completion_tokens` (`/model-quickstarts/text/openai-gpt-5-2-chat`).
- `/responses`: GMI recommends it for new projects; required for `*-codex`, `gpt-5.4-pro`, `bytedance/seed-2.0-mini`;
  Codex uses `wire_api = "responses"` against GMI (`/coding-tools/codex`). Whether `previous_response_id`/`store`
  keeps server-side state on GMI: [U]. → The harness speaks Chat Completions by default and Responses only where required.
- No capability flags in the catalog (tools, max output, reasoning format) [V: RESEARCH.md ask #4] → keep a local
  capability table plus probes.

### 1.2 Rate limits [V: `/inference/console-release-notes/06-24-2026-change-log--#3-tier-limit-updates`]
LLM TPM per org by cumulative top-up: T1 $0–50 → 1M · T2 → 3M · T3 $500+ → 50M · T4 $1k+ → 100M · T5 $5k+ → 300M; LLM RPM
unlimited. Whether cached tokens count toward TPM [U]. Agentbox: ≤10 non-terminal executions per sandbox → 429
`Execution.ConcurrencyLimitExceeded` [V: agentbox.md §6].

### 1.3 Coding-relevant models (list $/1M; S5, 2026-11-02)
| Model id | Ctx | In | Cache read | Cache write | Out | Read/in | Org disc. | Notes |
|---|---|---|---|---|---|---|---|---|
| `zai-org/GLM-5.3` | 1,048,576 | 1.40 | 0.26 | 0 | 4.40 | 19 % | 0.50 | strong default [I]; reasoning_content replay [V:RESEARCH] |
| `zai-org/GLM-5.3-Flash` | 1,048,576 | 0.15 | 0.03 | 0 | 0.50 | 20 % | 0.50 | subagents, summaries |
| `deepseek-ai/DeepSeek-V4-Pro` | 1,048,576 | 1.74 | 0.145 | 0 | 3.48 | 8 % | 0.45 | GMI docs: "complex reasoning" pick for Droid |
| `deepseek-ai/DeepSeek-V4-Flash` | 1,048,575 | 0.14 | 0.028 | 0 | 0.28 | 20 % | 0.35 | cheapest long-context summariser |
| `deepseek-ai/DeepSeek-V4.1-Flash` | 1,048,575 | 0.30 | 0.006 | 0 | 1.20 | 2 % | 0.40 | read price near-free |
| `moonshotai/kimi-k2.7-code` | 262,144 | 0.95 | 0.19 | 0 | 4.00 | 20 % | – | coding-tuned; `-highspeed` 1.90/8.00 |
| `moonshotai/kimi-k3.1-pro` | 1,048,576 | 2.00 | 0.20 | 2.00 (1h: 4.00) | 10.00 | 10 % | – | write + 1h-write prices → explicit TTL cache [I] |
| `MiniMaxAI/MiniMax-M3` | 1,048,576 | 0.30 (0.60 >512k) | 0.06 | 0 | 1.20 | 20 % | 0.20 | cheap, tiered |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` | 262,128 | 0.90 / 1.62 >32k / 2.70 >128k | 0.18–0.54 | 0 | 4.50–13.50 | 20 % | – | GMI docs' "best coding quality" pick; tiers punish long prompts |
| `Qwen/Qwen3.8-Max` | 262,144 | 2.00 | 0.25 | 2.50 | 6.00 | 13 % | – | write price → explicit cache [I] |
| `openai/gpt-6.1-sol` | 1,050,000 | 2.00 (4.00 >272k) | 0.10 | 2.50 | 10.00 | 5 % | – | premium; `max_completion_tokens` |
| `XiaomiMiMo/MiMo-V2.5-Pro` | 1,050,000 | 0.435 | 0.004 | 0 | 0.87 | 1 % | 0.30 | very cheap; tool quality [U] |
Read price `"0"` (no cache discount) on Kimi-K2.5, K2-Thinking, Qwen3.5/3.6, Gemini-3.1-Pro, gpt-oss-120b [V:S5].
Tool-calling quality on GMI is untested for all of these [U] → a cheap scripted eval (≈20 tasks × 3 models) before
choosing defaults; needs the user's approval (paid).

### 1.4 Caching behaviour (what is known)
- No GMI doc page on LLM prompt caching found (`search_docs` "prompt caching", "context caching", "cached_tokens":
  only image-model token pricing and Gemini "implicit context caching" capability lists) [V:S6].
- Pattern in S5: open models → read price, write = 0 ⇒ server-side automatic prefix cache, billed at read price [I].
  Proprietary families (GPT, Gemini, Qwen Max, Kimi K3.1 Pro) carry write prices ⇒ provider-side explicit/implicit
  caching passed through [I]; whether `cache_control` blocks are honoured on `/chat/completions` [U].
- Prefix caches are per replica: whether GMI routes a session to the same replica (`prompt_cache_key`, `user`,
  affinity header) [U]. OpenCode sends `prompt_cache_key` only for an allowlist of providers (GMI not on it) [V:S1
  `plugin/provider/prompt-cache-key.ts`].
- This app already parses `prompt_tokens_details.cached_tokens` / `cached_tokens` / `prompt_cache_hit_tokens` [V:S8
  `stream-common.ts:53`] and prices cached tokens at the read price with `overrides` tiers (`cost.ts`
  `pricingForPrompt`, `shared/lib/money.ts` `estimateTokenCostUsd`) [V:S8] → the gateway's metering can reuse both.

### 1.5 Reasoning replay, router, sub-steps
- DeepSeek/Kimi/GLM need `reasoning_content` replayed on assistant tool-call messages inside a tool loop [V: RESEARCH.md].
  Pi exposes a compat flag "all replayed assistant messages must include an empty `reasoning_content`" and
  `requiresThinkingAsText` [V:S3 `compat-schema.js`]; OpenCode 2 maps `compatibility.reasoning_field` [V:S1 `models-dev.ts:268`]
  and fixed "reasoning turned into plain text on model switch → request errors" in 2.2.5 [V:S1 CHANGELOG].
  → Store reasoning per assistant message with the model id; replay only to the same family; on model switch drop it.
- GMI Router ignores tools/max_tokens/temperature [V: D6] → only for tool-less sub-steps (thread titles, commit
  messages); not for compaction (unknown chosen model/context window) [I].
- Cheap sub-steps: titles/commit messages on GLM-5.3-Flash or DeepSeek-V4-Flash; summaries on DeepSeek-V4-Flash. A 200k-token
  summary costs ≈ $0.029 on V4-Flash (uncached) vs ≈ $0.074 on GLM-5.3 even with a cache hit (incl. 5k output) [I: arithmetic].

## 2. Option A — OpenCode 2.x as a sidecar

**Distribution** [V:S2]: npm `@opencode/cli` 2.2.5 (2026-10-30; bins `opencode`, `opencode2`) with 12 per-platform
optional packages; `@opencode/cli-linux-x64` = **252.7 MB unpacked** (Bun `--compile` executable [V:S1 `cli/script/build.ts`]).
1.x line still on `opencode-ai` 1.19.5 (2026-10-28, linux-x64 214 MB). SDK `@opencode/sdk` 2.2.5. MIT. Cadence: 2.2.0
(10-27) → 2.2.5 (10-30); 1.x→2.x replaced the server API (T3 keeps separate 1.x/2.x adapters and a minimum-version probe) [V:S4].

**Server** [V:S1 `cli/src/server-process.ts`, `server/src/auth.ts`, `protocol/src/groups/*`]
- `opencode serve [--hostname] [--port] [--cors <origin>]… [--service | --stdio]`; default bind `127.0.0.1`.
- A password is always required: HTTP Basic user `opencode`, from `OPENCODE_PASSWORD` (overrides 1.x
  `OPENCODE_SERVER_PASSWORD`) or random 32 bytes printed to stdout; pairing sessions = HMAC-signed tokens, 30-day TTL,
  rotate by changing the password; cookie `opencode_session_<port>`.
- `--stdio`: still HTTP on loopback, prints `{"url":…}` JSON on stdout, **exits when stdin closes**, and deletes the
  password env vars so tools do not inherit them. Best fit for a parent-owned sidecar.
- Events: `GET /api/event` SSE (`data: <json>\n\n`), filterable by type; "volatile by contract": a slow consumer
  overflows (4,096-event queue) and the stream fails; events during a disconnect are lost → re-read state after reconnect.
- REST: `/api/session` (list/create/get/delete/update), `/:id/prompt`, `/command`, `/shell`, `/compact`,
  `/interrupt`, `/background`, `/fork`, `/move`, `/revert/{stage,commit}`, `/diff`, `/context`, `/inbox`,
  `/permission` (+ `/:requestID/reply` with `once|always|reject`), `/form` (+ reply), `/environment`; saved
  permissions `/api/permission/saved`; `/openapi.json`.
- Config/env: `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`,
  `OPENCODE_DISABLE_{AUTOUPDATE,MODELS_FETCH,PROJECT_CONFIG,CLAUDE_CODE,CLAUDE_CODE_SKILLS,FILEWATCHER}`,
  `OPENCODE_MODELS_URL|PATH`; data roots from `XDG_{DATA,CONFIG,STATE,CACHE}_HOME` → isolate by pointing all four at
  `<userData>/runtimes/opencode/`.
- T3's integration [V:S4 `provider-opencode/src/server/v2/OpenCode2Server.ts`, `OpenCodeServerOwner.ts`]: one shared
  OpenCode 2 process for all directories, own random password, readiness = `server.info()` within 5 s, version
  probe 10 s, owned server closed after 30 s idle, optional external server URL.

**Loop** [V:S1 `session/runner/{step,llm,max-steps,retry}.ts`]
- Local tool calls **start while the model is still streaming** (each tool-call event forks a fiber); a git snapshot is
  taken per step (separate repo under `<data>/snapshot/<project>/<hash(worktree)>`) for diffs/revert.
- Outcomes: Completed / Retry (before output) / Continue (after partial output, with prompt "The previous response was
  interrupted. Continue … without repeating") / OutputLimit ("hit the output token limit … Break the remaining work into
  smaller pieces") / Compacted (context overflow before any output) / RecoverFull (transport retry-full).
- Unsettled calls get synthetic failures (`tool.result-missing`, "Tool execution interrupted", "The user declined
  this tool call") so history always pairs every call with a result.
- Max steps (agent `steps`): sets `toolChoice: none` and injects `MAX_STEPS_PROMPT` (text-only summary of done/remaining).
- Doom-loop: 1.x had a `doom_loop` permission ("repeated tool calls with identical input"); no detector found in 2.x
  core, only the v1 config migration and UI strings [I: grep of S1].
- Tools: shell (default timeout 2 min), read (2,000 lines / 50 KiB / 2,000 chars per line; media ≤ 20 MiB), write,
  edit, patch, glob, grep, webfetch, websearch, todo, question, skill, subagent (`experimental.subagent_depth`),
  schedule, artifact, image-generate, mcp-resource. A call to `bash` runs as `shell` [V:S1 CHANGELOG 2.2.5].
- Tool output cap: 2,000 lines / 50 KiB; the rest goes to `<data>/tool-output/` (kept 7 days) with marker
  `[showing lines 1-N of M; full output saved to <file>]` [V:S1 `tool-output.ts`].
- Shell env: invocation env falls back to `process.env` plus `AGENT=1`, `OPENCODE=1`, `OPENCODE_SESSION_ID`
  [V:S1 `shell.ts:272`, `tool/plugin/shell.ts:207`] → any key in OpenCode's env is readable by model-run commands.

**Compaction** [V:S1 `session/compaction.ts`]
- Ceiling = input window − buffer; default buffer = max(15 % of window, 16k) (16k only if window ≥ 32k);
  `compaction.buffer` = tokens or `"20%"`; unknown window assumed 200k; ceiling capped at the context window.
- Size = measured (`input + cache.read + cache.write + output + reasoning` of the last response) + estimates of
  messages since; images ≈ 1,500 tokens, PDFs ≈ 2,000.
- `keep` = 15,000 tokens of newest messages kept verbatim beside the summary (config `compaction.keep.tokens`).
- **Precompute**: a background summary starts at 85 % of the ceiling once measured prompt ≥ 64k; swapped in when due if
  the tail since its anchor ≤ max(2×keep, 30k) and ≤ 25 % of budget; gives up after 2 failures.
- Overflow (provider rejection before output): retries aim at 85 %, 70 %, 50 %, 35 % of the first rejected size.
- The summary request = whole conversation (cache-friendly prefix) + summary prompt; summary output floor 32k.
  Over-long transcripts degrade per exchange: whole → tool I/O clipped to 2,000 chars head+tail → outputs removed →
  user text only → omitted.
- Template headings: Objective · Requirements · Decisions · Work State (Completed/Active/Blocked) · Next Move ·
  Relevant Files (≤ 15) · Important Context. Rules: terse bullets; keep exact paths/symbols/commands/errors/URLs; carry
  only unanswered requests; keep VCS state; never mention compaction. Updates merge into the previous checkpoint
  ("newer history takes precedence"). `prune` (retroactive tool-output removal) is deprecated [V:S1 config schema].

**Caching/usage** [V:S1 `ai/src/cache-policy.ts`, `session/usage.ts`]: up to 4 breakpoints (last tool def, first+last
system part, conversation tail) only on protocols with inline hints (Anthropic-style, OpenRouter, …); OpenAI-compatible
relies on implicit prefix caching. Usage = {input (non-cached), output, reasoning, cache.read, cache.write}; cost =
provider-reported `cost` if present, else catalog prices with context tiers.

**Permissions** [V:S1 `permission.ts`, `schema/permission.ts`]: rules `{action, resource (wildcard), effect allow|ask|deny}`,
**last match wins**, default `ask`, configured denies short-circuit; replies `once|always|reject`; "always" saved in
SQL; an `Unattended` ruleset settles asks for scheduled runs (unmatched → deny); agents without rules → deny all.

**MCP** [V:S1 `mcp/*`, `core/package.json`]: `@modelcontextprotocol/client` 2.3.1 (v2 SDK); stdio (own transport,
>10 MiB messages fixed in 2.2.5), streamable HTTP, socket; OAuth (callback port logic, DCR); form + URL elicitation;
separate startup / catalog / execution timeouts; tool `outputSchema`.

## 3. Option B — Pi (`@earendil-works/pi-coding-agent` 1.4.0, MIT) [V:S2,S3]
- Footprint: coding-agent 23.4 MB unpacked (bundle + TUI, quickjs-wasi, photon image lib); `pi-agent-core` 271 KB
  (deps `typebox`, `pi-ai`, imported at runtime); `pi-ai` 4.3 MB + `openai` 7.19, `@anthropic-ai/sdk`, `@google/genai`,
  `@aws-sdk/client-bedrock-runtime`; `pi-mcp` (dep `cross-spawn`). Node ≥ 22.19 (Electron 45 has 24.22 [V:S7]).
  Releases 1.1.0 (10-07) → 1.4.0 (10-21).
- Loop (`pi-agent-core`): `convertToLlm`, `transformContext(messages, signal)` (pruning/compaction point),
  `prepareRequest`, `beforeToolCall` (can block), `afterToolCall` (can override result), `finishTurn`;
  `toolExecution: "parallel"` (default: preflight sequentially, then run allowed tools concurrently) | `"sequential"`,
  per-tool override; AbortSignal everywhere. Steering messages enter after the current assistant turn and its tools;
  follow-ups after the run; `agent_settled` = will not continue on its own.
- Compaction: trigger `contextTokens > window − reserveTokens` (16,384); keep newest `keepRecentTokens` (20,000);
  cut only at user/assistant/bash/custom entries, **never at a tool result**; a too-long single turn gets two summaries
  (history + turn prefix); iterative (previous summary passed in); cumulative file tracking; overflow or early
  `length` → one compact-and-retry; summary requests disable cache writes.
- Sessions: JSONL **tree** (branches, fork, clone); `SessionManager.inMemory()`; dirs `PI_CODING_AGENT_DIR`,
  `PI_CODING_AGENT_SESSION_DIR`; `PI_OFFLINE`.
- Tools: default `read, bash, edit, write`; optional `grep, find, ls, powershell`, `codemode`, `tool_search` (deferred
  MCP tools). Read cap `DEFAULT_MAX_LINES = 2000`.
- MCP: stdio + streamable HTTP, bearer/env headers, OAuth sign-in via `/mcp`; exposure modes direct / deferred /
  codemode; SDK sessions must add `createMcpExtension()` themselves.
- **Security**: "does not ask for approval before every tool call"; project trust only gates `.pi/*` resources;
  extensions run in-process; recommends containers. In Electron main that means model-driven code paths beside our
  keys and IPC → if used, only inside a `utilityProcess`.
- Defaults to override: `enableInstallTelemetry: true` (anonymous install/update reports + provider attribution headers;
  `PI_TELEMETRY=0`), `cacheWarming: "streaming"` (refreshes caches with 1-token replays = paid requests), retry 3×,
  base 2 s, provider max delay 60 s.
- OpenAI-compatible knobs worth copying: `supportsDeveloperRole`, `supportsStore`, `supportsReasoningEffort`,
  `supportsUsageInStreaming`, `maxTokensField`, `requiresToolResultName`, `requiresAssistantAfterToolResult`,
  `requiresThinkingAsText`, empty-`reasoning_content` replay, `chatTemplateKwargs`, session-affinity header, strict tools.

## 4. T3 Code patterns to copy [V:S4]
- **Runtime adapter V2** (`provider-core/src/server/ProviderAdapter.ts`): `events: Stream`, `ensureThread`,
  `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`,
  `rollbackThread`, `forkThread`, `getCapabilities`. Our harness implements this; OpenCode/ACP adapters can follow.
- **Policy vocabulary** (`contracts/src/providerPolicy.ts`): runtime modes `approval-required | auto-accept-edits |
  auto | full-access` (T3 default: full-access); interaction `default | plan`; request kinds `command | file-read |
  file-change | mcp-elicitation | permission`; decisions `accept | acceptForSession | acceptAlways | decline | cancel`.
- **Event-sourced SQLite** (`persistence/Migrations/055_OrchestrationV2.ts`): `orchestration_v2_events(sequence
  INTEGER PK AUTOINCREMENT, event_id UNIQUE, command_id, thread_id, run_id, node_id, provider, raw_event_id,
  event_type, occurred_at, payload_json)` + indexes on (thread_id, sequence), (run_id, sequence), …;
  `command_receipts` (idempotent commands); projection tables (threads, runs, run_attempts, nodes, …).
- **Worktrees** (`orchestration-v2/ThreadLaunchService.ts`, `worktreesDirectory.ts`): strategy `root | existing_worktree
  {path} | worktree {baseRef, branch?, startFromOrigin?}`; base ref validated before `git worktree add` (`-` →
  `@{-1}`); managed directory setting must be absolute and not a filesystem root; storage cleanup of orphans.
- **Checkpoints**: hidden refs `refs/t3/checkpoints/…` (+ `checkpoint_diff_blobs` table); OpenCode uses a separate snapshot repo.

## 5. GMI-specific efficiency rules (for any option)
1. **Byte-stable prefix**: system (base + tool guidance) → tool schemas (sorted, canonical JSON) → project instructions
   (AGENTS.md) → environment without timestamps → append-only history → new user turn. Volatile data (date, git status,
   open files) goes into the newest user message. Never edit earlier messages; deterministic serialisation; stable
   tool-call ids. A new MCP tool list applies at the next user turn, not mid-loop.
2. Truncate at insertion, never retroactively: tool output ≤ 2,000 lines / 50 KiB with spill-to-file; read dedupe (an
   unchanged re-read returns "unchanged since step N, sha …"); binary/minified detection.
3. `context_length_exceeded_behavior: "error"`, an explicit `max_tokens` (or `max_completion_tokens` per family), and
   `stream_options.include_usage` on every request.
4. Measure: per step `cached/prompt`; alert in dev builds when < 50 % after step 3. Meter with the existing
   `estimateTokenCostUsd` (cached at read price, `overrides[].min_prompt_tokens` tiers, org discount).
5. Cheap models for side work: summaries → DeepSeek-V4-Flash; titles/commit messages → GLM-5.3-Flash or Router;
   explore/search subagents → Flash models; main loop → user's pick (default GLM-5.3 or DeepSeek-V4-Pro after the eval).
6. Cache warming off (paid); never warm without a visible per-thread opt-in.

## 6. Scored comparison (1 = poor, 5 = best; weights in brackets; judgement on the facts above)
| Criterion | A OpenCode sidecar | B Pi in-process | C own harness |
|---|---|---|---|
| GMI efficiency control: prompt layout, caching, tiers, cheap sub-models (×3) | 3 generic provider; config knobs | 4 rich compat knobs | 5 everything ours |
| Key isolation + exact metering (×3) | 3 via gateway; env leaks to shell | 4 custom stream fn → gateway | 5 gateway-native |
| Permissions / sandboxing (×3) | 3 good rules; no OS sandbox | 2 none built in | 5 designed in, native dialogs |
| Loop maturity on day 1 (×2) | 5 | 4 | 2 needs tests + review |
| Maintenance / churn (×2) | 1 daily releases, API breaks | 3 | 4 own code, no upstream |
| Footprint (×1) | 1 ≈ 253 MB/platform, Bun | 4 ≈ 28 MB + provider SDKs | 5 reuses app deps |
| Time to first ship (×2) | 4 | 4 | 2 |
| Fit with T3-style UI/events (×2) | 3 map SSE + REST | 4 events in process | 5 our event schema |
| License (×1) | 5 MIT | 5 MIT | 5 |
| **Weighted total (max 95)** | **59** | **69** | **81** |
Variant C-pi (our loop on `pi-agent-core` with a custom stream fn) saves the loop code but pulls `pi-ai`'s provider SDKs and Pi's release cadence [I].

## 7. Design notes for GMI Desk (C)

### 7.1 Process model
- **Main**: key store, `KeyProvider`, BudgetGuard, catalog, **GMI gateway**, approval dialogs, IPC to renderer.
- **Harness host** = Electron `utilityProcess` (one per app or per project): loops, tools, git, MCP clients, SQLite
  (`node:sqlite`, no native module [V:S7]). Talks to main over a `MessagePort` (no TCP socket for our own harness).
  A crash or hang never takes down the UI; restart replays the event log and resumes or settles in-flight runs.
- Renderer: read-only projections + commands (send, steer, interrupt, approve) over the existing typed IPC.

### 7.2 GMI gateway (main)
- Front doors: (1) MessagePort API for the harness host; (2) optional loopback HTTP, OpenAI-compatible
  (`/v1/chat/completions`, `/v1/responses`, `/v1/models` only) for external runtimes (OpenCode, Codex, Pi RPC).
- Loopback hardening: bind `127.0.0.1` only, random port; per-runtime 256-bit bearer (not the GMI key; useless
  outside this app run); `Host` must equal `127.0.0.1:<port>`; reject any request with an `Origin` header (no CORS ⇒
  no browser/DNS-rebinding access); body cap (e.g. 8 MiB); model allowlist from the catalog; tokens revoked on runtime exit.
- Per request: inject the key (stored key, or the OAuth token while `oauthInference = supported`, D14); force
  `include_usage`, `context_length_exceeded_behavior:"error"`, a `max_tokens` clamp; strip parameters the family rejects;
  fix reasoning replay; tag with thread/run/step ids.
- Budget: pre-flight worst case `(prompt_est × in + max_tokens × out) × (1 − disc)` against the remaining per-turn /
  per-thread / daily / monthly budget (BudgetGuard); post-flight actual usage → spend ledger (cached at read price,
  tiers). Hard stop returns a typed error the loop turns into "budget reached" (no retry).
- Rate: org-wide token bucket sized to the user's tier (default T1 = 1M TPM; learn from 429s), per-model concurrency
  caps, foreground thread first, then round-robin. 429/5xx/reset **before the first byte**: exponential backoff + jitter,
  honour `Retry-After`, max 3; after output started: no transparent retry (the loop decides, OpenCode-style).
  Per-model circuit breaker. Streaming watchdogs: first byte 60 s, idle 90 s, total 10 min (tunable) [I: defaults].
- Observability: per-request trace (ids, model, tokens, cached, cost, latency, status); never bodies or keys by default.

### 7.3 Loop state machine (per thread)
`idle → preparing → requesting → streaming → tools_running ⇄ awaiting_approval → (compacting) → requesting … → idle | failed | cancelled`
- Step = build context (compaction check first) → one model request → collect text/reasoning/tool calls → run tools
  (parallel for read-only tools, sequential for mutating tools and shell; cap 4 concurrent [I]) → append results →
  continue if tool calls, stop on final answer.
- `finish_reason: length` → one continuation prompt (OpenCode wording); overflow error → compact + one retry; invalid
  tool JSON → return a tool error with the schema, max 2 per step.
- Caps (defaults, configurable): 50 steps per turn → tools off + "summarise what is done/left" prompt; per-turn
  cost cap (e.g. $1) and per-thread cap; wall clock per turn (30 min); shell 120 s default / 10 min max; MCP call 60 s.
- Doom-loop guard: identical `(tool, canonical args)` 3× in a row → stop and ask; identical error text 3× → inject a
  hint, then ask; no file change and no new file read in 8 steps → ask; a file's content hash returning to an earlier
  state twice (edit oscillation) → ask.
- Cancellation: one AbortController per turn → aborts the gateway request (and upstream fetch), SIGTERM then SIGKILL
  (5 s) to tool process groups, synthetic "interrupted" results for every unsettled call (history must stay valid for
  the next request), checkpoint left intact.
- Steering (user message while running) enters after the current step's tools; follow-ups queue (Pi semantics).

### 7.4 Context and compaction
- Effective window = min(catalog `context_length`, user cap, price-tier boundary in "economy" mode) − reserve, with
  reserve = max(15 % window, 16k) + `max_tokens`. Size = last measured `prompt_tokens` + estimate of new content.
- Layer 0 (every insert, cache-safe): §5 rules 2.
- Layer 1 (threshold): structured summary (OpenCode template) by DeepSeek-V4-Flash of everything before the newest
  ~20k tokens; cut only at user/assistant boundaries; file ledger (read/modified paths) built from tool events, not
  from the model's memory; previous summary passed in for incremental updates; precompute in the background at 85 %.
- Layer 2 (provider overflow): shrink 0.85 / 0.7 / 0.5 / 0.35 and retry; then fail with a clear message.
- Reasoning: keep it for the current tool loop (required by DeepSeek/Kimi/GLM); drop older reasoning only where the
  family accepts it [U per family].
- Subagents (explore/search) get their own context and return a short report → keeps the main prefix small.

### 7.5 Tools, permissions, sandboxing
- Core tools: `read, list, glob, grep (ripgrep), edit (exact replace + closest-lines error), write, apply_patch, shell
  (pty optional), git_status/diff/commit (via our git service), todo, question, subagent, webfetch (off by default)`.
- Rules = OpenCode model (last match wins, deny first, default ask) + T3 decisions (once / thread / always). Presets =
  T3 runtime modes; **GMI Desk default: auto-accept edits inside the worktree, ask for shell** except an allowlist of
  read-only commands (`git status|diff|log`, `ls`, `rg`, `cat`) and user-approved test commands.
- Path policy: `realpath` every path; must stay inside the thread's worktree (+ explicit extra roots); deny `.git/`
  internals, `.env*`, `*.pem`, `id_*`, `~/.ssh`, `<userData>` (`~/.config/GMI Desk`), `~/.factory/auth*` (ground rule 3).
- Shell confinement (Linux): run through `bwrap` when present (ro root, rw worktree, private `/tmp`, `--unshare-net`
  unless network was approved, `--die-with-parent`, new session); env allowlist (PATH, HOME, LANG, TERM, …) — never
  the GMI key or gateway token. macOS: `sandbox-exec` profile [I: Codex uses Seatbelt]. Windows: ask-mode only.
- Loosening a policy (always-allow shell, network, full-access) needs a native dialog from main (D8 pattern).
- Prompt-injection stance: tool/MCP/web output is data; never auto-allow "read secrets + network" in one turn; show
  the command and cwd in every shell approval.

### 7.6 MCP
- Client: the app's `@modelcontextprotocol/sdk` 1.32.2 is still the current v1 release (2026-10-23); the v2 split
  packages `@modelcontextprotocol/client|server` 2.4.0 exist and OpenCode already moved [V:S2]. Start on v1, plan v2.
- Transports: stdio (process group, kill on stop, env allowlist) and streamable HTTP; OAuth for third-party servers
  reuses the app's PKCE/loopback code (each authorization = a user action). Timeouts: connect, list, call. Freeze the
  tool list per user turn (cache); deferred exposure / `tool_search` when > ~30 tools.
- Built-in **GMI MCP** bridge (through the existing `McpGateway`, OAuth token stays in main): auto-allow
  `search_models, get_model, search_docs, get_account_summary, list_generations, get_generation, estimate_generation`;
  ask with a cost estimate for `submit_generation, upload_media`; always ask `create_support_request`.
- Built-in **sandbox MCP** (in harness host, calls go to main which holds the Compute key): `sandbox_exec {cmd, cwd,
  timeout}` (wait ≤ 25 s, then poll `get_execution`; stdout/stderr ≤ 1 MiB each with `*_truncated`; ≤ 10 concurrent),
  `sandbox_read/write/list`, `sandbox_upload_tree` (worktree → `/workspace`), `sandbox_download`, `sandbox_ports`
  (preview URLs), `sandbox_status`. Create/resume/delete are **not** model tools by default; if enabled, every
  call needs a native dialog with the price (agentbox.md). Project MCP config loads only after a project-trust decision (Pi pattern).

### 7.7 Parallel worktree threads
- Thread = {project, strategy `root | existing | new(baseRef)`, branch `gmi/<slug>-<shortid>`, model, runtime mode}.
  New worktrees: `git worktree add -b <branch> <dir> <baseRef>` under a managed dir (setting; absolute, not a root,
  realpath-checked); archive = dirty check → `git worktree remove` → `git worktree prune`.
- Per-turn checkpoints as hidden refs `refs/gmi-desk/checkpoints/<thread>/<turn>` built with a temporary
  `GIT_INDEX_FILE` + `write-tree`/`commit-tree` (never touches the user's index or branch); revert = restore tree.
- Persistence: T3-style append-only event table + projections + command receipts in `node:sqlite`; one writer
  (harness host); renderer reads projections.
- Scale: each thread is an independent loop; the shared limits are the gateway TPM bucket, per-model concurrency and
  the budget, so 10 threads on T1 queue rather than fail.

### 7.8 Agents that drive Agentbox sandboxes
Run the loop **locally** and execute tools remotely through the sandbox MCP: no inference key inside the sandbox,
metering and budgets stay in the gateway, the user sees the same approvals. Running the agent inside the sandbox with
Agentbox's `generated_api_key` is only for long unattended jobs, with its own spend cap (key scope/limits [U]).

## 8. Security checklist (pre-audit)
- GMI key, OAuth tokens and Compute key never leave main; harness/sidecars get scoped gateway tokens only.
- Sidecar env scrubbed (OpenCode shell inherits env [V:S1]); config secrets never in `OPENCODE_CONFIG_CONTENT`
  (whether OpenCode's config endpoint echoes provider options [U]).
- Loopback gateway: 127.0.0.1, bearer, Host check, no Origin, body cap, model allowlist; no listener at all for our harness.
- Tools: realpath + worktree confinement, secret-path denylist, process-group kill, output caps, bwrap where available.
- Approvals: deny-first rules, native dialog to loosen, unattended runs deny by default (OpenCode `Unattended`).
- Pi defaults (if ever used): `PI_TELEMETRY=0`, `cacheWarming: "off"`, `PI_OFFLINE=1`, in-memory or app-owned session dir.
- Logs/traces: no prompts, outputs or keys by default; sessions export only on request (they can contain secrets).
- Supply chain: pin versions; OpenCode/Pi updates through our release, never self-update (`OPENCODE_DISABLE_AUTOUPDATE`).

## 9. Open questions (each needs one approved, cents-level probe or GMI's answer)
1. Automatic prefix caching on open models, and is `usage.prompt_tokens_details.cached_tokens` present in the
   final stream chunk? (two identical ~2k-token requests to DeepSeek-V4-Flash ≈ $0.001)
2. Cache affinity across replicas: `prompt_cache_key`, `user` or a header? Cache TTL?
3. `cache_control` honoured for kimi-k3.1-pro / Qwen3.8-Max / GPT on `/chat/completions`; are writes billed?
4. Do cached tokens count toward TPM? Exact 429 body and `Retry-After`?
5. Per-model tool calling: `parallel_tool_calls`, `tool_choice:"required"`, `strict`; reasoning replay rules per family.
6. Is `context_length_exceeded_behavior:"error"` accepted by every model, and what is the overflow error code?
7. Real max output per model (docs' `max_tokens` "1-128" range looks wrong); no catalog field.
8. `/responses` for non-OpenAI models; does `store`/`previous_response_id` keep data server-side (privacy)?
9. Agentbox `generated_api_key` scope, expiry and spend limits.

## 10. Recommendation
Build **C**: a GMI-native harness in a `utilityProcess` with the gateway in main, in four milestones:
**H1** gateway (metering with cached/tier pricing, budgets, TPM scheduler, retries) + loop + core tools, one thread,
mock-provider golden tests (stream cuts, 429, overflow, tool hangs, invalid JSON); **H2** compaction (layers 0–2,
precompute), permissions + bwrap, checkpoints, doom-loop guards; **H3** parallel worktree threads, event-sourced
SQLite, MCP client + GMI MCP + sandbox MCP; **H4** security audit (multi-lens review like the first build) and the paid
model eval (needs approval) to pick defaults. Use OpenCode's and Pi's numbers above as starting values. Revisit A
only as an optional external runtime behind the adapter interface, always routed through the loopback gateway with an
isolated `XDG_*`, `--stdio` lifetime and a pinned version.
