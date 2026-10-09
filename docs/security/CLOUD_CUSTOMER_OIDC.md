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
`/__cloud/portal`. The login, callback, and session endpoints reject requests whose
URL origin differs from this configured origin. The session endpoint also rejects a
supplied `Origin` header unless it matches exactly.
Tenant OIDC configuration cannot set a callback or post-login redirect URI.

## Available routes

- `GET /__cloud/portal` serves the Worker-hosted customer portal. It uses the session and
  membership APIs below; those APIs remain the authorization authority. The page uses a
  per-response nonce Content Security Policy and does not display OIDC subjects or
  principal IDs.
- `GET /__cloud/auth/oidc/login?tenant=<tenant-slug>` begins authorization for an active
  customer tenant with enabled OIDC configuration. The Worker discovers provider metadata,
  uses a short-lived one-time state and nonce, and requires PKCE with `S256`.
- `GET /__cloud/auth/oidc/callback` consumes that state once, exchanges the authorization
  code, verifies the ID token signature, issuer, audience, time claims, and nonce, then
  resolves only an exact issuer/subject link to an active tenant membership.
- `GET /__cloud/auth/session` returns the tenant, membership, and issuer for a valid
  customer portal session cookie. It does not return provider credentials or the external
  subject identifier.
- `POST /__cloud/auth/logout` requires the exact configured `Origin`, revokes only the
  session whose cookie hash matches the caller, and expires the scoped HttpOnly session
  cookie. Missing or malformed cookies are handled idempotently without revoking a session.
- `GET /__cloud/auth/members?limit=<1–100>&cursor=<opaque>` lists tenant memberships for
  active owner/admin sessions. Pages contain membership ID, role, active state, and
  timestamps; they omit principal IDs and OIDC details.
- `PATCH /__cloud/auth/members/<membership-id>` accepts an exact same-origin JSON body with
  `expectedUpdatedAt` and at least one of `role` or `isActive`. The timestamp is a
  compare-and-set guard; stale writes return `409`. `role` may be admin, member, or viewer,
  and cannot promote a member to owner. Admins cannot modify owner rows. Owners retain the
  existing last-active-owner guard. The membership update, its conditional success audit,
  and deactivation's tenant API-key revocation execute in one D1 batch and roll back together
  if the audit write fails. The audit records membership ID and changed role/active fields
  without principal or OIDC subject data.
- `POST /__cloud/auth/members/invitations` accepts `{ "role": "admin" | "member" | "viewer" }`
  from a same-origin owner/admin portal session and returns a random invitation code once.
  Owner role cannot be granted by invitation. The code expires after 15 minutes and only
  its SHA-256 digest is stored.
- `POST /__cloud/auth/oidc/invitations/redeem` accepts `{ "code": "…" }` in a same-origin
  JSON request. It returns `{ "authorizationUrl": "…" }` and sets the one-use OIDC state
  cookie, allowing the portal to perform a top-level navigation without placing the
  invitation code in a URL. The authorization request uses the invitation tenant's
  currently enabled issuer.
- On callback, the Worker verifies the ID token before atomically consuming the invitation,
  creating the tenant membership, linking that exact issuer/subject, and writing the audit
  event. Issuer changes, expired/reused codes, existing identity conflicts, and inactive
  tenants fail closed. Email/domain claims do not select or create membership.

The platform-admin `POST /__cloud/v1/tenants/<tenant-id>/oidc/identities` mutation is
disabled. An administrator cannot attach an unverified issuer/subject to a membership;
identity links are created only by a verified OIDC callback, invitation redemption, or
first-owner claim.

The session cookie is `HttpOnly`, `SameSite=Lax`, scoped to `/__cloud/auth`, and expires
within eight hours. The database stores a hash of the opaque cookie token. Session
introspection checks tenant, membership, identity-link, enabled-issuer, and revocation state
on every request, so explicit logout or deactivating any of them immediately makes the
session unusable. Invitation
creation requires an exact same-origin POST and the active owner/admin session; the cookie
does not authorize existing API routes.

Owner/admin portal sessions can manage API keys attached to their own membership at
`/__cloud/auth/api-keys`: GET lists metadata, POST returns a newly issued token once, and
DELETE revokes one of that membership's keys. Members cannot list or issue keys through this
portal path. The raw token is not stored or written to audit; key creation/revocation and the
tenant-scoped audit row are committed together. Listing is tenant- and membership-scoped and
does not return tokens.

## Issuer endpoint handling

OIDC discovery, token exchange, and JWKS retrieval use HTTPS endpoints from the tenant's
configured issuer metadata. The Worker rejects IP literals, local/internal hostnames,
its own public origin, redirects, and oversized metadata/token/JWKS responses. Supported
ID-token signing algorithms are limited to `RS256`, `ES256`, and `PS256`; advertised
algorithms outside that set are ignored. No email or domain claim creates a membership or
identity link.

Tenant issuer/client configuration and issuer/subject membership links are stored in
Cloudflare D1 by migration `0015_cloud_tenant_oidc.sql`; authorization state and portal
sessions are stored by `0016_cloud_tenant_oidc_sessions.sql`; digest-only membership invites
and their OIDC callback binding are stored by `0018_cloud_tenant_membership_invitations.sql`.
OIDC client secrets and PKCE verifiers are encrypted using the Worker credential encryption
key. Customer OIDC issuer configuration remains platform-admin managed; tenant owners/admins
can invite members but cannot change the issuer or auto-link identities by email/domain. BYO
OIDC per tenant is the selected long-term direction. Customer-managed issuer changes should wait
for controlled outbound resolution and a verified first-owner recovery flow; keep the current
platform-admin configuration path available for break-glass recovery.
