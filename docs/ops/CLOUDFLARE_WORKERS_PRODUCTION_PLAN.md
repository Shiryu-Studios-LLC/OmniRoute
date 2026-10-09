---
title: "OmniRoute Cloudflare Workers Production Plan"
version: 3.8.50
lastUpdated: 2026-10-08
---

## Objective

Prepare OmniRoute to run the **Shiryu production control plane in Cloudflare** so the production Linux/customer machine is responsible only for local compute services such as Ollama and ComfyUI (and, later, the Shiryu Local Agent).

The target is **not** to force every existing OmniRoute feature into a Worker. Instead, the repository will have an explicit cloud-runtime boundary:

- **Cloudflare:** API gateway, authentication, tenant isolation, provider routing, model routing, streaming, management APIs, Front Desk APIs, persistent platform state, device/connector coordination, and cloud-safe MCP functionality.
- **Customer/local runtime:** Ollama, ComfyUI, local MCP services, Local Agent, OS/process/filesystem features, and other capabilities that require a real machine.
- **Optional local OmniRoute:** retained for developers/operators who want the full local application.

## Target production architecture

```
Customer Front Desk / Claude Code
             |
             v
       Cloudflare Worker
          OmniRoute
             |
     +-------+--------+
     |       |        |
     v       v        v
    D1      KV   Durable Objects
     |                |
 tenant/state     device connections
                      |
                      v
             connect.shiryu.org
                      |
             outbound connection
                      |
               Local Agent
                 /      \
             Ollama   ComfyUI
```

The same OmniRoute tenant/provider abstraction must support:

- `customer_managed`
- `shiryu_hosted`
- `third_party`

so customer GPUs can later be replaced by Shiryu-hosted infrastructure without changing the Front Desk contract.

## Workstreams

### 0. Cloudflare compatibility audit — COMPLETE

- Inventory all imports and runtime APIs used by the production request path.
- Classify code as Worker-safe, Worker-adaptable, or local-only.
- Identify all Node-only APIs, child processes, filesystem assumptions, native modules, persistent sockets, and local-only routes.
- Measure production bundle size and identify provider/feature code that must not ship in the Worker bundle.
- Define the cloud runtime entry point and service boundaries.
- Add explicit runtime guards for local-only capabilities.
- Produce a compatibility matrix and exit criteria.

**Exit:** a documented list of blockers with tests proving the selected production request path is Worker-compatible.

### 1. Cloud runtime boundary — COMPLETE (isolated boundary)

- Create a cloud-safe application/runtime entry point.
- Keep Next.js/OpenNext as the initial deployment target for the existing application.
- Avoid introducing a second routing implementation.
- Separate cloud control-plane code from local OS tooling.
- Keep local development fully functional.

**Exit:** cloud build can compile without importing local-only runtime modules.

### 2. Cloud database adapter — COMPLETE

- Introduce an asynchronous database boundary capable of targeting Cloudflare D1.
- Preserve the existing SQLite domain/migration model where practical.
- Map tenant, provider, credential metadata, combo, MCP, settings, usage, audit, and device state to persistent cloud storage.
- Define transaction/batch semantics explicitly.
- Keep local SQLite as the development/self-hosted adapter.
- Do not use in-memory SQLite as a production cloud persistence fallback.

**Complete:** src/cloud/db.ts defines the async D1-compatible persistence contract; src/cloud/tenants.ts provides asynchronous tenant lookup/provisioning; and src/cloud/providers.ts provides tenant-scoped provider connection and provider node CRUD. Cloud persistence keeps credentials as the encrypted representation supplied by the caller and never falls back to in-memory SQLite. Local SQLite remains the development/self-hosted adapter.

The Cloudflare boundary checker now scans the Worker entry graph and all src/cloud runtime modules for forbidden Node-only dependencies. Targeted D1 contract and tenant/provider CRUD tests cover asynchronous reads/writes plus A/B tenant isolation.

**Exit:** tenant and provider CRUD execute through the async D1 contract, with automated tenant-isolation coverage, without importing local-only runtime dependencies.

Cloud provider connection and node records also carry `credentialOwnership` and `executionLocation`. `credentialOwnership` is `customer_managed`, `shiryu_hosted`, or `third_party`; `executionLocation` is `customer_environment`, `shiryu_hosted`, or `third_party`. The server-side cloud CRUD API validates and returns these fields. Migration `0022_provider_execution_contract.sql` gives existing customer credentials the backward-compatible `customer_managed` plus `third_party` defaults. `shiryu_hosted` is currently an explicit placement value only; it does not enable or route to Shiryu-hosted GPU infrastructure.

### 3. Multi-tenant provider isolation — NEXT

Complete the existing `multi-tenant` foundation:

- Tenant-scope provider connections.
- Tenant-scope provider nodes.
- Tenant-scope combos.
- Tenant-scope raw/provider queries.
- Tenant-scope provider health and resilience state.
- Tenant-scope caches and runtime state.
- Prevent cross-tenant credential/provider leakage.

**Exit:** automated A/B tenant isolation tests pass for every provider/routing path.

### 4. API keys, authentication, authorization

- Make API-key tenancy authoritative.
- Add customer authentication and membership resolution.
- Enforce tenant + role on management operations.
- Keep Shiryu platform/maintenance access separate from customer access.
- Add privileged maintenance access with audit logging.
- Never expose customer credentials to browser clients.

**Exit:** customer, admin, and maintenance authorization tests pass.

**Current OIDC bootstrap:** BYO OIDC per tenant is the long-term direction. A
platform admin can issue or reissue a short-lived, one-use claim only for an
active tenant with enabled OIDC and no active owner. The Worker stores only the
claim digest. Redemption starts the tenant's configured OIDC flow; after the
existing issuer, signature, audience, nonce, and PKCE checks pass, D1 atomically
consumes the claim and creates the first owner, exact issuer/subject link, and
audit row. OIDC issuer configuration remains platform-admin-managed until
customer-controlled issuer setup has safe outbound resolution and recovery
controls. The platform-admin path remains the break-glass recovery path.
Migration `0020_cloud_tenant_oidc_owner_claims.sql` must be applied before
issuing or redeeming claims.

Tenant owners and admins can also save, review, replace, or delete an encrypted
pending issuer draft in the OIDC portal. Drafts are stored separately from the
active OIDC configuration; the Worker does not test the issuer, make outbound
discovery/token/JWKS requests, or use draft values for login. Migration
`0031_cloud_tenant_oidc_config_drafts.sql` must be applied before using this
portal feature. Activating a customer-managed issuer remains blocked on
controlled public egress and owner recovery.

### 5. MCP cloud runtime

- Tenant-scope MCP servers and credentials.
- Separate local MCP from cloud MCP.
- Define the cloud-safe MCP transport set.
- Route local MCP through the Local Agent when it requires customer-machine access.
- Ensure MCP execution cannot cross tenant boundaries.

**Exit:** tenant A cannot discover, connect to, or invoke tenant B MCP resources.

The Worker now has a D1-backed tenant MCP management registry at
`/__cloud/v1/customer/mcp-servers`. Owner/admin customer API keys can manage
tenant-owned configuration only when the tenant has opted into MCP. Credentials
are encrypted at rest and omitted from responses and audit records. Owners and
admins can also manage the same registry from the OIDC customer portal at
`/__cloud/auth/mcp-servers`; portal writes bind the active OIDC session and
current owner/admin membership in the audited D1 mutation. Public registry
requests still require customer API keys. The portal can create, edit, and
delete registrations, but does not expose discovery or invocation. The Worker
now has opt-in discovery and invocation routes backed by a dedicated Node
egress proxy. It sends tenant/server audit context and a short-lived
HMAC-signed request; the proxy enforces timestamp bounds, nonce replay checks,
payload/time limits, manual redirects, and the existing pinned public-IP
transport, and a per-Worker-identity request limit. D1 tests prove the egress flag defaults off, owner discovery and
invocation use only the selected tenant/server, and another tenant cannot
invoke that server. The route remains disabled unless the explicit runtime
egress flag, fixed VPC binding, and signing secret are configured. No VPC
service or staging account is configured, so discovery
and invocation remain disabled in deployed environments pending isolated
staging validation. Migration
`0019_cloud_tenant_mcp_servers.sql` must be applied before using the registry.

The Worker and Node proxy receive the same signing secret through their
respective runtime configuration, and the Worker binding must target the
dedicated VPC Service only. The current branch's production Wrangler config
does not include that binding or enable the egress flag.

The proxy process exposes `GET /healthz` as a no-store liveness response for a
private service or tunnel probe. It does not test DNS, upstream reachability,
or the outbound firewall. Keep this probe reachable only inside the proxy's
private service path. Start the process with its signing token, bind the
listener only to the dedicated proxy-side private interface, and do not
publish it on a public address. The default host is loopback (`127.0.0.1`)
until the private runtime explicitly supplies its interface address. With the
repository's dependencies installed, the process entry point is:

```sh
MCP_EGRESS_PROXY_TOKEN=<mcp-proxy-secret> OIDC_EGRESS_PROXY_TOKEN=<oidc-proxy-secret> HOST=<private-interface> PORT=8788 node --import tsx/esm cloudflare/mcp-egress-proxy/server.ts
```

The OIDC endpoint on this process accepts only authenticated discovery, token,
and JWKS requests whose target remains on the configured issuer origin. It uses
the same DNS-pinned Node transport, rejects redirects, and bounds request and
response sizes and time. `OIDC_EGRESS_PROXY_TOKEN` must match the Worker secret
`OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN`; keep it separate from the MCP token. If
the OIDC-specific variable is omitted, the process uses the MCP token for local
compatibility, but staging configuration requires the dedicated token. The
Worker does not call this endpoint unless its staging-only VPC Service binding,
matching token, and explicit enable flag are all present.

The proxy defaults to at most 32 in-flight upstream requests per process.
Set MCP_EGRESS_PROXY_MAX_IN_FLIGHT to an integer from 1 through 1000 to tune
that bound for the private proxy runtime. Requests at capacity receive a
retryable 503 proxy_busy; a timed-out request keeps its slot until the
transport operation actually settles, even if that transport ignores abort.

#### Egress decision (2026-10-08)

The least-privilege Cloudflare shape is a **VPC Service bound to one dedicated
MCP egress proxy**, not a Worker `fetch()` to a customer URL and not an
account-wide `cf1:network` binding. Cloudflare documents that a VPC Service
routes to its configured host and port regardless of the URL host supplied by
the Worker, and specifically describes this fixed-service scope as an SSRF
control. The proxy is the only origin the Worker can reach through this
binding. Keep the proxy behind a dedicated Cloudflare Tunnel; do not bind the
Worker to a customer network or to `cf1:network`.

The proxy is still a security boundary, not a transparent relay. It must use
the existing Node pinned-egress transport (or an equivalent implementation)
to resolve all A/AAAA records, reject the entire set if any answer is
non-public, connect only to that validated address set while retaining TLS
verification for the requested hostname, and reject redirects. Its host
network must have no route to customer/private networks and must block
loopback, private, link-local, shared, reserved, and metadata destinations at
the network layer, allowing outbound TCP 443 only. Bound request/response
sizes and time, rate-limit the Worker identity, and never log request bodies,
authorization headers, or credentials.

For tenant isolation, the Worker must derive the caller and tenant from
authenticated server-side state, authorize `invoke` against the requested
server, and fetch that server only with a tenant-qualified registry lookup.
The Worker sends a short-lived, authenticated proxy request carrying the
tenant and server identifiers for audit plus the already-authorized endpoint,
RPC body, and only that server's credential. The proxy accepts calls only
from the Worker service identity, treats tenant/server fields as audit
context rather than authorization by themselves, and does not persist
credentials. A/B tests prove a tenant A principal cannot resolve or invoke
tenant B's server. Proxy/runtime tests cover signature tampering, timestamp and
replay rejection, private literal destinations, redirects, payload bounds,
timeouts, and missing/unsafe endpoints; the pinned Node transport separately
rejects unsafe resolved address sets and ports. Isolated staging must still
prove service-binding scope, rebinding/mixed-DNS behavior, and network-layer
private/reserved-IP denials. If a customer MCP service is intentionally on a private customer
network, route it through that customer's authenticated Local Agent instead;
do not expand the shared Worker's network access to reach it.

Workers VPC is currently in beta. A VPC Network bound to `cf1:network` can
reach every Tunnel, Mesh route, and WAN destination in the account, even
though Gateway policies can filter public egress. It is too broad for this
boundary and must not be added to the production Worker. A VPC Service to a
dedicated proxy is the candidate to validate in isolated staging, including
service binding scope, Tunnel reachability, Gateway/network-layer egress
denials, and the proxy's connect-time pinning. The proxy and Worker adapter
source are implemented and unit-tested, but no VPC Service or staging account
is configured, so MCP invocation stays disabled.

References: [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/),
[Workers Binding API](https://developers.cloudflare.com/workers-vpc/api/),
[VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/),
and [Worker egress through Gateway](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/).

### 6. Front Desk tenancy

- Front Desk identifies its tenant without exposing OmniRoute internals.
- Customer configuration is stored and applied to the correct tenant.
- Provider/model selection is tenant-scoped.
- Lead/business data remains tenant-scoped.
- Front Desk communicates with the cloud OmniRoute API rather than the developer machine.
- Front Desk can opt a tenant into loading its business identity from the owner/admin-protected
  `/__cloud/v1/customer/business-profile` API. It fetches server-side with that tenant's customer
  key, validates the returned tenant and bounded public fields, caches per tenant, and falls back
  to that tenant's static profile on errors. This uses the configured OmniRoute URL and does not
  expose the customer key in `/business.json`.

**Exit:** two independent customer Front Desks can operate simultaneously against one OmniRoute deployment.

### 7. Customer provisioning

- Create customer tenant.
- Create owner/admin membership.
- Generate tenant-scoped credentials.
- The platform-admin tenant-create request supports either an owner principal ID from an external verified identity flow (creating the tenant, owner membership, and one-time API key) or explicit `bootstrapMode: "oidc_pending"` (creating the tenant and settings without an owner or key). The latter is followed by platform-admin OIDC configuration and first-owner claim issuance. Both paths have compensating rollback and audit records. The Cloud runtime does not verify real-world identity outside its configured OIDC callback.
- Configure provider connections through the owner/admin customer API or Worker portal. The portal
  uses the OIDC session to list, create, edit, deactivate, and revoke the fixed OpenAI contract;
  credential inputs are transient, encrypted at the Worker boundary, and never returned or audited.
  This does not grant inference entitlements, which remain default-deny until separately configured.
- Store and update a tenant-scoped Front Desk business identity through the owner/admin API;
  Front Desk can opt into reading it from OmniRoute.
- Owner/admins can also read and edit that profile in the Worker-served portal through their
  OIDC session. Writes require the same origin and commit the profile with a content-free audit.
- Configure MCP defaults.
- Register devices.
- Register verified Front Desk hosts and store tenant-specific runtime configuration through the
  Worker API; Front Desk resolves the exact host, then fetches its bounded configuration through a
  separate service token. Customer API keys and dashboard tokens are encrypted in D1 and omitted
  from admin listing responses. The Worker checks that the stored key and gateway device remain
  active before releasing configuration. The static Front Desk tenant configuration remains
  available for existing installations.
- Support suspend/revoke/delete lifecycle.

First-owner onboarding now has a platform-admin-issued, digest-only, one-use
OIDC claim flow. It is available only when the tenant has an enabled issuer and
no active owner; acceptance creates the first owner, identity link, and audit
record atomically. Provider self-service currently supports one fixed OpenAI
contract, and business identity storage is tenant-scoped with an opt-in Front
Desk consumer. Automated MCP provisioning, arbitrary provider defaults, Front
Desk branding, and end-to-end customer onboarding still require further work.
Dynamic Front Desk config retrieval requires a one-time shared service token in
OmniRoute and Front Desk secret stores; no customer-specific server file edits
are needed once a verified host and tenant config have been provisioned.
Customer owners/admins can now provision a host themselves in the OIDC Front
Desk portal: the portal issues a short-lived DNS TXT challenge, discloses the
value once, verifies it through the fixed resolver, and lists the tenant's
verified hosts. Tenant identity comes from the active portal session, and the
host can then be configured in the same portal. The platform-admin host API
remains available for break-glass registration. The portal flow is locally
tested; hosted DNS and staging deployment validation remain open.

**Exit:** a new tenant can be created without manually editing server files.

### 8. Shiryu Local Agent

Build the customer-side application:

- Device registration.
- Tenant/device binding.
- Secure outbound connection.
- Heartbeat/health.
- Reconnect/offline state.
- Device revocation.
- Ollama detection.
- Ollama optional installation/configuration.
- Model discovery and health checks.
- ComfyUI detection/connection.
- ComfyUI discovery requests metadata only for the checkpoint loader, sampler, and image saver nodes used by the supported image workflow, rather than downloading the full node catalogue.
- Local MCP discovery/forwarding.
- Application-level capability reporting.
- The CLI supports `omniroute local-agent run` and per-user service `install` / `uninstall` / `start` / `stop` / `status` commands on Linux (systemd), macOS (launchd), and Windows (Task Scheduler). Service credentials use protected OS storage or owner-only files; the agent opens no inbound listener.

The agent may manage `cloudflared` underneath, but Shiryu owns tenant identity and authorization.

**Exit:** a clean customer machine can onboard without port forwarding or public Ollama exposure.

### 9. `connect.shiryu.org` connector gateway

- Deploy the connector endpoint in Cloudflare.
- Use Durable Objects for long-lived device/session coordination where appropriate.
- Authenticate every device connection.
- Bind every connection to tenant + device identity.
- Support reconnect and revocation.
- Never expose customer Ollama/ComfyUI directly to the Internet.

**Exit:** Cloud OmniRoute can invoke an authorized customer-local capability through the agent while an unauthorized tenant is rejected.

### 10. Ollama and ComfyUI integration

- Standardize capability discovery.
- Normalize model/service metadata.
- Provide health/test endpoints through the agent.
- Support customer-managed compute first.
- Preserve the provider abstraction for future Shiryu-hosted compute.
- The Local Agent accepts only heartbeat-advertised capabilities and fixed local service URLs. Its ComfyUI image path polls a submitted prompt for at most 18 seconds and returns up to two validated image outputs within the gateway's bounded result envelope; larger outputs fail closed.

**Exit:** Front Desk -> OmniRoute -> connector -> agent -> Ollama/ComfyUI works end-to-end.

### 11. Cloud-native runtime services

Evaluate and use Cloudflare primitives only where needed:

- Workers for request/API execution.
- D1 for relational persistent state.
- Durable Objects for stateful device/connection coordination.
- KV for suitable low-latency configuration/cache reads.
- Queues for asynchronous jobs.
- R2 only where object/blob storage is appropriate.

Do not move local process management into Workers.

The scheduled Worker records cleanup-task start/end times, duration, and
success/failure in D1. Records contain only static task identifiers and are
pruned in bounded batches after 30 days. Ledger failures do not prevent cleanup
tasks or replace their failure result. A bounded read endpoint is restricted
to the platform-admin token; maintenance credentials cannot read the ledger.
Migration `0021_cloud_maintenance_runs.sql` must be applied before scheduled
maintenance telemetry is enabled.

### 12. Bundle and feature isolation

- Keep the Worker bundle below the applicable Cloudflare limits.
- Prevent local-only providers/features from bloating the cloud deployment.
- Use service/module boundaries and lazy loading where appropriate.
- Verify that provider executors used by the cloud path use Web APIs or supported Worker-compatible primitives.

The standalone Worker now forwards only the exact `/__cloud/v1/tenants` path
and its descendants to the D1 admin API handler. Unrelated and near-prefix
paths return 404 before any D1 operation. This preserves the isolated control
plane boundary; it does not provide the missing OpenNext application fallback
or resolve the Node/SQLite middleware graph documented in the compatibility
audit.

The latest Worker-only Wrangler dry run (2026-10-09, after the gateway
pre-auth rate-limit and tenant host-registry updates) bundles 97 inputs
(603,887 bytes; 111,498 bytes gzip; SHA-256
`bcbec2a7bdd39d847b57b629f678a41e49bcf8aef361c260375c9304d96d5240`) and
succeeds. The AST boundary check reports 43 reachable source files and 681,264
source bytes. It is a dry run; no deployment occurred. The full
`npm run cloudflare:open-next:build` run took 12m37: Next compiled and generated
594 static pages, then OpenNext failed middleware bundling with 103 resolution
errors, including `bun:sqlite`, native `keytar`/`koffi` modules, Playwright's
`chromium-bidi`, a generated TypeScript import, and `@opentelemetry/api`. It
also emitted 227 filesystem-tracing warnings. The standalone Worker dry run
therefore does not satisfy the full-app production build exit criterion.

OpenNext's current Cloudflare support matrix does not support Node.js
Middleware. OmniRoute's Next.js 16 `src/proxy.ts` is explicitly Node-only and
imports the local SQLite-backed authorization pipeline; the repository's proxy
contract tests keep it from being changed to an Edge runtime without a complete
replacement. A custom Worker wrapper around the generated OpenNext fetch
handler does not remove this middleware graph. The next Phase 12 implementation
must introduce and test a D1-backed authorization boundary before routing
protected application requests to OpenNext. Existing D1 identity storage covers
customer API keys and OIDC memberships, but not local API keys, CLI access
tokens, or dashboard login settings, so full policy parity remains incomplete.

**Exit:** production cloud build is reproducible and within size/runtime limits.

### 13. Security and isolation

Test:

- Tenant A -> Tenant A: allowed.
- Tenant B -> Tenant B: allowed.
- Tenant A -> Tenant B: blocked.
- API-key cross-use: blocked.
- MCP cross-use: blocked.
- Device cross-use: blocked.
- Provider credential cross-use: blocked.
- Cache cross-use: blocked.
- Settings cross-use: blocked.
- Maintenance access: privileged, explicit, audited.
- Local-only process routes: never remotely reachable.

### 14. Cloudflare deployment

The repository includes a manual-only GitHub Actions workflow at
`.github/workflows/deploy-cloudflare-staging.yml`. It deploys only the isolated
`omniroute-cloud-runtime-staging` Worker to its `workers.dev` address; it does not
configure production routes or custom domains. Configure a protected GitHub
Environment named `cloudflare-staging` with `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_STAGING_D1_DATABASE_ID`,
`OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN`,
`OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN`,
`OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN`,
`OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN`,
`OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN`,
`OMNIROUTE_CLOUD_MAINTENANCE_TOKEN`, and
`OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY`, and
`OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY`. Also set the non-secret GitHub
Environment variable `OMNIROUTE_CLOUD_PUBLIC_ORIGIN` to the exact HTTPS origin
for the isolated `omniroute-cloud-runtime-staging.<account>.workers.dev` host;
the workflow validates and binds it for the customer OIDC callback. Each of the
six operator tokens must be distinct and 32–512 URL-safe characters. The
identity token manages memberships, API keys, and OIDC configuration; the
inference token manages only tenant inference entitlements and budgets; the
lifecycle token manages tenant provisioning, lifecycle status, and maintenance
history; the tenant-hosts token manages verified customer-host administration;
the Front Desk token manages encrypted Front Desk configuration; and the
maintenance token is limited to tenant lifecycle status and cannot provision
customers.
The two key secrets must be distinct base64-encoded 32-byte values, and all
operator tokens must differ from both keys. All eight secrets are required by
the manual staging workflow. The legacy `OMNIROUTE_CLOUD_ADMIN_TOKEN` is
ignored in staging and production; it remains a local/test compatibility token.
The workflow binds each scoped secret through `wrangler secret put` using stdin
and checks successful use and cross-scope denial for the new route families.
Tenant lifecycle status audit rows identify the lifecycle or maintenance actor;
customer provisioning audit rows identify the lifecycle actor.

OIDC controlled egress is optional and disabled by default. To enable it only
in the isolated staging Worker, provide the GitHub Environment variable
`CLOUDFLARE_STAGING_OIDC_EGRESS_SERVICE_ID` as the UUID of the dedicated VPC
Service and the GitHub Environment secret
`OMNIROUTE_CLOUD_OIDC_EGRESS_TOKEN`. The service must target the private Node
egress proxy and the proxy process must receive the same value as
`OIDC_EGRESS_PROXY_TOKEN`. The workflow emits only a single `OIDC_EGRESS`
`vpc_services` binding in its temporary staging config and sets the runtime flag
only when both inputs are present; partial configuration fails before deploy.
The checked-in production Wrangler config remains without VPC bindings. Readiness
reports `oidcEgress: "disabled"` when off, `"ok"` when the enabled binding and
token are present, and fails closed when the flag is on with missing or invalid
configuration. An `ok` status proves configuration presence, not live issuer
reachability or network-firewall policy.

The credential key must be a base64-encoded 32-byte key used only for Cloud
credential envelopes; never reuse local `STORAGE_ENCRYPTION_KEY`. The idempotency
HMAC key must be a different base64-encoded 32-byte secret. Inference requests
fail closed if this key is missing or invalid; provider credential writes also
fail closed if their encryption key is unavailable. The D1 ID must resolve
through the Cloudflare API to a database named exactly
`omniroute-cloud-runtime-staging`. The workflow binds each scoped operator,
maintenance, credential-encryption, and idempotency-HMAC secret through
`wrangler secret put` using stdin. It applies pending D1 migrations and checks
`/__cloud/health`, `/__cloud/db`, `/__cloud/readiness`, and `/__cloud/runtime`
after deployment. It also verifies that the cloud API rejects unauthenticated
requests, each scoped credential reaches its assigned route family, and
cross-scope requests are denied. Readiness performs D1, Durable Object, and R2
probes; the runtime check verifies the staging name and deployed commit SHA.

### Worker customer inference subset

The Cloud Worker exposes a deliberately narrow `POST /v1/chat/completions`
subset in `src/cloud/inferenceCustomerHttpApi.ts`. It accepts one plain-text
`user` message for the pinned `gpt-4o-mini-2024-07-18` model. `stream:true`
returns bounded Chat Completions SSE from the fixed Responses API stream and
replays the exact bounded transcript for an idempotent retry. The Worker rejects
tools, other roles, extra fields, and customer-selected endpoints.
The Worker calls only OpenAI's fixed Responses input-token count endpoint and
Responses generation endpoint. The count preflight sends the message to OpenAI
and may be billable; it is required before reserving the tenant's exact input
count plus the requested output cap. Stream output is checked against the
terminal Responses text and usage before accounting is settled; the finish chunk
and `[DONE]` are emitted only after the success audit and transcript are stored.
Client cancellation aborts upstream and settles the reservation at its maximum.
Input/output caps and the monthly budget are token accounting only; they do not
cap monetary cost. The route replays completed responses for 24 hours and retains
compact idempotency keys for 30 days, after which keys may be reused.

The dedicated `OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY` must be distinct from the
credential-encryption key and remain stable for replay continuity across the
30-day retention window. Client idempotency-key identity is a stable SHA-256
digest, so rotating the HMAC secret cannot create a second claim or dispatch;
a request using the same key after rotation can instead conflict because its
request fingerprint changed. The Cloud Worker route is not the Next application
route documented in `docs/openapi.yaml`, and this bounded subset does not imply
full OpenAI Chat Completions compatibility.

Customer owner/admin API keys can read and update tenant-local-AI and MCP
opt-in flags at `PUT /__cloud/v1/customer/settings`. The route derives tenant
identity from the active D1 API-key membership, rejects writes from member and
viewer roles, rate-limits by tenant, and commits the settings update with a
tenant-scoped audit record. This configures feature availability only; it does
not provision provider credentials, MCP servers, Front Desk branding, or a
browser-based customer setup flow.

The OIDC customer portal provides owner/admin-only opt-in controls for both
Local AI and MCP. Each accepts only its own boolean, binds the active session
hash and current membership role in the D1 update, and audits the setting
atomically. Changing Local AI revokes existing Durable Object device sessions;
devices must reconnect before using the feature. The public settings endpoint
remains bearer API-key-only. Enabling MCP permits saved server configuration;
discovery and invocation remain separately disabled until controlled egress is
verified.

Owner/admin customer API keys can read `/__cloud/v1/customer/onboarding` for
nine tenant-derived boolean flags: active owner, OIDC configured/enabled,
active provider connection, configured business profile, enabled cloud
inference entitlement, at least one non-revoked Local Agent device, and Local
AI and MCP opt-ins. `businessProfileConfigured` becomes true after an
owner/admin saves the tenant's profile; a default profile row alone does not
count. The response contains no issuer URLs, provider names, device
identifiers, or credential values, rejects tenant selectors, and uses pre-auth
edge-IP plus tenant rate limits. This is a readiness view; it does not perform
owner identity verification or provider/MCP provisioning. The OIDC customer portal
now renders the same nine flags for owner/admin sessions using a read-only,
tenant-scoped route. OIDC setup and inference entitlement changes remain
platform-admin-only, and inference remains default-deny unless explicitly enabled.

After the repository is cloud-ready:

1. Push the verified branch to GitHub.
2. Connect the GitHub repository to Cloudflare.
3. Create the required Cloudflare resources.
4. Configure secrets through Cloudflare, never Git.
5. Deploy a staging Worker first.
6. Run cloud integration tests.
7. Cut traffic over only after validation.
8. Keep local OmniRoute available as a rollback/development target until production is proven.

#### Rollback and D1 recovery

The staging workflow does not automate rollback. Before each deployment, record the
last known-good Worker version ID and the D1 migration state. If a Worker version
fails its smoke checks, stop further promotion and roll the Worker back to the
recorded version using the Cloudflare dashboard or `wrangler rollback`. Worker
versions capture bindings and code, but do not restore D1 or Durable Object state;
see [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Treat schema and data recovery separately. Prefer a forward-only corrective
migration when the deployed schema remains compatible. For damaged D1 data or an
irreversible migration, first stop writes and preserve the current database state,
then select a known-good point-in-time and restore it with D1 Time Travel. A restore
overwrites the database in place and can discard writes made after the selected
point; rehearse the procedure against staging first. See
[Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
These recovery procedures are documented but have not been exercised against a
staging database.

### 15. End-to-end production validation

Required final path:

```
Customer Front Desk
      |
      v
Cloud OmniRoute
      |
      v
Tenant routing
      |
      v
connect.shiryu.org
      |
      v
Customer Local Agent
      |
      +---- Ollama
      |
      +---- ComfyUI
```

Two-tenant test:

- Customer A works.
- Customer B works.
- A cannot access B.
- B cannot access A.
- Device revocation immediately blocks access.
- Maintenance can diagnose/fix with audit trail.
- Customer compute can later be replaced by Shiryu-hosted compute without changing Front Desk APIs.

## Updated execution order

The original Local Agent-first sequence is intentionally changed.

**Do this first:**

1. Cloudflare compatibility audit.
2. Cloud runtime boundary.
3. D1 adapter.
4. Finish multi-tenant provider/MCP isolation.
5. Cloud auth/provisioning.
6. Cloudflare staging deployment.
7. Connector gateway.
8. Local Agent.
9. Ollama/ComfyUI automation.
10. Front Desk cloud tenancy.
11. Two-tenant end-to-end validation.
12. Production cutover.

## Definition of done

OmniRoute is production-ready when the **cloud control plane can run without the developer Linux machine**, customer-local compute can remain on customer hardware, all customer state is tenant-isolated, and the same Front Desk/OmniRoute contracts support both customer-managed and Shiryu-hosted compute.

The developer machine may still run Ollama/ComfyUI for development and testing, but production OmniRoute must not depend on that machine being online.
