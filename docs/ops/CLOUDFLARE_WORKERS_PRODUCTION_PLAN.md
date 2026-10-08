---
title: "OmniRoute Cloudflare Workers Production Plan"
version: 3.8.50
lastUpdated: 2026-10-07
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

### 2. Cloud database adapter — IN PROGRESS (boundary established)

- Introduce an asynchronous database boundary capable of targeting Cloudflare D1.
- Preserve the existing SQLite domain/migration model where practical.
- Map tenant, provider, credential metadata, combo, MCP, settings, usage, audit, and device state to persistent cloud storage.
- Define transaction/batch semantics explicitly.
- Keep local SQLite as the development/self-hosted adapter.
- Do not use in-memory SQLite as a production cloud persistence fallback.

**Current:** src/cloud/db.ts now defines the async cloud persistence contract and the Worker exposes /__cloud/db for a D1 connectivity check. Local SQLite remains unchanged. The next increment must move tenant/provider repositories onto this boundary and add a real D1 integration test.

**Exit:** tenant and provider CRUD can execute against D1 in a cloud-runtime integration test.

### 3. Multi-tenant provider isolation

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

After the repository is cloud-ready:

1. Push the verified branch to GitHub.
2. Connect the GitHub repository to Cloudflare.
3. Create the required Cloudflare resources.
4. Configure secrets through Cloudflare, never Git.
5. Deploy a staging Worker first.
6. Run cloud integration tests.
7. Cut traffic over only after validation.
8. Keep local OmniRoute available as a rollback/development target until production is proven.

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
