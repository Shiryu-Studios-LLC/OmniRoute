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

### 5. MCP cloud runtime

- Tenant-scope MCP servers and credentials.
- Separate local MCP from cloud MCP.
- Define the cloud-safe MCP transport set.
- Route local MCP through the Local Agent when it requires customer-machine access.
- Ensure MCP execution cannot cross tenant boundaries.

**Exit:** tenant A cannot discover, connect to, or invoke tenant B MCP resources.

#### Egress decision (2026-10-08)

Cloudflare Workers VPC now offers a possible public-egress path: a VPC Network
binding to `cf1:network` can send Worker `fetch()` calls through Cloudflare
Gateway, where existing Gateway policies and logs apply. Workers VPC is in open
beta and documented as free during beta. The same `cf1:network` binding also
reaches every Tunnel, Mesh route, and WAN destination in the account, so it is
not a least-privilege MCP proxy by itself. Do not add this binding to the
production Worker until an isolated staging account/network has a verified
Gateway policy that blocks private destinations and restricts outbound
destinations; the current staging environment is not configured.

References: [Workers VPC overview](https://developers.cloudflare.com/workers-vpc/),
[VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/),
[Workers VPC pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/),
and [Worker egress through Gateway](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/).

### 6. Front Desk tenancy

- Front Desk identifies its tenant without exposing OmniRoute internals.
- Customer configuration is stored and applied to the correct tenant.
- Provider/model selection is tenant-scoped.
- Lead/business data remains tenant-scoped.
- Front Desk communicates with the cloud OmniRoute API rather than the developer machine.

**Exit:** two independent customer Front Desks can operate simultaneously against one OmniRoute deployment.

### 7. Customer provisioning

- Create customer tenant.
- Create owner/admin membership.
- Generate tenant-scoped credentials.
- The platform-admin tenant-create request requires an owner principal ID from an external verified identity flow; it creates the tenant, owner membership, and one-time API key with compensating rollback and an audit record. The Cloud runtime does not verify the owner's real-world identity itself.
- Configure provider defaults.
- Configure MCP defaults.
- Register devices.
- Provision Front Desk branding/configuration.
- Support suspend/revoke/delete lifecycle.

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
- Local MCP discovery/forwarding.
- Application-level capability reporting.
- The CLI supports `omniroute local-agent run` and Linux `service install` / `service uninstall`. The user-level systemd service stores its credential in an owner-only environment file and opens no inbound listener.

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

### 12. Bundle and feature isolation

- Keep the Worker bundle below the applicable Cloudflare limits.
- Prevent local-only providers/features from bloating the cloud deployment.
- Use service/module boundaries and lazy loading where appropriate.
- Verify that provider executors used by the cloud path use Web APIs or supported Worker-compatible primitives.

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
`OMNIROUTE_CLOUD_ADMIN_TOKEN`, `OMNIROUTE_CLOUD_MAINTENANCE_TOKEN`, and
`OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY`, and
`OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY`. Also set the non-secret GitHub
Environment variable `OMNIROUTE_CLOUD_PUBLIC_ORIGIN` to the exact HTTPS origin
for the isolated `omniroute-cloud-runtime-staging.<account>.workers.dev` host;
the workflow validates and binds it for the customer OIDC callback. Both cloud tokens must be distinct and
32–512 URL-safe characters. Both key secrets must be distinct base64-encoded
32-byte values. All four secrets are required by the manual staging workflow. The
admin token retains the full server-side cloud API scope. The maintenance token
is limited to customer tenant provisioning and tenant lifecycle inspection or
suspension/resumption; it cannot access provider, gateway, customer membership,
or API-key management routes. Tenant lifecycle mutation events, provisioning
request attempts, and successful owner-provisioning events are attributed to
`cloud-maintenance`. The workflow validates that tokens and key secrets differ, binds all four
through `wrangler secret put` using stdin, and checks that the maintenance token
works on a lifecycle route while being rejected on provider CRUD.

The credential key must be a base64-encoded 32-byte key used only for Cloud
credential envelopes; never reuse local `STORAGE_ENCRYPTION_KEY`. The idempotency HMAC key must be a different base64-encoded 32-byte secret.
Inference requests fail closed if this key is missing or invalid; provider
credential writes also fail closed if their encryption key is unavailable. The D1 ID must resolve through the Cloudflare API
to a database named exactly `omniroute-cloud-runtime-staging`. The workflow binds
the admin, maintenance, credential-encryption, and idempotency-HMAC secrets
through `wrangler secret put` using stdin. It applies pending D1
migrations and checks `/__cloud/health`, `/__cloud/db`, `/__cloud/readiness`, and
`/__cloud/runtime` after deployment. It also checks that the cloud admin API rejects
an unauthenticated request and accepts the configured token without creating a
resource. Readiness performs a D1 query and read-only Durable Object storage
access; the runtime check verifies the staging name and deployed commit SHA.

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
