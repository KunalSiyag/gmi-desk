# Proposal for GMI: let "Sign in with GMI" cover inference

_Written 2026-11-01 as feedback for GMI Cloud. Self-contained; can be forwarded as is._

## The problem

Third-party clients can already sign users in with GMI: GMI's MCP server is a standards-compliant OAuth 2.1
authorization server (`https://mcp.gmicloud.ai`: PKCE, dynamic client registration, refresh tokens, revocation).
That sign-in covers the model catalog, billing summary, media generation, docs and support.

It does **not** cover inference. `https://api.gmi-serving.com/v1/*` and the GMI Router only accept API keys, and the
OAuth server offers no inference scope. So every client still has to send users to the console to create a key, copy
it and paste it. That is the single biggest drop-off in onboarding.

## How others avoid keys

Factory (Droid) and Anthropic (Claude Code) never show a key: the user signs in, the client gets a session token, and
the vendor's own backend calls the model provider with the vendor's keys. Usage is metered per plan in rolling
windows (Factory: independent 5-hour, 7-day and 30-day windows; when they run out, a free open-weight pool and then
prepaid "extra usage" take over). This works because the vendor owns both the login and the inference endpoint.

**GMI owns both too** — the OAuth server and `api.gmi-serving.com` — so GMI can offer the same experience directly,
and the GMI Coding Plan (flat monthly tiers, Standard models with caps, Premium credits) is already the right billing
shape for it.

## The ask (any one of these removes the key step)

1. **Inference scope (preferred).** Add a scope such as `inference` to the OAuth server and accept access tokens with
   that scope (audience `https://api.gmi-serving.com`, RFC 8707 resource indicator) on `/v1/chat/completions`,
   `/v1/responses`, `/v1/models` and the Router's `/autoroute`. Bill the token's organization exactly like an API key
   (or the user's Coding Plan, if they have one).
2. **Key provisioning scope.** Add a `keys:write` scope and an MCP tool (or REST endpoint) that mints a named,
   expiring, revocable `ie_model` key for the calling client (e.g. "GMI Desk – <hostname>", 90 days), listed in the
   console like any other key. Clients store it in the OS keychain and rotate it before expiry.
3. **Token exchange.** RFC 8693: exchange an MCP access token for a short-lived inference token.

Nice to have, same effort class:

4. A `billing:read` view of **subscription entitlements** (Coding Plan tier, Standard cap used / remaining, Premium
   credits, reset dates) so clients can show plan limits the way Factory and Claude show their windows.
5. A documented **model catalog endpoint** with release dates and capability flags (tools, vision, reasoning format,
   max output), so "new model" badges and capability filters don't depend on undocumented console feeds.
6. Allow the Compute/Agentbox APIs to accept OAuth tokens (a `compute` scope) for agent-sandbox clients.

## What changes for users

Today: sign in → open console → create key → copy → paste → chat.
With (1): sign in → chat. With (2): sign in → one consent screen → chat (the client creates its own key).

## Client readiness

GMI Desk (unofficial client, Electron) is already prepared:

- it also requests the **inference and read-only key scopes the authorization server advertises** (names like
  `inference`, `chat`, `router`, `ie_model`, `keys:read`; never admin or write scopes), so a new inference scope is
  granted at the next sign-in without an app update (if GMI refuses them, it falls back to the six known scopes).
  Ask (2) would still need an app update: a `keys:write` scope is deliberately not requested, and minting needs a new
  call anyway;
- after sign-in it **probes** `GET /v1/models` with the OAuth token (at startup, after sign-in and once a day while
  the app is open); the moment GMI accepts it, chat and the Router switch to the sign-in automatically and the key
  step disappears. If chat or the Router then refuse the token (401, or 403 `insufficient_scope`), it goes back to
  asking for a key and does not trust the `/v1/models` answer again until the granted scopes change;
- **audience caveat:** today the probe reuses the MCP access token (resource `https://mcp.gmicloud.ai/mcp`). If GMI
  implements (1) with audience checks (resource `https://api.gmi-serving.com`), the client must first get an
  inference-audience token (a `refresh_token` grant with that `resource`) — a small follow-up once GMI publishes
  protected-resource metadata for `api.gmi-serving.com`;
- until then it guides users through creating a key and picks it up from the clipboard (with an explicit
  "Use this key" confirmation), so nobody has to paste.

Contact: the GMI Desk maintainer (GitHub issues on the repo).
