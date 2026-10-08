---
title: "Cloud Customer OIDC Portal Sessions"
---

# Cloud customer OIDC portal sessions

Cloud Worker OIDC login is a portal identity mechanism. Its cookie does not authenticate
chat inference, provider management, device, or gateway APIs; those routes retain their
API-key or existing service-specific authentication.

## Deployment setting

Set `OMNIROUTE_CLOUD_PUBLIC_ORIGIN` to the exact public Worker origin, such as
`https://cloud.example.com`. The value must not include a path, query, fragment, username,
or trailing slash. Login, callback, and session introspection fail closed if it is absent
or invalid. Production requires HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`,
or `[::1]` in test, development, or local environments.

The manual staging workflow reads this non-secret value from the protected GitHub
Environment variable of the same name and requires it to match the isolated
`omniroute-cloud-runtime-staging.<account>.workers.dev` origin.

The setting is used to construct the fixed callback URI
`/__cloud/auth/oidc/callback` and the fixed successful-login redirect
`/__cloud/auth/session`. The login, callback, and session endpoints reject requests whose
URL origin differs from this configured origin. The session endpoint also rejects a
supplied `Origin` header unless it matches exactly.
Tenant OIDC configuration cannot set a callback or post-login redirect URI.

## Available routes

- `GET /__cloud/auth/oidc/login?tenant=<tenant-slug>` begins authorization for an active
  customer tenant with enabled OIDC configuration. The Worker discovers provider metadata,
  uses a short-lived one-time state and nonce, and requires PKCE with `S256`.
- `GET /__cloud/auth/oidc/callback` consumes that state once, exchanges the authorization
  code, verifies the ID token signature, issuer, audience, time claims, and nonce, then
  resolves only an exact issuer/subject link to an active tenant membership.
- `GET /__cloud/auth/session` returns the tenant, membership, and issuer for a valid
  customer portal session cookie. It does not return provider credentials or the external
  subject identifier.

The session cookie is `HttpOnly`, `SameSite=Lax`, scoped to `/__cloud/auth`, and expires
within eight hours. The database stores a hash of the opaque cookie token. Session
introspection checks tenant, membership, identity-link, and enabled-issuer state on every
request, so deactivating any of them immediately makes the session unusable. Browser writes
and additional portal APIs are not part of this slice; add them only after a CSRF and
portal authorization contract is defined.

## Issuer endpoint handling

OIDC discovery, token exchange, and JWKS retrieval use HTTPS endpoints from the tenant's
configured issuer metadata. The Worker rejects IP literals, local/internal hostnames,
its own public origin, redirects, and oversized metadata/token/JWKS responses. Supported
ID-token signing algorithms are limited to `RS256`, `ES256`, and `PS256`; advertised
algorithms outside that set are ignored. No email or domain claim creates a membership or
identity link.

Tenant issuer/client configuration and issuer/subject membership links are stored in
Cloudflare D1 by migration `0015_cloud_tenant_oidc.sql`; authorization state and portal
sessions are stored by `0016_cloud_tenant_oidc_sessions.sql`. OIDC client secrets and PKCE
verifiers are encrypted using the Worker credential encryption key.
