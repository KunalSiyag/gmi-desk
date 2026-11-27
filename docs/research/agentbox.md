# GMI Agentbox: sandboxes, data plane, shell, ports (research, 2026-11-02)

Reference for the Compute tab, the live "computer" panel and agent sandbox tools. Nothing was created or paid for:
only docs, package sources and unauthenticated GETs were used (ground rule 2). **Fast-moving:** the docs describe SDK
behaviour newer than the published packages (see §12). Re-verify before relying on anything here.

**Markers.** `[V:Sx]` = verified from source Sx on 2026-11-02. `[I]` = inferred. `[U]` = unverified or unknown.

| Id | Source |
|---|---|
| S1 | OpenAPI `https://docs.gmicloud.ai/api-spec/sandbox_api.yaml` ("GMI Sandbox API" 2.0, OpenAPI 3.0.3, 212 KB, hand-maintained subset of GMI's internal spec) |
| S2 | `https://docs.gmicloud.ai/agentbox-sdk/{overview,quickstart,agents,sandboxes,commands-and-files,shell,snapshots,errors-and-limits,python-reference,go-reference}.md` |
| S3 | `https://docs.gmicloud.ai/agentbox-api/sandbox/overview.md`, `/agentbox-api/sandbox-sdk/{usage,sdk-reference}.md` and the per-operation pages (they mirror S1) |
| S4 | `https://docs.gmicloud.ai/agentbox-marketplace/{overview,register-an-agent,managing-your-deployment,search-and-use,list-an-agent,verified-agents,handle-long-running-requests}.md` |
| S5 | Source of PyPI `gmi-agentbox-sdk` 0.1.0b6 (wheel, `agentbox_sdk/client.py`, `errors.py`) |
| S6 | Source of PyPI `gmi-sandbox-sdk` 1.2.1 (wheel, `sandbox_sdk/client.py`, `_transport.py`) |
| S7 | `github.com/GMISWE/agentbox-sdk-go` HEAD (latest tag v0.1.0-beta.7): `agentbox/shell.go`, `sandboxes.go`, `client.go`, `docs/{usage,reference}.md` |
| S8 | `curl -A "gmi-client-research/0.1"` unauthenticated GETs, 2026-11-01T22:10Z (responses quoted below) |
| S9 | npm registry search API + GitHub API `orgs/GMISWE/repos`, PyPI JSON API, 2026-11-02 |
| S10 | The user's earlier Agentbox notes in sibling projects (`../remote-dev-template/agentbox/README.md`, `../ai-search-forensics/docs/AGENTBOX.md`): observed live, not re-checked |

---

## 1. TL;DR: there are two APIs over the same product

| | **A. Agentbox gateway ("v1/agents")** | **B. Sandbox API v2** |
|---|---|---|
| Base | `https://api.gmi-serving.com/v1/agents` [V:S2,S5] | Control `https://console.gmicloud.ai/api/v2`; data plane `https://{sandbox_key}.{domain}` [V:S1,S3] |
| Auth | `Authorization: Bearer <Compute API key>` on everything, including the shell WebSocket [V:S5,S7] | Control: `Bearer <API key or Access Token>`; data plane: `X-Access-Token: <sandbox_access_token>`. Not interchangeable [V:S1] |
| Objects | Agent = "deployment" (slug); Sandbox = "task" [V:S4,S5] | Template (+ Builds, Files), Sandbox, Snapshot, Product [V:S1] |
| Data plane | Proxied by the gateway: `/tasks/{id}/executions`, `/files`, `/shell`, `/stream` [V:S5] | Direct to the sandbox host (exec, files, shell PTY) [V:S1] |
| Shell | WebSocket, **JSON text frames** (`stdin`/`resize`/`stdout`/`status`/`error`), Beta [V:S2,S7] | WebSocket, **raw BINARY frames** (xterm.js-compatible); resize/close over HTTP `POST /shell/control` [V:S1] |
| Status feed | SSE `GET /tasks/{id}/stream` [V:S5] | None; poll `GET /sandboxes/{id}` [V:S1] |
| Extras | Marketplace/Console agents, container runtime (`gmi-ce`), `generated_api_key` (MaaS key), `/eligibility`, `/idcs`, `/products` **with price** [V:S2,S5] | Idempotency keys, egress allowlist, `secure` port tokens, `auto_pause`, exec `cwd`/`envs`/`execution_timeout_seconds`, Range downloads, OpenAPI spec [V:S1] |
| SDKs | Python `gmi-agentbox-sdk`, Go `agentbox-sdk-go` | Python `gmi-sandbox-sdk` (no shell, no actions) |
| CORS | `access-control-allow-origin: *` (on the 401 response) [V:S8] | Not sent on the 401 response [V:S8]; WS handshake refuses browser `Origin`s not on an allowlist (403) [V:S1] |

Whether a v1 "task" and a v2 "sandbox" are the same record (same UUID) is **[U]**. Both are described as the Console's
"Template"/"Sandbox", both use the same build model (waiting/building/ready/error, paged logs, 410 on expiry), and the
Console's "Agent"="Template" [V:S2], so the gateway very likely fronts v2 [I]. Verify with two free list calls
(`GET /v1/agents/tasks`, `GET /api/v2/sandboxes`) once the user provides a Compute key.

## 2. Credentials and auth

- **Key:** both SDK docs say: Console → **Compute** panel (not Inference) → Access → API Keys
  (`/user-setting/ce/access/api-keys`); env `GMI_AGENTBOX_API_KEY` (A) / `GMI_SANDBOX_API_KEY` (B) [V:S2,S3]. This is
  the `ce_resource` key already in docs/RESEARCH.md. Validate with `GET https://console.gmicloud.ai/api/v1/me/api-keys/current` (RESEARCH.md).
- **v2 control plane** also accepts an "Access Token" (`bearerAuth`: "API Key or Access Token... the gateway
  recognizes the token type automatically") [V:S1]. Presumably the console IAM session token [I]. The MCP OAuth token
  has no Agentbox scope (RESEARCH.md); whether v2 accepts it is [U]; do not try it without the user (it is an OAuth use).
- **Unauthenticated responses** [V:S8]:
  - A: `401 {"error":"unauthorized","message":"Authorization header required"}`, headers `x-gmi-request-id`,
    `access-control-allow-origin: *`, CSP, `x-frame-options: SAMEORIGIN`.
  - B: `401 {"code":200,"group":"api-key","message":"Invalid API key."}` (the console gateway's shape, same as the
    `/me/api-keys/current` 401 in RESEARCH.md, *not* the spec's `{code:"Auth.Unauthorized",...}`).
- **Data-plane token** (B): `sandbox_access_token`, bound to one sandbox (A's token on B's host fails), valid for the
  sandbox lifetime; **re-signed** when the lifetime is extended (connect with `timeout`, `POST /timeout`) or on resume,
  so call `POST /sandboxes/{id}/connect` again and overwrite `sandbox_key`, `domain` and the token. No rotation endpoint.
  401s are identical for missing/expired/wrong-sandbox tokens (anti-probing) [V:S1].
- **Traffic token** (B): `traffic_access_token`, issued only when the sandbox was created with `secure: true`; sent as
  header `traffic-access-token` to "non-control ports" [V:S1]. A rotation mutation (`rotate_traffic_token`) exists in
  the `latest_operation.type` enum but **no public endpoint** triggers it (`/actions` accepts only
  `update_egress_policy`) [V:S1]. Same for `update_ingress_policy`.
- A Compute key is org-scoped and can spend money (sandboxes, agents, auto-issued MaaS keys). Keep it in main.

## 3. Objects and naming

| Console | Gateway A | v2 B | Notes |
|---|---|---|---|
| Template / Agent | deployment `{slug}`; `id` = Template ID | Template `{id}` (UUID) | A: `template_id` in launch = Agent `id` [V:S5] |
| Data Center | `idc` / `idc_name` | `idc_name` | e.g. `us-central-iowa16`, `us-denver-1`, `us-central1-c` [V:S1,S2] |
| Specification | `instance_type` (billing SKU) | `product` (catalog SKU) | `gmi.sandbox.small` … `gmi.sandbox.x-large`; labels X_SMALL/SMALL/MEDIUM/LARGE/X_LARGE [V:S1,S2]; Console offers SMALL/MEDIUM/LARGE [V:S4] |
| Sandbox | task `{task_id}` | sandbox `id` (UUID, also billing `resource_id`) + `sandbox_key` (`i` + 20 random chars, host label only) [V:S1] |
| Execution | `execution_id` | `execution_id` (UUID) |

## 4. Gateway A endpoints (`https://api.gmi-serving.com/v1/agents`) [V:S5, S7; S4 for the Integration-tab curls]

| Method + path | Body / query | Notes |
|---|---|---|
| `GET /eligibility` | | `{eligible, dataCenters\|data_centers}` |
| `GET /idcs?runtime=sandbox` | | list of `{idc_id, name}` |
| `GET /products?idc_name=&runtime=sandbox` | | list of `{instance_type, price, ...}` (price unit [U], presumably USD/hr) |
| `POST /deployments` | `{title, image_url, idc, instance_type, runtime:"sandbox", deployment_type ("gmi-ce" default for sandbox), start_cmd, env:[{name,value,secret}], ports:[...], image_credential:{username,secret}, short_desc, assign_public_ip, share_storage_mount_path, clone_source_id}` | Creates Agent + starts image build; does **not** start a sandbox. 422 if sandbox runtime without `idc`/`instance_type`. `generated_api_key` (plaintext MaaS key) only in this response, only if `env` has `GMI_MODELS`. Port object shape [U] (Console: protocol HTTPS/2 default, also TCP, UDP, HTTPS/1.1; external 443 → internal 8080, name `web` [V:S4,S10]) |
| `GET /deployments?page&page_size` · `GET/PATCH/DELETE /deployments/{slug}` | | PATCH locked field → 422. DELETE → 409 while it has sandboxes (and for minutes after) |
| `GET /deployments/{slug}/builds` · `/builds/{id}` · `/builds/{id}/logs?offset&limit(1-100)&level` | | Logs paged (not streamed), `{entries:[{offset,level,message,timestamp}], next_offset, has_more}`; 410 once expired (even on success). Container agents → 501 |
| `GET /deployments/{slug}/snapshots` | | newest first; 422 `sandbox_only_operation` |
| `POST /deployments/{slug}/tasks` | `{idc_name, instance_type, template_id, env, display_name, metadata, timeout_seconds (≥60, pins expiry), snapshot_id, assign_public_ip, ports, storages}` | Returns `{task_id, container_id, status}` (starts `pending`); no expiry in response |
| `GET /deployments/{slug}/tasks?metadata[k]=v` · `GET /tasks?deployment_id&status=a,b&page&page_size` | | Default list excludes `stopped`, `deleted` |
| `GET /tasks/{id}` · `DELETE /tasks/{id}` | | Fields: `task_status\|status, endpoint_url, deployment_id, deployment_slug, display_name, instance_type, idc_name, status_stale, last_error, runtime, capabilities, expires_at, expiry_pinned, metadata, source_snapshot_id, sandbox.{paused_at, paused_expire_at}` |
| `POST /tasks/{id}/timeout` | `{timeout_seconds}` | ≥60 and ≤ account max (400 `invalid_timeout`); running or paused only (409 `task_not_running`); returns `{task_id, expires_at, expiry_pinned}` |
| `POST /tasks/{id}/pause` · `POST /tasks/{id}/resume` | resume: `{timeout_seconds?}` | 202 `{task_id, state}`; 409 `task_not_running` / `task_not_paused` |
| `POST /tasks/{id}/snapshots` | `{name?}` | `{snapshot:{...}}`; 403 if not creator/org owner; 409 `snapshot_conflict` |
| `PATCH /snapshots/{id}` `{name}` · `DELETE /snapshots/{id}` | | rename only when ready/error |
| `GET /tasks/{id}/stream` | `Accept: text/event-stream` | SSE: `status` events, `:` comment lines = heartbeat |
| `POST /tasks/{id}/executions` | `{command, wait, wait_timeout_seconds (1-25, only with wait)}` | 200 = finished, 202 = still running (`accepted`); body has `execution_id\|id, status, exit_code, stdout, stderr, stdout_truncated, stderr_truncated`. `cwd`/`envs` pass-through [U] |
| `GET /tasks/{id}/executions/{eid}` · `POST .../{eid}/cancel` | | |
| `POST /tasks/{id}/files?path=/abs` (multipart, part `file`) · `GET /tasks/{id}/files?path=/abs` | | Raw bytes + `Content-Disposition` |
| `GET wss://api.gmi-serving.com/v1/agents/tasks/{id}/shell` | `Authorization: Bearer` header | §7. Redirects not followed |
| `GET /tasks/{id}/metrics`, `/metrics/timeseries` | | 501 `not_supported_by_runtime` on sandboxes |

Console Integration tab shows exactly provision (`POST /deployments/<slug>/tasks` with `idc_name`, `instance_type`,
`template_id`), list, poll `GET /tasks/<id>` until `running`, `DELETE /tasks/<id>` [V:S4].

## 5. v2 control plane (`https://console.gmicloud.ai/api/v2`, Bearer) [V:S1]

Envelope: success `{request_id, data}`; lists `{request_id, total, page, page_size, items}` (page ≥1, page_size ≤100,
default 20); errors `{code, message, request_id, trace_id?, details?}`.

| Endpoint | Key facts |
|---|---|
| `POST /sandboxes` (+ `Idempotency-Key`) | Exactly one of `template_id` (id or name) / `snapshot_id` (400 `Sandbox.SourceConflict`). Optional `product`, `idc_name` (default = org default IDC; must own the template), `timeout` (s, **default 300**, max 86400 per IDC), `env_vars{}`, `metadata{}`, `secure` (traffic token), `auto_pause` (pause instead of kill at timeout), `egress_control` (deny-all + allowlist; immutable), `egress{allowed_hostnames["*.x"], allowed_cidrs[IPv4]}`, `default_user {username:"root",uid:0}` (some IDCs). 201 → `{id, sandbox_key, template_id, domain, sandbox_access_token, traffic_access_token}`; async backends start `provisioning`. 429 `Resource.QuotaExceeded` (details: quota_name/quota/used/requested) or `RateLimit.Exceeded` (`quota_name: concurrent_creates` + `Retry-After` s, or platform capacity with neither) |
| `GET /sandboxes?state=&idc_name=&metadata[k]=v` | Default: all active + `failed`; `deleted` only when asked; `running` also matches `updating`/`checkpointing`; sorted by `started_at` desc |
| `GET /sandboxes/{id}` | `id, sandbox_key, template_id, snapshot_id, idc_name, state, product, product_name, resources{vcpu,memory_mb,disk_mb}, metadata, latest_operation{type,status,error_code,message,completed_at}, failure{code,message,occurred_at}, created_at, running_at, started_at, end_at, paused_at, paused_expire_at, pause{code,initiator,message,requested_at}, domain, deletion{code,initiator,message,requested_at,completed_at}, lifecycle{auto_resume,on_timeout:pause\|kill}, egress_control, egress`. Expired-but-unreclaimed → 404 |
| `PATCH /sandboxes/{id}` `{metadata}` | Whole-map replace; works in any state except deleting/deleted |
| `DELETE /sandboxes/{id}` | 200 `deleted` (released in-request) or 202 `deleting` (reconciler retries); replayable, never 409; no force flag; accepted even during IDC maintenance |
| `POST /sandboxes/{id}/connect` `{timeout?}` | Returns `{id, sandbox_key, template_id, domain, sandbox_access_token, traffic_access_token, end_at}`; `timeout>0` extends only. 409 paused/transitional; 404 failed/deleted/**still provisioning** |
| `POST /sandboxes/{id}/pause` / `resume {timeout?}` | 202 + state at acceptance; poll detail. Resume is the only wake-up; failed resume returns to `paused` (unless backing instance gone → `deleting`) |
| `POST /sandboxes/{id}/timeout {timeout}` | Running/paused only; returns `{old_end_at, new_end_at}` (authoritative); paused: `end_at = paused_at + timeout` |
| `POST /sandboxes/{id}/actions {action:"update_egress_policy", params:{...}}` | Only `running` + `egress_control=true`; full replace; `applied: immediate\|eventual` |
| `GET /products?idc_name=(required)&resource_type=sandbox&include_unavailable` | `{product, name, status active\|unavailable, resources{cpu_count,memory_mb,disk_size_mb,architecture x86_64\|arm64}}` — **no price** |
| `/snapshots` CRUD | create `{sandbox_id, name?, metadata?}` (names unique per org; 409 `Resource.AlreadyExists`); poll until `ready`/`error`; delete 202 |
| `/templates`, `/templates/{id}/builds`, `/files` | §10 |

## 6. v2 data plane (`https://{sandbox_key}.{domain}`, `X-Access-Token`) [V:S1]

Never build `domain` yourself (default shape `{idc-name}.{root-hostname}`). Flat JSON with top-level `request_id`
(`req-<uuid>`, also `X-Request-ID` header; client values ignored); errors `{code, message, request_id, details?}`.

**Exec** `POST /executions?wait=true&wait_timeout_seconds=1..25` (+ optional `Idempotency-Key`), body
`{"action":"exec","parameters":{"command","envs":{},"cwd":"/abs","execution_timeout_seconds":1..3600 (default 300)}}`.
- 200 = terminal result; 202 = accepted/still running (`{execution_id, sandbox_id(=sandbox_key), status}`); a wait
  timeout never cancels. Body ≤1 MiB; command ≤128 KiB, no NUL; env names `[A-Za-z_][A-Za-z0-9_]*` ≤128 B, values ≤64 KiB.
- **≤10 non-terminal executions per sandbox** → 429 `Execution.ConcurrencyLimitExceeded`.
- Result: `status, exit_code (null unless exited; 128+signal on OOM/kill), stdout, stderr (each ≤1 MiB, then
  *_truncated=true), started_at, completed_at, termination_reason (explicit_cancel|execution_timeout|runtime_terminated),
  failure_reason (cwd_not_found|cwd_not_directory|permission_denied)`.
- Cancel/timeout kills the whole process group (SIGTERM then SIGKILL); `setsid` escapes it. `nohup srv > log 2>&1 &`
  survives the execution (needed for dev servers); an execution ends only when its stdout/stderr close. Paused time
  counts toward the execution timeout.
- `GET /executions/{eid}`; `POST /executions/{eid}/cancel` (empty body; 202; 409 `AlreadyCancelled|CancelInProgress|AlreadyCompleted`).
- Command string is run by the data plane; the v2 SDK wraps it as `/bin/bash -c '<cmd>'` itself [V:S6]. Other codes:
  `Execution.RuntimeNotRunning` (409), `ProviderUnavailable|StoreUnavailable` (503, retryable), `ResultFailed` (500).

**Files** `GET /files?path=/abs[&username=]` (raw bytes) and `POST /files?path=/abs` (multipart, part **`name="file"`**,
one file, overwrite). Path must be absolute, normalized (no `.`, `..`, `//`), not a directory; **parent dir must exist**.
Upload returns `[{path,name,type:"file"}]`; a misnamed part still returns 200 with `[]` → check non-empty. **No list,
stat, mkdir, delete or move endpoint.** No resumable upload; per-IDC size limit not exposed (413; A docs: ~500 MB [V:S2]);
507 = disk full; 415 non-multipart. Downloads: `Accept-Ranges: bytes|none`, `Content-Length` optional (else chunked),
`206` only where supported (a `Range` request may legitimately get `200` + whole file: resume only on `206`); no
checksums. `username` may be ignored by some IDCs (no permission isolation). 409/412 state conflict, 429 rate limit.
SDK `upload_tree` = tar → `/tmp/.gmi-upload-<uuid>.tar` → `tar -xf` via exec [V:S6].

## 7. Interactive shell

**v2 (spec, not "Beta"-labelled)** [V:S1]
1. `POST /shell` (body empty or `{}`) → 200 `{status: ready|attached, connect_url:"/shell/connect"}` or 202
   `{status:creating, code:"Shell.Creating"}` (retry; never duplicates the PTY). 409 `Shell.RuntimeNotRunning|Closing`,
   502 `Shell.CreateFailed`, 503 retryable.
2. `wss://{sandbox_key}.{domain}{connect_url}` with `X-Access-Token`. **BINARY frames only**: client→server raw input
   bytes, server→client raw output bytes (ANSI; xterm.js-compatible). A text frame = protocol violation → connection
   dropped. Post-upgrade attach failure → close 1011 `attach failed`. Browser `Origin` not on allowlist → 403.
3. **One active connection per sandbox**: second attach → 409 `Shell.AlreadyAttached` at handshake. Disconnect keeps
   the session; reattach resumes it.
4. `POST /shell/control` `{action:"resize", cols, rows}` (1..1000; requires an active attach, else 409
   `Shell.NotAttached`; 502 `Shell.ResizeFailed` is safe to retry) or `{action:"close"}` (irrevocable: PTY killed, WS cut
   within ~1 s; next `POST /shell` makes a new session; 502 `CloseFailed` still means gone).
5. Shell states: `creating → ready ⇄ attached → closed`. Keepalive/ping and idle timeout: **not documented [U]**.

**Gateway A (Beta, "may change")** [V:S2,S7]: `wss://.../v1/agents/tasks/{id}/shell` with `Authorization: Bearer`.
TEXT frames with JSON: server sends `{"type":"status","message":"connected"}` first, then `{"type":"stdout","data"}`,
`{"type":"error","message"}`, `{"type":"status","message":"closed"}`; client sends only `{"type":"stdin","data"}`
and `{"type":"resize","cols","rows"}` (anything else silently ignored). Bash as **root**, `HOME=/root`, stderr merged,
`\r\n`, input echoed. Single attachment, but differently: the second connection gets `connected` then `error` and no
output (handshake succeeds). Running `exit` kills the session for good (later attaches get `connected` then `closed`):
close the socket instead. Image needs `bash` [V:S2]. Python client: `websocket-client` ≥1.8 with `enable_multithread`.

## 8. Exposed ports and preview URLs

- v2 host scheme: control/data plane at `https://{sandbox_key}.{domain}`; **port services at
  `https://{port}-{sandbox_key}.{domain}`** [V:S1 (`sandbox_key`, `domain` descriptions)]. With `secure:true` those
  "non-control ports" require header `traffic-access-token: <traffic_access_token>`; with `secure:false` (default) the
  token is empty, i.e. the port URL is reachable by anyone who knows the host [I from S1]. Protocol (HTTPS termination,
  WebSocket/HMR pass-through, which ports are allowed, idle timeouts) [U].
- Gateway A: `endpoint_url` is empty until an endpoint is assigned (can lag `running`); "on the sandbox runtime it holds
  the data-plane URL once running" [V:S7]. The Console Monitor tab has an **Endpoint** column [V:S4]. Agents declare
  `ports` (Console default HTTPS/2 443 → 8080 `web`; image must bind the Internal Port and serve health checks or the
  sandbox is marked errored [V:S4]). For GMI-hosted CE-path instances the Console showed no public endpoint (S10).
  How a v1 task's ports map to the `{port}-{key}` scheme and whether v1 can set `secure` [U].
- v2 `start_cmd` must **terminate**; long-running servers must be backgrounded *and* detached from stdout/stderr
  (`srv > /var/log/srv.log 2>&1 &`) or the sandbox stays initializing and execs are rejected [V:S1]. Gateway-A/Console
  templates instead run the image's CMD as a long-lived HTTP server [V:S4]: two different runtime contracts [I].

## 9. Lifecycles

| Thing | States (source) |
|---|---|
| Sandbox v2 [V:S1] | `provisioning → running`; `running ⇄ updating/checkpointing` (brief leases); `running → pausing → paused → resuming → running`; `failed` (terminal, `failure`); `deleting → deleted` (soft, record kept forever). At `end_at`: `on_timeout=kill` → deleted (`Sandbox.Expired`) or `pause` (`auto_pause`). Billing pause: `pause.code = Sandbox.BillingInsufficientBalance`. The v2 Python SDK's `SandboxStatus` enum also has `ready, active, error, cancelled` [V:S3]: accept unknown states |
| Sandbox A [V:S2,S5] | `pending/creating → running`; failure set `error, deleted, stopped, stopping`; `pausing/paused/resuming`; `status_stale` flag |
| Execution [V:S1] | `pending → running → succeeded \| failed \| timed_out`; `→ cancelling → cancelled` |
| Snapshot [V:S1,S2] | `creating → ready \| error`; `deleting → (gone) \| delete_failed` |
| Template build [V:S1,S2] | `waiting → building → ready \| error`; logs live only, 410 later |
| Deletion reasons [V:S1] | `Sandbox.UserDeleted, Expired, ProvisionTimedOut, ProvisionFailed, ResumeTimedOut, PauseFailed, ProviderGone, BillingInsufficientBalance, BillingNoPermission, BillingProductNotFound, BillingOrderCreateFailed, BillingSuspended, Unknown`; `initiator user\|billing\|lifecycle\|system`; `deletion.requested_at` = end of billing metering |

**Lifetime.** A: omit `timeout_seconds` → 24 h platform TTL that **auto-renews**; any value (≥60) pins it [V:S2].
B: omit `timeout` → **300 s**; max 86400 (per IDC) [V:S1]. Pause freezes `end_at`; remaining run time = `end_at − paused_at`.
Paused sandboxes are kept **7 days** (`paused_expire_at`), then deleted with their disk [V:S1,S2,S4].

**Pause semantics conflict (important).** v2 spec: pause preserves "disk, memory, and process state", resume continues
processes without re-running `start_cmd` [V:S1]. Agentbox SDK docs, v2 SDK docs and S5 docstrings: memory and processes
are **not** kept, resume is a cold start, `/tmp` (S5, S3) or `/dev/shm` (S2) is cleared, and the start command is not
re-run [V:S2,S3,S5]. Console: "files and processes are kept... resumes where it left off" [V:S4]. The spec's
`termination_reason=runtime_terminated` ("resumed from a pause without memory") implies it is **per IDC/provider** [I].
Design for cold resume: re-launch dev servers after resume, reconnect the shell, call connect for a new token.

## 10. Templates / Agents, builds, snapshots

- v2 `POST /templates` (`Idempotency-Key` **required**): `{name ^[A-Za-z0-9_-]{1,64}$ (unique per org+IDC), description≤256,
  idc_name, resources:{type:"preset", product}, labels (≤64), build?}`; `build = {source:{type:image, image,
  registry_credential{type:general,username,password} (one-time, never stored)} | {type:dockerfile, dockerfile≤256 KiB:
  one FROM, RUN/ENV/WORKDIR/USER/COPY/ADD/CMD/ENTRYPOINT; EXPOSE/VOLUME skipped} | {type:template, template_id},
  commands[≤100], envs (build-only, write-only), build_timeout_sec 60..3600 (default 600), start_cmd, default_user,
  file_context}`. `COPY {{file:<file_id>}}` needs the split flow: `POST /templates/{id}/files` (tar/tgz ≤1 GiB, sha256,
  single PUT to a returned URL, poll status) then `POST /templates/{tid}/builds/{id}` (start). Rebuild = `POST
  /templates/{tid}/builds` (not idempotent; supersedes running builds; not every IDC: 422). Validated distros:
  Debian/Ubuntu, Fedora/CentOS Stream/Rocky/Alma, Arch, Alpine [V:S1,S3]. `custom` resources → 400 [V:S3].
- Gateway A agent create builds the image too; poll `template_build_status`; a repeat build of the same image is faster;
  `failure.message` is safe to show users [V:S2]. Delete agent → 409 while sandboxes/snapshots exist (retry for minutes).
- Snapshots: disk only (no memory/processes, **no secret envs**); source must be `running` (paused → 409); launch from
  snapshot inherits size+IDC (`instance_type` ignored); launching before `ready` → 409 `snapshot_not_ready` (A) /
  `Snapshot.NotReady` (B); deleting a snapshot with live children → 409 (B SDK); create/rename/delete need creator or
  org owner (403), listing is org-wide [V:S1,S2,S3]. Snapshot storage cost [U].

## 11. Errors (switch on `code`, never on `message`)

- A: body `{"error":"<code>","message":"..."}`, header `x-gmi-request-id` [V:S8]. Codes seen: `unauthorized`,
  `snapshot_not_ready`, `snapshot_not_found`, `snapshot_conflict`, `task_not_running`, `task_not_paused`,
  `invalid_timeout`, `invalid_name`, `sandbox_only_operation` (422), `not_supported_by_runtime` (501) [V:S2,S5,S7].
  S5 0.1.0b6 still puts `error` into `message`; docs describe the b8 fix (`code` = `error`) [V:S2,S5].
- B: dotted codes. `Request.InvalidParameter` (parse/format) vs `Parameter.Invalid` (business) both 400;
  `Auth.Unauthorized`, `Auth.Forbidden`, `Resource.NotFound`, `Resource.StateConflict`, `Resource.AlreadyExists`,
  `Resource.QuotaExceeded`, `RateLimit.Exceeded`, `IDC.UnderMaintenance` (409 on writes, reads OK),
  `Sandbox.IdempotentParameterMismatch` (400), `Sandbox.IdempotentKeyConsumed` (409), `Template.ProviderNotSupported`
  (422), `Snapshot.UnsupportedOnProvider` (422), `Request.Canceled` (499), `Request.Timeout` (504), `System.Internal`;
  mutation failures carry `details.{state,last_mutation}`; plus `Execution.*`, `Shell.*` above [V:S1].
- Neither SDK family retries API errors (A: none at all; B: transport retries ×3 for GET/HEAD, connect-phase only for
  others, never a DELETE whose response was lost) [V:S2,S3,S6]. Implement our own backoff on 429/5xx/503.

## 12. SDKs and packages (all verified S9 unless noted)

| Package | Version / date | License | Covers |
|---|---|---|---|
| PyPI `gmi-agentbox-sdk` (`agentbox_sdk.AgentBoxClient`) | 0.1.0b6, 2026-10-16 (docs already describe 0.1.0b8) | MIT | Gateway A; deps `websocket-client>=1.8`, `certifi`; UA `gmi-agentbox-sdk-python/<v>`; Python ≥3.9 |
| Go `github.com/GMISWE/agentbox-sdk-go` | tag v0.1.0-beta.7 (docs mention beta.8); pushed 2026-10-27; **no license file** | none | Gateway A incl. shell (gorilla/websocket), SSE |
| PyPI `gmi-sandbox-sdk` (`sandbox_sdk.SandboxClient`, `AsyncSandboxClient`) | 1.2.1, 2026-10-18 | MIT | v2 control + exec/files; **no shell, no `/actions`**; create() lacks `secure`/`auto_pause`/`egress*`/`product` in 1.2.1 [V:S6] |
| npm (official JS/TS) | **none** found (searches "gmi agentbox", "gmi sandbox", "gmicloud", "agentbox-sdk", scope `@gmicloud`) | | Unrelated `agentbox*` packages exist (madarco, TwillAI, abox-dev): not GMI |
| npm `@corsair-dev/gmicloud` | 0.1.0, 2026-10-30 | Apache-2.0 | Third-party; has v2 sandbox exec/files/templates/products ops with `X-Access-Token`; no shell [V:S9 tarball grep] |

For GMI Desk (TypeScript, Electron main): write our own thin client. Generate v2 types from S1 with
`openapi-typescript` (pin the spec by hash; it changes), hand-write the small gateway-A surface from S5/S7.

## 13. Limits and quotas (one table)

| Limit | Value | Src |
|---|---|---|
| Sync exec wait | ≤25 s (`wait_timeout_seconds` 1..25) | S1,S2 |
| Exec run time (v2) | 1..3600 s, default 300 | S1 |
| Concurrent executions | 10 non-terminal per sandbox | S1 |
| stdout / stderr | 1 MiB each, then truncated | S1,S2 |
| Exec body / command / env value | 1 MiB / 128 KiB / 64 KiB | S1 |
| Upload | one file/request, ~500 MB (A docs), per-IDC hidden limit (B) | S1,S2 |
| SDK default request timeout | 30 s | S2,S3 |
| Lifetime | A default 24 h auto-renew, min 60 s; B default 300 s, max 86400 s (per IDC), "account maximum" exists | S1,S2 |
| Paused retention | 7 days | S1,S2,S4 |
| Metadata (A) | ≤32 keys, key `^[A-Za-z0-9_.-]{1,63}$`, value ≤256 chars, reserved `source`, `task_name`; visible in Console | S2 |
| Shell | 1 connection/sandbox; cols/rows 1..1000 | S1 |
| Idempotency keys | 1-64 printable ASCII, no whitespace, remembered 24 h | S1 |
| Create concurrency | org `concurrent_creates` per IDC (429 + `Retry-After`); instance/vCPU/instance_type quotas (429 `Resource.QuotaExceeded`) | S1 |
| Docker in sandbox | not available | S2 |
| Network | outbound IPv4 on by default via shared IDC egress IP (some sites block it) | S2 |
| Resource metrics | 501 on sandboxes → use `free -m`, `df -h`, `top -b -n1` via exec | S2 |
| Identity | exec as image `USER` (else root), cwd = `WORKDIR` (else `/`; v2 SDK default `/home/user`); `sudo` available | S2,S3 |
| Rate limits (requests/s) | not documented | [U] |

## 14. Billing

- Compute bills **per second while a sandbox is running**; hourly rate shown in the Console's Live Cost Estimate;
  inference bills per token via MaaS [V:S4]. Registering a template/agent is free [V:S4].
- **Pause:** "Free during Early Access" [V:S4 managing-your-deployment]; pause stops run time [V:S2]. After Early Access [U].
- **No balance/credit:** sandbox launches then stops within seconds [V:S2]; v2 shows billing pause/deletion codes [V:S1].
- **Prices are not public:** docs defer to the Console; gateway `GET /products` returns `price` per `instance_type`
  (needs a key; free read) [V:S2,S5]; v2 `/products` has no price [V:S1]. Earlier observation: a CE container 2 vCPU/4 GB
  was $0.0475/hr (S10, not a sandbox SKU). Snapshot storage, egress and paused-disk charges [U].
- A sandbox in the default (A) mode auto-renews for 24 h at a time → can bill indefinitely if forgotten [I from S2].
- Who pays: user's own copies bill the user; sessions you run for others bill you [V:S4].
- RESEARCH.md: balance updates lag spend; MCP `get_account_summary` covers LLM tokens only, so sandbox spend is not
  visible through the OAuth sign-in [I].

## 15. Security implications

1. **Compute key = spend authority for the whole org.** Store with `safeStorage` in main (like the inference key),
   never expose to the renderer, never log. Validate via `/me/api-keys/current` (`scope` must be `ce_resource`).
2. **Data-plane token, traffic token, `generated_api_key`** are secrets too; keep them in main-process memory (token)
   or the secure store (MaaS key; it is returned once). Renderer gets opaque sandbox handles only.
3. **Shell WS must run in main** (Node `ws`): A needs an `Authorization` header (browsers cannot set it), B refuses
   browser `Origin`s and wants `X-Access-Token`. Main owns the single attachment and multiplexes it (user keystrokes
   from xterm.js in the renderer, optional agent input) over IPC.
4. **Port previews are untrusted web content** (the agent may run arbitrary code): show them in a separate
   `WebContentsView` with its own persistent-less partition, `sandbox:true`, `contextIsolation:true`, no preload, no
   node; lock navigation to `^\d+-<sandbox_key>\.<domain>$`; deny `window.open` (open externally after confirm),
   permission requests, downloads (or prompt); never inject `X-Access-Token`; inject `traffic-access-token` only via
   that partition's `session.webRequest.onBeforeSendHeaders` for that exact host. Never iframe it inside the app renderer.
5. **Prefer `secure:true`** (v2) for preview ports; without it a leaked URL is a public endpoint. Rotation has no
   public endpoint → treat a leaked traffic token as "delete the sandbox".
6. **Egress control** (v2, create-time only): offer "locked network" for agent sandboxes (deny-all + allowlist: package
   registries, git hosts, `api.gmi-serving.com`) to limit exfiltration of repo code or secrets.
7. **Secrets:** pass via launch env with `secret:true` (A) / `env_vars` (B, not returned by detail [I]) or per-exec
   `envs`; never in command strings, metadata (org-visible), templates that get listed (Console flags "Private content
   found"), or snapshots (scrub `~/.config`, git credentials, caches before snapshotting).
8. **Org-wide visibility:** lists show every member's sandboxes; "delete by status" can kill colleagues' work. Tag
   ours (`metadata: {app: "gmi-desk", owner: <install-id>, thread: <id>}`) and only bulk-act on that filter.
9. **Shell runs as root** (A) and `sudo` is available; the sandbox is the isolation boundary. Still gate agent exec with
   the harness's permission policy (allow-list read-only commands, ask for writes/network/installs).
10. **Path validation** client-side too (absolute, normalized) before files calls; never let the model pick host paths.
11. **Cost guardrails** (D8 style): confirm every create/resume with the live hourly price; always set an explicit
    timeout; idle auto-pause; sweep orphans on startup; `Idempotency-Key` on create and exec to prevent double spend on
    retries.

## 16. Open questions

1. Are gateway-A tasks and v2 sandboxes the same records/IDs? Can v2 data-plane be used for v1-launched sandboxes (connect)?
2. Exact v1 `ports` object shape; does v1 `endpoint_url` equal `https://{sandbox_key}.{domain}`; are port previews
   reachable for v1 tasks, and can they be `secure`?
3. Which ports are routable on `{port}-{key}.{domain}` (any? HTTP only? WebSocket/HMR, SSE, long-polling? idle timeout?).
4. Shell keepalive/idle timeout for both WS protocols; behaviour on network drop (does the server free the single
   attachment immediately, or does a stale attach block reconnects until a timeout?).
5. Pause semantics per IDC (memory kept or cold start); is there a field telling which (`capabilities`?).
6. Prices per SKU/IDC, snapshot/paused-disk pricing, and the end of "pause is free" Early Access.
7. Request rate limits on control and data planes; org sandbox quotas by default.
8. Does v2 accept the MCP OAuth access token or only API keys/IAM tokens? (Ask GMI; RESEARCH "Asks" #2.)
9. Does the gateway exec accept `cwd`/`envs`/`execution_timeout_seconds` like v2?
10. Data-plane CORS (irrelevant if all calls stay in main, but matters for any renderer-side fetch).
11. Is the Agentbox shell (A) moving to the v2 binary protocol? (A is "Beta, may change".)

## 17. Implications for GMI Desk (recommendations)

1. **Two clients, one service slice** (`services/compute/agentbox/`): `GatewayClient` (A) for Agents/Marketplace,
   eligibility, IDCs, priced products, container-runtime agents and build logs; `SandboxV2Client` (B) for sandbox
   lifecycle, exec, files, shell and previews (richer and better specified: idempotency, egress, secure ports, binary
   PTY). Confirm open question 1 with free list calls before committing; until then each sandbox records which API made it.
2. **State machine in main, not the renderer:** one `SandboxSupervisor` per open sandbox: poll detail with backoff
   (1 s while transitional, 10-30 s steady; SSE `/stream` when on A), cache `{domain, sandbox_key, token, end_at}`,
   re-`connect` after resume/extend/401, surface `pause`/`deletion`/`failure` codes as user-facing reasons, emit typed
   events over IPC. Additive contract `contracts/compute.ts` (ground rule 8).
3. **Computer panel** = four lanes over one supervisor: (a) **terminal**: xterm.js ↔ IPC ↔ main `ws` (B: binary frames,
   resize via debounced `POST /shell/control`; A: JSON frames), reconnect with jittered backoff reusing the same session,
   "attached elsewhere" state on 409/`error`, a Close-session button that uses `control close` (never send `exit`);
   (b) **files**: lazy tree via exec (`find DIR -maxdepth 1 -printf '%y\t%s\t%T@\t%p\0'`), read/write via `/files`,
   uploads chunk-guarded (≤500 MB, `mkdir -p` first), downloads with Range only on `Accept-Ranges: bytes`;
   (c) **ports/previews**: detect listeners via exec (`ss -ltnpH`), show `{port}-{key}.{domain}` in a locked-down
   `WebContentsView` (§15.4); (d) **status/cost**: state badge, `end_at` countdown, live $/hr, pause/resume/extend/delete.
4. **Agent tools** (Code-tab harness) map 1:1 to the data plane: `sandbox_exec(command, cwd, env, timeout)` → `POST
   /executions?wait=true&wait_timeout_seconds=25` with `Idempotency-Key = tool_call_id`, then poll `GET` until terminal
   (stream progress to the UI); `read_file`/`write_file`/`list_dir`/`grep` (exec `rg` fallback `grep -rn`);
   `start_service(cmd, port)` = `nohup … > /tmp/<name>.log 2>&1 &` + port probe; `cancel`. Trim outputs for the model
   (head+tail with byte counts; flag `*_truncated`) and keep full output in a downloadable file. Respect the 10-exec cap
   with a per-sandbox semaphore. The agent never uses the shell (single attachment); it can optionally "type" into the
   user's terminal through main's multiplexer, visibly.
5. **Defaults for safety and cost:** explicit `timeout` (e.g. 1 h, extend on activity), `auto_pause:true` where the IDC
   allows it, `secure:true`, app metadata labels, orphan sweep at startup, confirm-before-create with price (from A's
   `/products`), budget integration with D8, and a mock mode (`GMI_DESK_MOCK=1`) with recorded fixtures for every shape
   above (sanitised ids, rule 6).
6. **Sandbox images for coding:** a GMI Desk base template (Ubuntu + git, ripgrep, node, python, bash, build tools) built
   once via v2 templates, then a per-repo **snapshot pool** (clone + install deps → snapshot → launch per thread). Scrub
   credentials before snapshots; pass tokens per launch. Remember `start_cmd` must terminate (v2) and resume may be cold.
7. **Before any live test** (needs the user's approval, ground rule 2): a Compute key pasted in Settings; free GETs first
   (eligibility, idcs, products+price, list tasks/sandboxes); then one SMALL sandbox with `timeout: 300` and metadata
   label, exercising exec/files/shell/port/pause/resume/snapshot/delete, and a sweep that deletes it whatever happens.
