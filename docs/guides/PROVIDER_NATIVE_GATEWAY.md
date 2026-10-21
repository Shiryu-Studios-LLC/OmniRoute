---
title: "Provider-native HTTP and WebSocket gateway"
version: 3.8.52
lastUpdated: 2026-10-20
---

# Provider-native HTTP and WebSocket gateway

OmniRoute's normalized `/v1` APIs cover common model operations. Some providers,
including ComfyUI, also have a native UI, native API, and WebSocket protocol that
their browser, desktop, or MCP clients need. The provider-native gateway forwards
those requests through an explicitly enabled OmniRoute provider.

The gateway is disabled by default and binds to loopback. It never chooses an
upstream from a request path or query parameter: the public hostname is mapped to
a provider, and the target base URL comes from that provider's active connection.
Providers not listed in the mapping are not reachable through this listener.

## Configure a provider

Set the provider-to-host mapping in OmniRoute's runtime environment. A provider
can have multiple host aliases:

```dotenv
OMNIROUTE_PROVIDER_GATEWAYS='{"comfyui":["comfyui.shiryu.org","127.0.0.1"]}'
OMNIROUTE_PROVIDER_GATEWAY_HOST=127.0.0.1
OMNIROUTE_PROVIDER_GATEWAY_PORT=20133
```

The provider should have an active OmniRoute connection with its native upstream
URL saved in `providerSpecificData.baseUrl`; the provider's local catalog default
is used when that field is absent. For ComfyUI the default is normally
`http://localhost:8188`. Restart OmniRoute after changing the environment.

Configure the Cloudflare Tunnel hostname `comfyui.shiryu.org` to point to
`http://127.0.0.1:20133`, and protect it with Cloudflare Access. Keep the gateway
bound to loopback unless another trusted access layer is enforcing authentication.

## Point ComfyUI clients through OmniRoute

- Browser: open `https://comfyui.shiryu.org/`.
- ComfyUI Desktop: set its server URL to `https://comfyui.shiryu.org`.
- Local MCP client: set `COMFY_LOCAL_URL=http://127.0.0.1:20133`.
- Remote MCP bridge: set its ComfyUI URL to `https://comfyui.shiryu.org` and
  preserve the Cloudflare Access authentication it already uses to reach the bridge.

The gateway forwards ComfyUI's native endpoints and WebSocket upgrades, including
model inventory requests such as `/object_info`. Therefore those clients receive
the installed model and node information returned by the ComfyUI server through
the same provider connection. OmniRoute's normalized model catalog remains a
separate feature and does not turn every ComfyUI checkpoint into a chat model.

## Verify routing

Check OmniRoute startup logs for `[ProviderGateway] Listening` and request the
ComfyUI model metadata through the gateway:

```bash
curl -sS https://comfyui.shiryu.org/object_info
```

The gateway logs each provider and request path as `[ProviderGateway]` without
logging query strings, prompts, or request bodies. It does not add HTTP traffic to
OmniRoute's normalized `/v1` usage reports.

The gateway does not start when the provider map is missing or invalid. A host
that is not mapped receives `404 provider_gateway_not_configured`; a mapped
provider without an active base URL receives `503 provider_upstream_not_configured`.
