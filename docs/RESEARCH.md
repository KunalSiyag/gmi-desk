# Research — verified facts (2026-10-31 / 11-01)

Condensed from the research run (6 researchers, each checked by an adversarial verifier) plus what the build and
review runs confirmed. The raw reports (~180 sourced findings) are kept by the maintainer, not in the repo.
**Fast-moving facts — re-verify before relying on them** (GMI scopes and feeds, package versions, T3/Droid status).

## GMI Cloud platform

### Products
Inference (MaaS: serverless/dedicated, OpenAI-compatible), GPU Compute / Cluster Engine (containers, bare metal,
K8s by request), **GMI Studio** (ComfyUI-based node workflow editor; published gallery workflows are also callable as
request-queue "workflow" models), **GMI Agentbox** (agent sandboxes + marketplace), **GMI Router** (automatic model
selection). Docs: https://docs.gmicloud.ai (Mintlify: `/llms.txt`, `<page>.md`).

### Credentials
| Credential | Created | Authorises |
|---|---|---|
| MCP OAuth (access + refresh, ES256, issuer `https://mcp.gmicloud.ai`) | "Sign in" in a client (browser consent names the org + scopes) | GMI MCP tools only. Grant fixed per org and per requested scopes (adding scopes = reconnect). |
| Inference API key (`ie_model`, HS256 JWT, optional expiry) | Console → Inference → API Keys (`/user-setting/ie/api-keys`) | `api.gmi-serving.com/v1/*`, GMI Router, request queue (`/api/v1/ie/requestqueue/apikey/*`) |
| Compute key (`ce_resource`) | Console → Compute → Access → API Keys (`/user-setting/ce/access/api-keys`) | Cluster Engine, Agentbox (`GMI_AGENTBOX_API_KEY`) |
| Console session (IAM JWT) | email+password+OTP (`/me/auth-tokens` → `/me/sessions`, `CE-ClientId` header) | Everything incl. minting keys (`POST /api/v1/organizations/{orgId}/api-keys`); console sign-in sends a Cloudflare Turnstile token; single-use refresh tokens; org key cap. Not used by the app. |

- OAuth metadata: `https://mcp.gmicloud.ai/.well-known/oauth-authorization-server` — endpoints `/authorize`,
  `/token`, `/register` (DCR), `/revoke`; PKCE S256; `token_endpoint_auth_methods_supported: ["none"]`;
  `client_id_metadata_document_supported: true`; `authorization_response_iss_parameter_supported: true`. Protected
  resource: `https://mcp.gmicloud.ai/mcp`. Scopes: `models:read generation:read generation:write billing:read
  profile:read support:write`. **No inference, API-key, Agentbox or subscription scope.**
- Validate a pasted key: `GET https://console.gmicloud.ai/api/v1/me/api-keys/current` (Bearer key) →
  `{"key":{"id","scope":"ie_model"|"ce_resource",...},"organization":{"id"}}`; 401 `{"group":"api-key","code":200|201}`
  (invalid / expired).
- Agentbox can also mint inference keys (agent created with `GMI_MODELS` returns `generated_api_key`), but that
  still needs a Compute key.

### GMI MCP server (`https://mcp.gmicloud.ai/mcp`, streamable HTTP)
Tools: `search_models` (kind llm|multimodal, modality, task, provider, query, limit ≤100), `get_model` (parameters
for media; LLMs return `parameters: null`), `estimate_generation` (free; **does not validate parameters**),
`submit_generation` (spends; identical requests dedupe unless `idempotency_nonce` changes; video returns a handle),
`get_generation`, `list_generations` (media only; records expire from `get_generation` after ~1–2 weeks),
`upload_media` (slot valid 15 min; PUT bytes with exact content type; result is a **public** URL),
`get_account_summary` (days 1–90: balance_usd, promotion_credit_usd [separate pool; absent = unknown], llm_* usage and
cost, top_models; **LLM tokens only**, media spend excluded), `search_docs`, `create_support_request` (every call
files a new ticket). Prices are list prices; charged = list × (1 − `discount_to_user`).
Error texts seen: `insufficient scope: [...] required`, `upstream_unavailable`, "token is no longer valid for its
organization" (→ reconnect).

### Inference API (`https://api.gmi-serving.com/v1`, Bearer inference key)
- `/chat/completions`: SSE with `stream_options.include_usage`; `delta.reasoning_content`; usage in the final chunk;
  `response_format: json_object` only (no json_schema); documented defaults `max_tokens` 2000 and
  `context_length_exceeded_behavior: truncate` (always send max_tokens). Reasoning knobs differ per family.
- `/responses` (OpenAI Responses API): documented for OpenAI models; `gpt-5.x-codex`, `gpt-5.4-pro`,
  `bytedance/seed-2.0-mini` are Responses-only. GMI recommends Responses for new projects.
- `/messages` (Anthropic-compatible, base URL `https://api.gmi-serving.com`): documented for Claude and MiniMax.
  GMI's live catalog listed **no** `anthropic/*` models on 2026-10-31 even though docs advertise them.
- `/models` requires a key (401 without). Docs list id/object/created/owned_by; the user's earlier code also reads
  `pricing.prompt/completion` and `discount_to_user`.
- Rate limits per organisation in TPM tiers (Tier 1 = 1M TPM; higher after $50/$500/$1000 top-ups).
- **A negative balance does not block generation**; balance updates lag spend.

### GMI Router (preview, free routing; you pay the selected model)
`POST https://console.gmicloud.ai/api/v1/ie/recommendation/autoroute` `{messages, mode: cost|balanced|quality,
stream}` (Bearer: API key or IAM token). Streaming is the default: chunks proxied, then a `routing_metadata` event,
then `[DONE]`; ≤1 backup model before the first token; non-stream returns `{model, message, routing_metadata:
{selected_model, task_type, selected_mode, fallback_models, recommendation_id}}`; `X-Recommendation-ID` header.
Unknown fields (tools, temperature, max_tokens) are ignored → plain chat only. `/recommendations` ranks without
generating. Org admins can disable Auto mode or restrict the pool.
Docs: https://docs.gmicloud.ai/inference-engine/gmi-router/gmi-router-overview

### Public, key-less catalog feeds (undocumented; no CORS; may change)
- `GET https://console.gmicloud.ai/api/v1/billing/model_prices` → `{modelPrices:[{modelName, billingType,
  chargeUnit, price, originPrice, percentageDiscount (hundredths of %), effectiveAt (price timestamp!), tiers...}]}`
  (micro-USD per 1M tokens; many UUID/test rows).
- `GET .../api/v1/ie/requestqueue/models` → 377 rows, 294 active (video 131, workflow 125, image 62, audio 26, plus
  15 language, 4 llm, 10 untyped and a few misc), with `price_info` (micro-USD per unit), `parameters` (non-empty for
  only 327 rows; fall back to MCP `get_model`), `modalities`, `status`, `model_metadata.visibility`, `delivery_mode`
  (17 sync), `created_at` (~1.9 MB; ~37 inactive test/probe rows).
- `GET .../api/v1/ie/app/featured-models/active` → 14 featured entries of mixed kinds (5 LLM, 5 audio, 2 image, 2 video;
  re-checked 2026-11-01) with `input_price`/`output_price`, origin prices and `percentage_discount`.
- `GET .../api/v1/ie/recommendation/leaderboard` → categories + ~21 models with quality/cost scores (publish_date is
  the same for all; not a release date).
- `GET .../api/v1/billing/studio-subscription-plan-items` → Studio plans.

### Parameter schemas (two shapes; normalised by `src/shared/lib/parameters.ts`)
MCP `get_model`: `{name, description, type, required, default, enum, min, max}`. Public feed: `{name, display_name,
description, type, required, default_value, order, options:[{value, display_name}], min_value, max_value, step}`.
Types: string text integer float number boolean enum image first_frame_image last_frame_image video audio json object
array. For image/video/audio, `max` = max number of items.

### Billing and subscriptions
Default: prepaid credits + pay-as-you-go (top-up bonuses, usage tiers). Subscriptions: **Coding Plan** (early access
since 2026-07-24, waitlist; Lite $9.99 / Standard $19.99 / Pro $59.99 / Max $199.99 per month; Standard models
"unlimited" with per-tier caps 40M/80M/500M/2000M tokens; Premium credits; still "one OpenAI-compatible key") and
**Studio plans** (Starter $19.99 → Ultimate $129.99 list). Plan status/entitlements/invoices are only available
through console-session APIs → the app deep-links to the console.

### Console deep links (unauthenticated visits go through sign-in and come back)
`/auth/sign-in?callbackUrl=<path>` with paths: `/user-setting/ie/api-keys`, `/user-setting/ce/access/api-keys`,
`/user-setting/ie/usage-billing/{credits-and-payment,invoices,subscription,usage/inference,usage/studio}`,
`/user-console/ie/my-workflows` (Studio), `/user-console/ie/gmi-router/test-routing`.
The console cannot be iframed (X-Frame-Options SAMEORIGIN); Google sign-in refuses embedded webviews.

### SDKs and integrations
No official GMI TypeScript SDK for non-chat products. Chat providers: `@ai-sdk/gmicloud` (Vercel), `@gmicloud/
ai-sdk-provider`. Agentbox: Python `gmi-agentbox-sdk` (beta, MIT), Go `github.com/GMISWE/agentbox-sdk-go` (beta, no
license file); Sandbox v2: Python `gmi-sandbox-sdk` 1.2.1 (MIT) + OpenAPI spec (docs `/api-spec/sandbox_api.yaml`).
Legacy Python `gmicloud` (stale; stores refresh token in plaintext). OpenAPI specs: `ias-public-api.yaml`,
`service_api.yaml`, `sandbox_api.yaml` under https://docs.gmicloud.ai/api-spec/. Third-party TS client
`@corsair-dev/gmicloud` (Apache-2.0, ~70 ops) can serve as reference. GMI docs have guides for Claude Code, Codex,
OpenCode and Factory Droid (`/coding-tools/*`).

## T3 Code (github.com/pingdotgg/t3code)
MIT; v0.1.6 (2026-10-31); ~1M non-test lines; 1,000+ commits/week; maintainers mostly not accepting contributions.
Not an LLM client: drives Codex (app-server), Claude Code (Agent SDK), Cursor, Grok, OpenCode (1.x limited, 2.x
full), Pi, Antigravity and any ACP Registry agent (incl. Factory Droid). Per-provider-instance env vars + custom
models let stock T3 use GMI today via OpenCode or Codex (`[model_providers.gmi]`, `wire_api = "responses"`).
Stack: Electron 44, React 19, Effect 4, TanStack Router, Base UI (shadcn "base-mira"), Tailwind 4, event-sourced
SQLite. Style tokens copied into this app: Inter/system sans + mono, zinc light theme, true-black dark theme, indigo
primary `oklch(0.488 0.217 264)` (dark `oklch(0.571 0.21 264)`), 0.5rem radius, 10–11px meta text, 52px top bar,
46rem chat column, 17.5rem detail panel, instant panels, ⌘K palette.

## Factory Droid SDK
`@factory/droid-sdk` 0.10.0 (TS, Apache-2.0) and `droid-sdk` 0.5.0 (Python) wrap the **proprietary** `droid` CLI
(npm `droid` 1.1.0, UNLICENSED). A Factory identity is required even for BYOK on every supported path (the public binary also honours an undocumented
`FACTORY_AIRGAP_ENABLED` switch that skips sign-in: unsupported, likely against Factory's terms, never ship with it) (GMI keys via `customModels`, provider
`generic-chat-completion-api`); BYOK is metered past an allowance; Factory terms forbid redistribution, serving third
parties and publishing benchmarks. Capable protocol (stream-jsonrpc in both SDKs; ACP and daemon/WebSocket only in the TS SDK; the ACP Registry and T3 Code
launch the hidden `--output-format acp-daemon`; permissions, sessions, MCP). Very
fast churn (24–28 releases in Oct 2026). Verdict: not the core runtime (see DECISIONS D4).

## Agent runtimes for a future Code tab
- **OpenCode** (MIT): `opencode serve` (HTTP + SSE) + SDK; config injectable via `OPENCODE_CONFIG_CONTENT` /
  `OPENCODE_CONFIG`, `{env:VAR}` substitution; built-in GMI provider (from models.dev) lists only ~17 of ~84 GMI LLMs,
  so generate the provider config from the live catalog (the app's OpenCode export already does). 1.x vs 2.x differ
  (2.x new server API, no LSP); isolate config/data dirs from the user's own install (1.18.35 on this machine).
- **Pi** (`@earendil-works/pi-coding-agent`, MIT): in-process or `--mode rpc`; extensions can register a provider with
  OAuth login + live model refresh; most explicit OpenAI-compatible knobs.
- **Codex app-server** (Apache-2.0): Responses API only for custom providers; supports `model_catalog_url`,
  command-supplied tokens and `gateway_oauth`.
- **Claude Agent SDK**: needs Anthropic Messages; only if GMI lists Claude models again; Anthropic terms apply.
- Good GMI coding models (Oct 2026, untested on tool loops): GLM-5.3, Kimi K2.7 Code / K3.1 Pro, DeepSeek V4 Pro,
  MiniMax M3, Qwen3.8 Max, GPT-6.1 Sol (premium); Flash variants for subagents. DeepSeek/Kimi/GLM need
  `reasoning_content` replayed in tool loops.

## Asks to GMI (would make the app fully key-less)
1. An inference scope on the OAuth server (or a PKCE key-provisioning / token-exchange flow).
2. OAuth access for Agentbox and GMI Router.
3. A read scope for subscriptions/credits/entitlements (Coding Plan, Studio plans, media spend).
4. A documented catalog endpoint with release dates and capability flags (tools, vision, reasoning format, max output).
5. Confirmation that third-party clients may use the MCP OAuth and the public console feeds; optionally MCP Apps UI.
