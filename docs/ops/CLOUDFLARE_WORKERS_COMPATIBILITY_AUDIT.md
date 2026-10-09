---
title: "Cloudflare Workers Compatibility Audit"
version: 3.8.50
lastUpdated: 2026-10-07
---

## Scope

This audit covers the current OmniRoute repository at the start of the Cloudflare production-readiness work. It is intentionally focused on the **Shiryu cloud control plane**, not on preserving every local/desktop feature inside a Worker.

## Initial findings

### Cloud-compatible target

The main API/routing architecture is a good candidate for Workers because the core request flow is HTTP/fetch/stream oriented:

```
HTTP request
  -> authentication
  -> tenant/policy checks
  -> routing/combo selection
  -> provider translation
  -> fetch upstream
  -> streaming/JSON response
```

The existing architecture already separates API routes, handlers, executors, translators, domain policy, and database domain modules. That gives us useful boundaries for a cloud runtime.

### Known blockers

The current application is **not Worker-ready as one bundle**.

1. **Database**
   - Current persistence is centered on local SQLite adapters and filesystem-backed state.
   - Production cloud runtime needs an asynchronous Cloudflare D1 adapter.
   - In-memory SQLite must not be treated as cloud production persistence.

2. **Filesystem**
   - Numerous modules use `fs`, `fs/promises`, `path`, and local data directories.
   - These must be excluded from the cloud request graph or replaced with cloud storage abstractions.

3. **Child processes / OS APIs**
   - Local tooling uses `child_process`, OS inspection, installers, process supervisors, and system configuration.
   - These are local-runtime features and must not enter the Worker bundle.

4. **Native modules**
   - The repository includes `better-sqlite3`, `sharp`, `tls-client-node`, Playwright, and other native/browser-oriented dependencies.
   - They must be isolated from the cloud request bundle unless a specific dependency is proven compatible and actually needed.

5. **Node server/network APIs**
   - Local MITM, live-server, browser-login, and some provider/session implementations use Node HTTP/TCP/TLS server APIs.
   - Cloud request paths must use Worker-supported Web APIs or an explicitly supported compatibility layer.

6. **Bundle size**
   - OmniRoute contains hundreds of provider executors plus local-only features.
   - We must measure the actual Worker bundle and avoid shipping the entire local application graph.

7. **Next.js build**
   - The current Next configuration is optimized for a standalone Node deployment.
   - A Cloudflare deployment target must be added without breaking the existing local/standalone build.

## Runtime classification

| Area                         | Target                       | Status                                |
| ---------------------------- | ---------------------------- | ------------------------------------- |
| OpenAI-compatible HTTP API   | Worker                       | Ready conceptually; needs cloud build |
| Authentication               | Worker                       | Adaptable                             |
| Tenant context               | Worker                       | Adaptable; verify request isolation   |
| Provider routing             | Worker                       | Adaptable                             |
| HTTP provider executors      | Worker                       | Candidate; audit each executor        |
| Streaming                    | Worker                       | Candidate                             |
| API-key policy               | Worker                       | Adaptable                             |
| Provider CRUD                | Worker + D1                  | Blocked on D1 adapter                 |
| Tenant/provider state        | Worker + D1                  | Blocked on D1 adapter                 |
| Cache                        | KV/DO/D1 as appropriate      | Needs classification                  |
| Rate limiting                | DO/KV/Cloudflare service     | Needs design                          |
| Circuit breakers             | D1/DO/KV                     | Needs design                          |
| MCP cloud transport          | Worker/DO                    | Needs classification                  |
| Local MCP                    | Local Agent                  | Do not move into Worker               |
| Ollama                       | Customer machine             | Local                                 |
| ComfyUI                      | Customer machine             | Local                                 |
| Local Agent                  | Customer machine             | Future                                |
| Device connections           | Durable Objects              | Future                                |
| `connect.shiryu.org`         | Cloudflare                   | Future                                |
| MITM proxy                   | Local-only                   | Exclude                               |
| OS/process management        | Local-only                   | Exclude                               |
| Desktop/Electron             | Local-only                   | Exclude                               |
| Local SQLite file            | Local-only                   | Replace for cloud                     |
| Cloudflare tunnel management | Local Agent/operator tooling | Exclude from cloud Worker             |

## Immediate engineering sequence

1. Create the cloud runtime boundary.
2. Build a minimal Worker-compatible health/API entry point.
3. Introduce the D1-capable asynchronous persistence boundary.
4. Make tenant/provider APIs use that boundary.
5. Audit provider executors transitively imported by the cloud route.
6. Add bundle-size and forbidden-import checks for the cloud build.
7. Produce a staging Worker.
8. Only then build the Local Agent connector against the verified cloud API.

## Cloud deployment principle

The GitHub repository should remain the source of truth. Cloudflare should build/deploy the verified cloud target from GitHub after the local compatibility work is complete.

The developer Linux machine remains useful for local development and customer-compute simulation, but the production cloud control plane must not depend on it.

## Phase 0/1 completion status

Phase 0 (compatibility audit) and Phase 1 (cloud runtime boundary) are complete for the **isolated cloud runtime boundary**.

Implemented in this cycle:

- `cloudflare/worker.ts` is the explicit Worker entry point.
- `src/cloud/runtime.ts` contains the first cloud-only runtime surface and imports no Node-only modules.
- `scripts/check/check-cloudflare-boundary.mjs` recursively checks the Worker entry graph for forbidden Node built-ins.
- `tests/unit/cloudflare-boundary.test.ts` verifies the Worker-safe health and runtime metadata endpoints.
- `wrangler.jsonc` provides a reproducible Worker build target.
- `open-next.config.ts` establishes the OpenNext deployment adapter for the eventual Next.js integration.
- Wrangler dry-run measured the isolated boundary at **1.38 KiB upload / 0.60 KiB gzip**.

The isolated Worker now includes tenant and customer APIs backed by D1, provider credential encryption, customer inference accounting, business profiles, device/gateway state, and scheduled maintenance records. Its latest Wrangler dry run bundles 95 inputs at 538,263 bytes (100,569 bytes gzip); this measures the standalone control plane, not the full OmniRoute application.

The full Next.js/OpenNext application build was reproduced on 2026-10-08. Next compiled and generated all 594 static pages, then OpenNext failed middleware bundling with 103 resolution errors, including `bun:sqlite`, native `keytar`/`koffi` modules, Playwright `chromium-bidi`, a generated TypeScript import, and `@opentelemetry/api`. The run emitted 227 filesystem-tracing warnings and grew `.next` to 7.4 GiB. The full application remains incompatible with Workers until its authorization and persistence graph is replaced with cloud-safe paths and local-only routes/features are isolated.

OpenNext's current Cloudflare compatibility matrix distinguishes Middleware from
Node.js Middleware: the former is supported, while the latter is not. OmniRoute
uses Next.js 16 `src/proxy.ts`, and
[`tests/unit/authz/proxy-contract.test.ts`](../../tests/unit/authz/proxy-contract.test.ts)
locks it to its Node runtime because its current pipeline imports SQLite-backed
auth and local-only policy modules. Supplying D1 through OpenNext's request
context would not make this Node-only proxy buildable. A custom Worker can wrap
the generated OpenNext fetch handler, but that wrapper alone does not remove the
proxy graph or preserve the centralized authorization contract. The cloud build
must replace that graph with a D1-backed authorization boundary before it can
delegate protected routes to OpenNext. The current Cloudflare D1 schema has no
parity tables for local `api_keys`, CLI access tokens, or dashboard login
settings; those identities and their existing role/scope checks must be
designed and tested before the local proxy is excluded.

This compatibility finding is based on the current
[OpenNext Cloudflare support matrix](https://opennext.js.org/cloudflare) and its
[custom Worker guide](https://opennext.js.org/cloudflare/howtos/custom-worker),
checked on 2026-10-08. The custom Worker guide describes wrapping the generated
fetch handler; it does not replace application authorization.

## Exit criteria for Phase 0/1

- A Worker-compatible entry point exists.
- The isolated cloud request path builds with Wrangler without local-only imports.
- Forbidden local-runtime imports are mechanically detected.
- The isolated Worker bundle size is measured.
- A cloud health endpoint is executable in the Worker runtime.
- OpenNext is configured as the initial Next.js integration target without replacing the existing local build.
- The full Next.js graph remains explicitly tracked as **not yet cloud-compatible** rather than being incorrectly treated as Worker-ready.

The asynchronous D1-capable boundary now exists for the isolated Worker APIs. The remaining Phase 12 blocker is the full Next/OpenNext request graph described above. Phase-by-phase implementation, test, deployment, and acceptance evidence is maintained in [`PHASE_3_TO_15_PROGRESS.md`](./PHASE_3_TO_15_PROGRESS.md) and [`CLOUDFLARE_WORKERS_PRODUCTION_PLAN.md`](./CLOUDFLARE_WORKERS_PRODUCTION_PLAN.md).
