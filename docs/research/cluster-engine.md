# GMI Cluster Engine (CE) — containers, bare metal, networking, billing (research 2026-11-02)

Scope: what GMI Desk needs to build a **Compute tab** (CE containers; Agentbox sandboxes are in `agentbox.md`) and a
live "computer" panel. Nothing was created or paid. No GMI credential was used: every authenticated endpoint below
was checked only for its unauthenticated behaviour.

**Legend.** `[V:<src>]` verified on 2026-11-02 against the source; `[I]` inferred; `[U]` unverified/unknown.
Sources:
- **S-CE**: https://docs.gmicloud.ai/api-spec/service_api.yaml ("Cluster Engine API" 2.4.0, 2144 lines).
- **S-IDC**: `/api-spec/ids-public-api.yaml`. **S-IAM**: `/api-spec/ias-public-api.yaml` (IAM 2.4.0).
- **D:`<path>`**: `https://docs.gmicloud.ai/<path>.md`.
- **P**: a live probe, `curl -A "gmi-client-research/0.1"`, with no credential (fake bearers only in §2).
- **C**: the console's public JS bundle (`https://console.gmicloud.ai/_next/static/chunks/*.js` plus its lazily loaded
  `locales/en/{container,ce,order,template,elasticIp}.json` chunks), which holds the API clients, routes and UI strings.
- **MCP**: `mcp__gmi__search_docs`.

## 0. Key findings

1. **There is a public REST API for containers** at `https://console.gmicloud.ai/api/v1/containers`: list, create,
   get, reconfigure (PUT), delete, restart, logs (text download), shell URL, and products. Templates, images, bare
   metal, firewalls, elastic IPs and VPCs have the same kind of API. **No stop/start for containers**: they are k8s
   pods ("create Container under default namespace"). `[V:S-CE]`
2. **Auth is a bearer JWT; the CE key type is unconfirmed.** No credential →
   `401 {"code":200,"group":"api-key","message":"Invalid API key."}`; a malformed bearer →
   `401 {"code":2,"group":"auth","message":"Invalid access token.","traces":[...]}`, so the gateway checks the JWT
   signature itself `[V:P]`. Assumed credential: a Compute key (`ce_resource`, `/user-setting/ce/access/api-keys`)
   `[I]`. Untested: inference key (`ie_model`) or MCP OAuth token; both probably rejected `[U]`.
3. **Key-less public data is enough for a "browse and price" UI** `[V:P]`: `GET /api/v1/idcs` (28 data centres),
   `GET /api/v1/public/templates` (4 official templates), `GET /api/v1/billing/products` (67 SKUs, hourly list prices
   in micro-USD: 46 container, 9 MGCS, 6 sandbox, 2 bare metal, 2 EIP).
4. **Billing: you pay while a container exists, not while it is "used".**
   - **Pay-as-you-go** (paid from credits; only these can be terminated) or **Prepaid Plan** (fixed end time,
     renewable, no early termination). `[V:D:cluster-engine/resources/containers, C]`
   - EIPs and managed clusters are charged per minute `[V:D:…/elastic-ip, …/managed-gpu-clusters]`; containers are
     priced "per hour" in the UI, per-minute accrual likely `[I]`.
   - EIPs **keep billing when disassociated** and are **not released when a container is terminated**
     `[V:D:…/containers, …/elastic-ip]`. No public API returns CE spend `[V:C: /billing/ce/usage is session-only]`.
5. **Inbound access needs an EIP, then a firewall.** An EIP alone lets nothing in; every IDC has a preset "All Open"
   firewall (0.0.0.0/0); ports go through auto-assigned NodePorts; without an EIP you need a bastion.
   `[V:D:…/containers, …/firewalls, C]`
6. **Console-only (no public API):** MGCS requests (support processes them by hand), Slurm, prepaid purchase and
   renewal, persistent filesystem storage, live logs/events/metrics, entitlements and quotas. `[V:D, C]`
7. **Not available to every org.** Containers and Bare Metal are gated per organisation ("Contact support to enable").
   `[V:D:cluster-engine/index]`

## 1. Product map

| Product | What it is | Self-serve via API? |
|---|---|---|
| Container | Single GPU/CPU container from a template (vLLM, SGLang, JupyterLab, custom image) | Yes: `/v1/containers` `[V:S-CE]`. Org must be entitled `[V:D]` |
| Bare Metal | Dedicated host, full OS, IPMI-style actions | API exists (`POST /v1/baremetals`) `[V:S-CE]`; entitlement-gated; the 8×H200 node is $28/h `[V:P]` |
| Managed GPU Cluster (MGCS) | Managed Kubernetes with H200/B200/GB300 worker nodes | **No public API.** Console request form; "not processed automatically… contact support" `[V:D:…/managed-gpu-clusters]` |
| Slurm cluster | Console routes `/user-console/ce/slurm-clusters{,/create,/:id}` | No public API, no docs page `[V:C]` |
| Networking | Firewalls, Elastic IPs, VPCs (default VPC per IDC) | Yes `[V:S-CE]` |
| Fine-tuning | "Coming soon" | n/a `[V:D:cluster-engine/fine-tuning]` |

The marketing page lists H100 from $2.60, H200 from $3.20, B200 from $5.00 and GB200 from $8.00 per GPU-hour, with
GB300 on pre-order. The FAQ says: "calculated per GPU-hour"; dedicated single-tenant GPUs; "networking and storage
are provisioned separately". `[V: https://www.gmicloud.ai/en/pricing]`

## 2. Auth

| Credential | Works for CE? | Evidence |
|---|---|---|
| Compute API key `ce_resource` (Console → Compute → Access → API Keys, `/user-setting/ce/access/api-keys`) | **Assumed yes** `[I]` | Scope enum `ie_model\|ce_resource` in IAM `POST /organizations/{orgId}/api-keys` `[V: RESEARCH.md, 2026-10-31]`. The same page issues `GMI_AGENTBOX_API_KEY`/`GMI_SANDBOX_API_KEY` `[V:MCP agentbox-sdk/quickstart]` |
| Inference key `ie_model` | `[U]` (probably 401/403) | Not tested: no key in the session |
| MCP OAuth token (ES256, issuer `mcp.gmicloud.ai`) | `[U]` (probably rejected) | The gateway verifies the JWT signature itself (see below). Probing with forged tokens was refused as out of bounds, and the real token is a secret (ground rule 3) |
| Console session JWT (IAM) | Yes `[V:C]` | The console's `iaasModuleApiClient` (`baseURL:"/api"`) calls the same paths with `secure:!0` |

- The CE spec defines one scheme for everything: `bearerAuth` (`bearerFormat: JWT`). `[V:S-CE]`
- The IAM spec splits it: `bearerAuth` = "access token issued by session APIs", `bearerAPIKey` = "issued by api-keys
  APIs". `/me/ssh-keys` declares `bearerAuth`, so SSH keys may require a console session, not an API key. `[V:S-IAM]`
  Whether `/me/ssh-keys` accepts an API key is `[U]`.
- Check a pasted key's scope first: `GET https://console.gmicloud.ai/api/v1/me/api-keys/current`
  → `{key:{id,scope,…},organization:{id}}` (shape from RESEARCH.md). A Compute key must have `scope == "ce_resource"`.
  `[V:S-IAM line 792; P: no-auth → 401 api-key/200]`

Observed 401 bodies (all `[V:P]`, `GET /api/v1/containers`):

| Request | Body |
|---|---|
| no `Authorization` | `{"code":200,"group":"api-key","message":"Invalid API key."}` (identical to an invalid API key) |
| `Bearer not-a-key` / `Basic …` | `{"code":2,"group":"auth","message":"Invalid access token.","traces":["error: parse token string error (token is malformed: token contains an invalid number of segments)"]}` |
| `Bearer <HS256 JWT, wrong sig>` | same, with trace `token signature is invalid: signature is invalid` |

The spec documents a different shape: `{code:0|1, group:"auth_verify", message:"Invalid|Expired access token."}`.
A client must accept all of these shapes. `[V:S-CE components.responses.Unauthorized]`

## 3. Endpoints

Base URL for CE: `https://console.gmicloud.ai/api`. IDC and IAM: `https://console.gmicloud.ai/api/v1`.
Billing: `https://console.gmicloud.ai/api/v1/billing`.

All rows are `[V:S-CE]` unless marked. Common errors on every row: 401 / 404 / 500 / 503.

| Method | Path | Success response, extra codes, notes |
|---|---|---|
| GET | `/v1/containers` | `containersResp[]`. No pagination or filter parameters |
| POST | `/v1/containers` | `containerReq` → `200 [{id}]` (one per `count`). 400 / 403 ("tenant has no permission") |
| GET | `/v1/containers/{id}` | `containersResp` |
| PUT | `/v1/containers/{id}` | `containerConfig` → `{id}`. **Reconfigure: wipes all container data** `[V:D]`. 409 example `"timestamp mismatched"` |
| DELETE | `/v1/containers/{id}` | `Done` = `{result:"…"}`. Console: PAYG only, "Cannot terminate during creation or termination" `[V:C]` |
| POST | `/v1/containers/{id}/restart` | `Done`. Status passes through `terminating` `[V:D]` |
| GET | `/v1/containers/{id}/logs` | `text/plain`, the whole log (download; no follow, tail or since parameters) |
| POST | `/v1/containers/{id}/shell` | `{urlPath: uri-reference}`: "Generate container shell URL path". Protocol not documented `[U]` |
| GET | `/v1/containers/products?idc=` | `product[]`. Entitlement-filtered for the org `[I]` |
| GET / POST | `/v1/templates` | `templateResp[]` / create `template` → `{id}` (403 possible) |
| GET / PUT / DELETE | `/v1/templates/{id}` | PUT → `{modified}`, 409. Official templates are read-only `[V:C "Cannot edit official templates"]` |
| GET | `/v1/images?idc=&product=` · `/v1/images/{id}` | OS images (bare metal) |
| GET / POST | `/v1/baremetals?idc=` | create `BaremetalReq` → `[{id}]` |
| GET / PUT / DELETE | `/v1/baremetals/{id}` | PUT body `{name}` only |
| POST | `/v1/baremetals/{id}/actions` | `{type: start\|stop\|powercycle\|reboot}` |
| GET | `/v1/baremetals/products?idc=` | `product[]` |
| GET / POST | `/v1/elastic-ips` | allocate `{idc,count,name,product}` → `[{id}]`. "Go to Pay" in the console `[V:D]` |
| GET / DELETE | `/v1/elastic-ips/{id}` | release; 409 if still associated `[I]` |
| POST | `/v1/elastic-ips/{id}/associate` · `/disassociate` | `{instanceID, instanceType: baremetal\|container}`; 400 / 409 |
| GET | `/v1/elastic-ips/products?idc=` | `product[]` |
| GET / POST | `/v1/firewalls?idc=` | create `{idc,name,description?,inboundRules}` → `FirewallResp` |
| GET / PUT / DELETE | `/v1/firewalls/{id}` | delete only when nothing is associated `[V:D]` |
| POST | `/v1/firewalls/{id}/associate` · `/disassociate` | `{instances:[uuid], instanceType: baremetal(default)\|container}` |
| GET / POST | `/v1/vpcs?idc=` | POST `{idc}` = allocate default VPC |
| GET / DELETE | `/v1/vpcs/{id}` | |
| GET | `/api/v1/idcs` | **Public.** `{idcs:[{idcId,name,country,countrySubdivision,status: available\|full\|maintenance}]}` `[V:S-IDC, P]` |
| GET / POST | `/api/v1/me/ssh-keys?name=&fingerprint=` | `{keys:[{id,name,fingerprint(SHA256),createdAt(unix s)}]}`. POST `{name, sshKey}` → `201 {id}`. 403 `ssh-key/500` = per-user maximum reached `[V:S-IAM]` |
| PATCH / DELETE | `/api/v1/me/ssh-keys/{id}` | rename / delete own keys `[V:S-IAM]` |

**Not in the public spec but used by the console** (`[V:C]`, session-authenticated; API-key access `[U]`):
`/v1/managed-clusters/{requests,clusters{,/{id}/nodes}}`, `/v1/clusters`, `/v1/storage/filesystem` (persistent
volumes), `/v1/resources{,/check,/products}`, `/v1/product-quotas` (admin), and under `/api/v1/billing`: `quotas`,
`user/products`, `orders`, `order/price`, `orders/resources/extend`, `orders/update-termination`,
`resource/launch/verification`, `ce/usage`, `ce/options`, `promotions/ce-credits`. Never call `admin`/`internal` paths.

Public, key-less endpoints (`[V:P]`):
- `GET /api/v1/public/templates` → the 4 official templates.
- `GET /api/v1/billing/products[?dataCenter=<idc>]` → the full SKU catalogue. The filter works (42.9 KB → 3.6 KB).
- `GET /api/v1/billing/retail-prices` → per-GPU-type retail rows. They do not match the container SKU prices (see §6).
- `GET /api/v1/public/gpu-available` → returned **503** whose `reason` leaked an internal Kubernetes API address and
  timeout. Unreliable; do not use.

None of these responses carries rate-limit or CORS headers. They are Cloudflare-fronted and send
`x-frame-options: SAMEORIGIN` with CSP `frame-ancestors 'self' https:`. `[V:P]`

## 4. Schemas (S-CE, abridged)

```text
containerReq   = {count>=1, idc, product, ...containerConfig}            // required: count, idc, product, name, templateId
containerConfig= {name, templateId(uuid), command?:string, args?:string[], envs?:Env[], ports?:exposedPort[] (spec "maxLength 5"),
                  sshKeyIdList?:uuid[]}
Env            = {name: /^[a-zA-Z_][a-zA-Z0-9_]*$/ (<=4096), value: string (<=1 MiB)}
exposedPort    = {containerPort 0..65534, port? 0..65534 ("Listening Port"; console: "Auto-assigned" NodePort), protocol TCP|UDP}
Storage        = {id: uuid (persistent FS), containerPath: /^\/.+$/ (not "/")}
containersResp = containerReq-fields + {id, orgId, status, reason, createdAt, modifiedAt, storages[], firewalls[uuid],
                  eipId?, eipAddress?, inboundIP?, outboundIP?, publicIP?: {ipAddress, status: ready|pending|error|not_applicable}}
name           = /^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$/, <=255   idcName/productName = /^[a-zA-Z0-9._-]+$/
template       = {name, path (image URI, <=253, no spaces), description?, status draft|published(default)|unpublished,
                  credential?: {username, secret}}  templateResp += {id, official, orgId}
product        = {idc, name, type: Container|BareMetal|Storage|EIP, price:int, valid:bool, spec:object, gpuModel?, productLine?}
FirewallRule   = {protocol tcp|udp, portRange{min,max 1..65535}, remoteIpPrefix IPv4-CIDR, description?} | {protocol icmp|any, remoteIpPrefix}
FirewallResp   = {id, orgId, idc, name, description, inboundRules, assoInstances[], assoContainers[], isPreset, status active|building|error}
elasticIPResp  = {id, orgId, idc, name, ipAddress, product, internetConnectionType BGP|Dual-Homed, maxBandwidth("100 Gbps"),
                  status released|associated|disassociated, instanceID?, instanceType?}
BaremetalReq   = {idc, product, name, count, imageId, sshKeyIdList?, sshKey?, internalIp? (count=1 only), enableZabbixAgent=true}
BaremetalResp  = {id, orgId, idc, name, status, networks[{ip,type internal|external}], image, imageId, product,
                  associatedFirewalls[], createdAt, consoleReady, reason?}
```

**Secrets in responses.** `containersResp` echoes `envs`, which may hold tokens, `SSH_KEY` and so on (the spec's own
example is `access_token`). `templateResp` carries `credential.secret`, the registry password. `[V:S-CE]` (Public
templates return it empty `[V:P]`.)

SSH is configured in one of two ways:
- `sshKeyIdList` (IAM SSH key ids), or
- env `SSH_KEY=<public key>`. The API intro says SSH keys "must be provided as environment variables… no separate SSH
  key management API yet"; it predates `/me/ssh-keys`. `[V:D:api-reference/introduction]`

The login user is documented two ways: `ssh gmi@<ip>` (API intro) and `ssh root@<ip>` (SSH Keys page). The console's
dialog fills in `{{username}}`. `[V:C]` Treat the user as unknown until it is observed. `[U]`

The docs' example `product: "container.h200.x1"` and `idc` default `"us-denver-1"` look stale. The live catalogue
uses instance types such as `gmi.container.nv.H200x1.tw3` and has no container SKU in us-denver-1. `[V:P]`
That `product` = `/v1/containers/products[].name` = the billing feed's `instanceType` is `[I]`.

## 5. Lifecycles

**Container** status enum: `unknown | creating | running | terminating | stopped | error | zombie` `[V:S-CE]`.
- Docs and console show only Creating, Running, Terminating ("briefly during a restart") and Error. `[V:D, C]`
- `stopped` and `zombie` are not explained, and no API action produces `stopped`. `[U]`
- Inferred flows `[I]`:

```text
create ─► creating ─► running ─restart─► terminating ─► creating ─► running
              │           ├─PUT (reconfigure, data wiped)─► terminating ─► creating ─► …
              ▼           └─DELETE (PAYG only)─► terminating ─► (gone: 404)
            error  (reason field; "Check the logs")              prepaid: runs until end time; "Renew" = billing order
```

- Restart probably recreates the pod. Whether files outside a `storages` mount survive a restart is `[U]`. Assume
  they do not (ephemeral NVMe; "Reconfigure… all data… permanently LOST" `[V:D]`).
- No webhooks or event stream in the public API, so poll `GET /v1/containers/{id}` (or the list).
- The console polls orders and resources every 5 s while it waits. `[V:C refetchInterval 5e3]`

**Bare metal:**
- statuses: `creating, running, starting, stopping, stopped, rebooting, powercycling, rebuilding, error, deleting,
  deleted, unknown` `[V:S-CE]`
- actions: start, stop, reboot, powercycle; rename; delete
- whether it is billed while stopped: `[U]` (assume yes)

**Other resources:**
- **EIP:** allocate → `disassociated` ⇄ `associated` → release (must be disassociated first) → `released`. Billed in
  every state until released. `[V:D, S-CE]`
- **Firewall:** `building → active | error`. Preset "All Open" firewalls are `isPreset` and immutable. `[V:S-CE, D]`
- **Template:** `draft | published | unpublished`. `[V:S-CE]`
- **IDC:** `available | full | maintenance`. On 2026-11-02, 4 of 28 were in maintenance (singapore2, iowa2,
  taiwan2, taiwan3). `[V:P]`
- **MGCS request:** console tabs All / In Progress / Error and status pills Launching / Deleting; fulfilled by GMI
  support. `[V:D]`

## 6. Pricing and billing

Prices are micro-USD per hour: the Credit SKU is 1 000 000 = $1, and the console shows "Starting at … per hour".
`[V:P, C]` Representative live list prices (`/api/v1/billing/products`, 2026-11-02):

| SKU (`instanceType`) | IDC | Spec | $/h |
|---|---|---|---|
| `gmi.container.nv.H200x1.tw3` / `.sgp2` | asia-east-taiwan3 / asia-southeast-singapore2 | 1×H200, 24 vCPU (Xeon 8480+), 220 GiB, 2 TiB ephemeral NVMe | 3.35 |
| `gmi.container.nv.H200x8.*` | taiwan3 / singapore2 | 8×H200 | 26.80 |
| `gmi.container.nv.H100x{1,2,4,8}.{hybrid,wiextra}` | asia-east-taiwan1 | 1–8×H100 | 2.75 per GPU |
| `gmi.container.nv.5090x{1,8}.tw2` | asia-east-taiwan2 (in maintenance) | RTX 5090 | 0.80 per GPU |
| `gmi.container.intel.x4660.large` | us-central-iowa1…15 | CPU-only | 0.0475 |
| `gmi.bm.nh2.normal` (BareMetal) | us-denver-1 | 8×H200 node | 28.00 |
| MGCS nodes `gmi.bm.nh2.*` / `gmi.bm.nb2.aws1` | denver, japan, singapore, ohio | H200 / B200 nodes | 28.00 / 60.00 |
| EIP `gmi.sole.shared` / `gmi.eip.sole.shared` | us-denver-1 / taiwan1 | shared bandwidth | 0.10 |
| Sandbox `gmi.sandbox.{small,medium,large}` | us-central-iowa2/16 | Agentbox | 0.0911 / 0.18 / 0.36 |

- The public feed contains **customer-specific SKUs**: descriptions name third-party customers ("… only"). It also
  includes internal "for IE team" rows. Do not surface or store these descriptions, and treat `valid` plus the
  authenticated `/v1/containers/products?idc=` as the launchable set. `[V:P]` / `[I]`
- `/billing/retail-prices` lists H100 $2.98, H200 $4.50 (TW $3.98), B200 $4.00 and B300 $4.70, which do not match
  the SKU prices above. Purpose `[U]`; use the SKU price.
- Org discounts: the console shows "List Price, Discount, Estimated Total" `[V:D]`. A per-org price endpoint
  (`/billing/user/products`) is session-only `[V:C]`.
- Billing modes `[V:D, C]`: **PAYG** (no end date; required for Terminate) and **Prepaid Plan** (end time; Renew
  1 day–3 years; paid through an order; "not supported by EIP"). Invoices are "not provided for pay-as-you-go CE
  product purchases, as the invoice was already issued at the time of credit purchase", so PAYG CE is drawn from
  prepaid credits.
- **Per-minute** charging: stated for EIP and MGCS PAYG `[V:D]`; for containers `[I]`.
- What happens at zero or negative balance for running CE resources: `[U]`. Inference keeps working on a negative
  balance (RESEARCH.md). The console has `POST /billing/resource/launch/verification`, a pre-launch check
  `[V:C]`, `[I]`.
- **No API exposes CE spend to API keys or MCP.** MCP `get_account_summary` is LLM-only `[V: tool description]`.
  `/billing/ce/usage` is session-only `[V:C]`. The app must estimate spend itself and deep-link the usage page.
- Auto Pay can reload credits up to once per hour from a saved card. `[V:D:…/user-management/account]`

## 7. Networking, ports, shell, logs, metrics

- **To reach a container from outside:**
  1. Allocate an EIP in the same IDC.
  2. Associate the EIP with the container.
  3. Associate a firewall (same IDC) whose rules allow the port.

  Detach in reverse order. "On its own, an EIP does not allow any traffic through." Without an EIP: "set up a
  bastion server manually". Console create can "Auto-Create" an EIP. `[V:D:…/containers, C]`
- Ports: "accessible through automatically assigned NodePorts". The `port` (listening port) may be auto-assigned.
  SSH 22 and Jupyter 8888 are pre-exposed only by **official templates**. `[V:C, D]`
- Firewall rules are IPv4 CIDR only. Use `<user egress IP>/32` instead of the "All Open" preset, which GMI calls
  "not recommended for production". `[V:S-CE, D]`
- **Shell:** the console opens it in a tab ("Preparing shell…", "Shell isn't ready yet / took longer than expected
  to become reachable", "Session ended — reopen for a new session") with a **concurrent session limit** (number
  `[U]`) `[V:C]`. The API returns `urlPath` only; host, protocol (likely WebSocket/ttyd-style), token lifetime and
  single-use are `[U]` (the consuming page chunk loads only after sign-in).
- **Logs:** public API = full text download. The console also has a live **log stream** ("Log stream ended —
  reconnect to resume") with a **concurrent stream limit**; that endpoint is not public. `[V:C]`, `[U]`
- **Monitoring:** console only: CPU, memory, GPU, GPU memory, disk I/O, network RX/TX, an **Events** tab; ranges
  15m–30d. `[V:D, C]` No public endpoint `[U]`.

## 8. Limits and quotas

- Schema `[V:S-CE]`: names ≤255 characters (pattern above); envs ≤1 MiB each; ≤5 ports (written as `maxLength` on
  the array, so possibly unenforced `[U]`); firewall rule descriptions ≤255.
- Per-user SSH key cap: 403 `ssh-key/500` (number `[U]`). Org API-key cap: 400 "maximum number of API keys"
  (RESEARCH.md). `[V:S-IAM]`
- Concurrent shell and log-stream caps exist. `[V:C]` Values `[U]`.
- Org usage tiers: upgrades through support@gmicloud.ai. Product quotas are admin-managed (`/v1/product-quotas`,
  `/billing/quotas`). `[V:D, C]` Per-product container limits are `[U]`.
- **Rate limits:** none documented for CE (the docs rate-limit page covers inference only) and no headers observed.
  `[V:P, D]` Expect Cloudflare/WAF throttling. Back off on 429/503.
- `count` creates N containers per call; there is no idempotency key, so a retried POST can double-create (and
  double-bill). `[V:S-CE]` / `[I]`

## 9. Errors (handle all shapes)

| Shape | Where |
|---|---|
| `{reason, code?}` | CE 400 / 403 / 404 / 409 / 500 / 503, e.g. `resources.CPU is a required property`, `resource <id> was not found`, `access denied: tenant has no permission to do the operation`, `timestamp mismatched`, `An error occurred in the kubernetes cluster`, `database is unavailable` `[V:S-CE]` |
| `{group, code, message?, traces?, validationDetail?:[{field,expression,argument?,originalValue,reason}]}` | 401 everywhere; 400 validation (`group:"request"`); IAM and IDC errors, e.g. `idc/1201`, `ssh-key/500\|501\|1000` `[V:S-CE, S-IDC, S-IAM, P]` |
| `{"error":"missing_authorization_header"}` / `{"error":"Not found"}` | billing service / unknown `/api/*` path `[V:P]` |

`traces` holds raw internal messages, so log them at debug level only and never show them verbatim. `[I]`

## 10. Console-only actions and deep links

All console URLs go through `https://console.gmicloud.ai/auth/sign-in?callbackUrl=<encoded path>`. Example: a plain
GET of `/user-console/ce/containers` redirected to `…/auth/sign-in?callbackUrl=%2Fuser-console%2Fce%2Fcontainers`.
`[V:P]`

Routes `[V:C route table]` (prefix `/user-console/ce` unless shown):
- Compute Home (SKU catalogue): `/user-console/ce`.
- Containers: `/containers{,/create,/:id,/:id/{logs,monitor,shell,reconfigure,renew}}`. Templates:
  `/templates{,/create,/:id}`. Bare metal: `/bare-metals{,/create,/:bmId,/:bmId/renew}`.
- Managed clusters: `/managed-clusters/clusters{,/:clusterId}`, `/managed-clusters/requests`,
  `/managed-clusters/requests/cluster-requests/create?product=<sku>&idc=<idc>` (pre-fills the form `[V:D]`),
  `/managed-clusters/requests/node-requests/create`. Slurm: `/slurm-clusters{,/create,/:clusterId}`.
- Networking: `/firewalls{,/create,/:id,/:id/manage}`, `/elastic-ip{,/create,/:id}`, `/vpcs{,/:id}`.
- Settings: `/user-setting/ce/access/{api-keys,ssh-keys}`,
  `/user-setting/ce/usage-billing/{orders,orders/:orderId,usage,invoices,credits-and-payment,coupons}`.

The docs page `cluster-engine/user-management/api-keys` points to `/user-setting/api-keys`, a route that is not in
the console's route table, so it is stale. Use the `/ce/` or `/ie/` route. `[V:C]`

**Must stay in the console:** MGCS and node requests (support-processed), Slurm, prepaid purchase / renewal / order
payment, entitlement requests ("Contact Support"), persistent filesystem storage, SSH key creation if API keys are
refused (`[U]`), and live metrics / events / log streaming unless GMI documents them.

## 11. SDKs and reference clients

- **No official CE SDK.**
  - PyPI `gmicloud` 0.1.10 (2025-07-15, MIT) covers only IAM plus IE artifact/task/video; the wheel has no
    container code. `[V: pypi.org/pypi/gmicloud/json, wheel listing]`
  - GitHub `GMISWE` has `python-sdk` (that package) and `agentbox-sdk-go`, but no CE client. `[V: api.github.com/orgs/GMISWE/repos]`
- `@corsair-dev/gmicloud` 0.1.0 (Apache-2.0, published 2026-10-30) has generated wrappers per spec tag (baremetals,
  containers, elastic-ips, …). It adds nothing beyond the spec. `[V: npm registry + tarball listing]`
- **Recommendation:** generate types from `service_api.yaml` (pin a hash and diff it on upgrade) and keep a thin
  hand-written client in the main process.

## 12. Security implications

- **Blast radius.** A `ce_resource` key can create $28/h bare metal or many GPU containers (`count`), delete
  resources, open firewalls and read env secrets: far more dangerous than an inference key. Keep it in its own
  `ctx.secure` slot, never expose it to the renderer, agent tools or containers, and call CE from main only (no CORS
  anyway `[V:P]`).
- **Secret echo.** Envs and template registry credentials come back in GET responses. Redact
  `envs[].value` and `credential.secret` before logging, caching, IPC or fixtures. Never put the user's GMI keys into
  container envs without explicit consent, because anyone with the CE key or console access can read them back.
- **Network exposure.** Do not use the "All Open" preset by default. Create a per-container firewall that allows only
  the user's egress IP/32 and the specific ports. Prefer SSH port-forwarding over opening app ports. Remember the EIP
  ordering rule.
- **Shell URL.** Treat `urlPath` (it likely embeds a token) as a credential: never log it, open it only in an
  isolated session partition (or proxy it through main), expire it with the session.
- **Host keys.** Pin SSH host keys on first use per container id. Containers are recreated on restart or reconfigure,
  so expect key changes and re-prompt.
- **Cost safety.** No idempotency key, PAYG accrual while running, EIPs that outlive containers, no spend API. The app
  needs its own budget guard (see §13).
- **Third-party data.** The public product feed names other customers. Fixtures must strip descriptions and keep
  org ids sanitised (ground rule 6). Ignore the `/public/gpu-available` 503 body, which leaked internal infrastructure
  details.
- **Untested auth paths** (inference key, OAuth token): design for "Compute key required" and probe cheaply (one
  GET) once the user supplies a key.

## 13. Implications for GMI Desk

1. **Connect Compute flow** (mirrors Connect chat, D14): deep-link `/user-setting/ce/access/api-keys`; the user
   creates and pastes a key (clipboard detection as in D14); validate with `GET /api/v1/me/api-keys/current`
   (require `scope === "ce_resource"`), then one read-only `GET /api/v1/containers` (expect 200 `[]`, 401, or 403 if
   not entitled). Store it as `compute-key` in `ctx.secure`; the same key serves Agentbox/Sandbox.
2. **Read-only first (free), even signed out:** IDC picker from `/api/v1/idcs` (grey out maintenance/full), template
   gallery from `/api/v1/public/templates`, SKU/price browser from `/api/v1/billing/products?dataCenter=` (filter
   `productLine`, `valid`). Cache like the model catalogue (schedule plus offline cache). With a key, swap to
   `/v1/containers/products?idc=` and `/v1/templates` (org templates).
3. **Launch wizard:**
   - Pick template, IDC and SKU; name (pattern-validated plus a nonce suffix), envs, ports, SSH. Show **$/h, $/day
     and the budget impact** before confirm. Create with `count: 1`.
   - **Never auto-retry the POST.** On timeout or 5xx, list containers and match by the unique name first.
   - Explain EIP + firewall cost and ordering; offer "SSH only from my IP".
   - Hand off to the console for Prepaid, MGCS (`…/cluster-requests/create?product=&idc=`), Slurm, bare metal and
     entitlements.
4. **Status engine** (main): poll the container list every 5–10 s while anything is transitional, 60 s otherwise,
   jittered backoff on 429/5xx; map all 7 statuses and show `reason`. On startup and resume, reconcile all CE
   resources: orphaned containers and **unattached EIPs, which bill silently**.
5. **Budget guard for compute:** accrue runtime × price from local timestamps (no spend API); warn at thresholds;
   offer auto-terminate after idle or at a cap (PAYG only); quit guard "N containers still running ($x/h)";
   deep-link `/user-setting/ce/usage-billing/usage` for actual spend.
6. **"Computer" panel transport.** Preferred: **SSH** with an app-generated ed25519 key per container.
   - The private key stays in `ctx.secure`; the public key goes in env `SSH_KEY` (or `sshKeyIdList` if
     `/me/ssh-keys` accepts API keys).
   - One `ssh2` connection in main gives the PTY (xterm.js), SFTP (file tree, upload/download) and local port
     forwards for previews (`127.0.0.1:<rand>` → container port, in a sandboxed webview).
   - Needs port 22: an official template or an image with sshd, plus an EIP and a firewall limited to the user's
     IP/32. Fallbacks: the `/shell` urlPath (protocol TBD) for terminal-only use without an EIP; `/logs` download.
7. **Agent driving the computer:** agents get capability-scoped tools ("exec in container X", "read/write file",
   "open port preview") brokered by main, never the CE key. Create, delete, reconfigure, firewall changes and EIP
   allocation need explicit user approval with cost shown; reads are free. Rate-limit agent exec and audit-log
   every action (redacted).
8. **Prefer Agentbox sandboxes for the default agent "computer"**; offer CE containers as "attach my GPU box".
   Sandboxes are cheaper ($0.09–0.36/h), have pause/resume, snapshots, exec/file/PTY APIs and no EIP plumbing (see
   `agentbox.md`). CE containers have no stop/pause, lose data on reconfigure, and need networking for inbound access.
9. **Contracts:** new slice `compute` (`src/shared/contracts/compute.ts`); error mapper for the three error shapes
   and both 401 variants (→ `GmiError` codes `compute_unauthorized`, `compute_not_entitled` (403),
   `compute_conflict` (409), `compute_unavailable` (503)); mock fixtures sanitised (ids, IPs, envs).

## 14. Open questions (for a live check with the user's key, or for GMI)

1. Does a `ce_resource` key authorise `/api/v1/containers`, `/me/ssh-keys` and the firewall/EIP endpoints? Do
   `ie_model` keys or MCP OAuth tokens? (Each takes one free GET.)
2. What is `POST /containers/{id}/shell` `urlPath` (host, WebSocket protocol, auth, TTL, concurrency cap)? Are there
   public endpoints for live logs, events and metrics?
3. Is a container created via the API PAYG automatically, and is it gated by `resource/launch/verification` (minimum
   balance)? What happens at zero or negative balance: suspend, terminate, or keep running?
4. Billing granularity for containers (per minute?); whether stopped bare metal bills; when `stopped` and `zombie`
   occur.
5. Does `restart` preserve the ephemeral disk? Can API users create persistent `storages` (filesystem ids) without the
   console?
6. Is the SSH user `root` or `gmi`? Is a public IP (`publicIP`) ever assigned without an EIP in current IDCs?
7. Rate limits and per-org container quotas; the values of the shell and log-stream concurrency caps.
8. Ask to GMI: a `compute` OAuth scope (already in docs/GMI-ASK.md #6), an idempotency key on create, a documented
   price/estimate endpoint for API keys, and a CE spend read in MCP.
