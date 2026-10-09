/** Static local-only route matchers shared by Node and Worker-compatible code. */

export const LOCAL_ONLY_API_PREFIXES: ReadonlyArray<string> = [
  "/api/mcp/",
  "/api/cli-tools/runtime/",
  "/api/cli-tools/omp-settings", // spawns `which omp` to detect the CLI install (Hard Rules #15 + #17, #6318)
  "/api/cli-tools/letta-settings", // spawns `which letta` to detect the CLI install (Hard Rules #15 + #17, #6318)
  "/api/cli-tools/grok-build-settings", // GET calls getCliRuntimeStatus("grok-build"), which spawns a child process to locate + healthcheck the `grok` binary — same transitive-spawn surface that classified /api/skills/collect/ (Hard Rules #15 + #17). Writing ~/.grok/config.toml is inherently a local-machine operation, so loopback-only costs no real capability.
  "/api/cli-tools/forge-settings", // spawns via getCliRuntimeStatus() to detect the `forge` CLI install (Hard Rules #15 + #17, #7263)
  "/api/cli-tools/jcode-settings", // spawns via getCliRuntimeStatus() to detect the `jcode` CLI install (Hard Rules #15 + #17, #7263)
  "/api/cli-tools/qwen-settings", // GET probes the local `qwen` binary; writes target ~/.qwen config files (Hard Rules #15 + #17)
  "/api/services/", // T-10: embedded service lifecycle (spawn child processes)
  "/dashboard/providers/services/", // T-07: reverse proxy to embedded service UIs
  "/api/copilot/", // unauthenticated LLM driver — CLI-only by default; admins can opt-in to remote access via manage-scope bypass
  "/api/tools/agent-bridge/", // AgentBridge: spawns MITM server + DNS edits (Hard Rules #15 + #17)
  "/api/settings/mitm", // "Enable MITM" flow: installs a system-wide trusted root CA (security add-trusted-cert / certutil / update-ca-certificates) and writes /etc/hosts DNS overrides via src/mitm/* — host-level TLS interception. Was MANAGEMENT-only, so requireLogin=false left it remotely reachable (GHSA-x7vm-hp44-9p79, Hard Rules #15 + #17). Same tier as /api/tools/agent-bridge/.
  "/api/cli-tools/antigravity-mitm", // Antigravity MITM enable flow: same privileged CA-trust + DNS surface as /api/settings/mitm (GHSA-x7vm-hp44-9p79, Hard Rules #15 + #17). Covers the /alias child route by prefix.
  "/api/tools/traffic-inspector/", // Traffic Inspector: http-proxy listener + system proxy (Hard Rules #15 + #17)
  "/api/issue-agent/", // Issue Agent: recorded/local triage executor surface; keep loopback/LAN until sandbox + audit hardening is complete
  "/api/plugins/", // plugins: load/execute via worker_threads + child_process (Hard Rules #15 + #17)
  "/api/plugins", // bare path: GET list + POST install also trigger plugin loading
  "/api/middleware/", // SECURITY_AUDIT M8: middleware hooks compile+run arbitrary JS via new vm.Script (src/lib/middleware/registry.ts) on the request hot path — same code-exec class as /api/plugins/, so loopback-gate it for parity (Hard Rules #15 + #17)
  "/api/system/version", // auto-update: spawns git checkout + npm install — RCE-via-tunnel surface (Hard Rules #15 + #17, found by 6A.8 route-guard gate)
  "/api/db-backups/exportAll", // spawns tar for export archive (Hard Rules #15 + #17, found by 6A.8 route-guard gate)
  "/api/local/", // T-12: 1-click local service launchers (Redis today; spawns podman/docker) — loopback-enforced by isLocalRequestAllowed() in src/lib/security/localEndpoints.ts (Hard Rules #15 + #17)
  "/api/headroom/start", // Headroom token-saver proxy lifecycle: spawns headroom-ai python CLI (Hard Rules #15 + #17)
  "/api/headroom/stop", // Headroom token-saver proxy lifecycle: sends SIGTERM/SIGKILL to managed PID (Hard Rules #15 + #17)
  "/api/jobs", // JobRegistry control (enable/disable/run-now) + run history - runtime job administration, loopback-only (Hard Rules #15 + #17)
  "/api/jobs/", // sub-paths: /api/jobs/:id/{runs,enable,disable,run-now} (the bare `/api/jobs` above matches the list route; this matches children)
  "/api/oauth/cursor/auto-import", // spawns execFile("which", argv-array-of-one-arg "cursor") to verify a local Cursor install before importing creds — RCE-via-tunnel surface (Hard Rules #15 + #17, found by 6A.8 route-guard gate). Specific path only: the rest of /api/oauth/ (browser redirect/callback flows) must stay remote-reachable. Note: this comment intentionally avoids a literal closing square bracket character — check-openapi-security-tiers.mjs's naive regex parser for this array stops at the first one it finds, silently truncating its view of every entry after this one.
  "/api/oauth/kiro/auto-import", // reads host-local Kiro credential files (homedir kiro-cli data) — must reach the loopback-only gate, not the PUBLIC /api/oauth/ prefix (GHSA-wgwc-crjm-pmwv, GHSA-gxv4-955v-v6cm). Excluded from PUBLIC in publicApiRoutes.ts.
  "/api/oauth/raycast/auto-import", // reads host-local Raycast credential files — same loopback-only rationale as the kiro and cursor auto-import routes above.
  "/api/skills/collect/", // Skill Collector CLI detection: GET .../detect probes getCliRuntimeStatus() per CLI_TOOL_IDS entry, which spawns a child process to check each tool — RCE-via-tunnel surface (Hard Rules #15 + #17, PR #6294 review).
  "/api/discovery/", // Discovery tool (opt-in provider scanner): the scan route makes outbound probes to provider endpoints (SSRF-adjacent) and the whole surface is an admin research tool — strict-loopback only, no manage-scope bypass (NOT in LOCAL_ONLY_MANAGE_SCOPE_BYPASS_PREFIXES). See _tasks/features-v3.8.42/gaps/DISCOVERY_TOOL_DESIGN.md.
  "/api/vnc-session", // #7892: /api/vnc-session/* spawns Docker containers via child_process.spawn (src/lib/vncSession/service.ts) — RCE-via-tunnel surface (Hard Rules #15 + #17), same CVE class (GHSA-fhh6-4qxv-rpqj).
  "/api/acp/agents", // ACP custom-agent registry: POST registers a client-chosen `binary`; GET / POST {action:"refresh"} runs detectInstalledAgents() -> execFileSync(probe.command, probe.args, { shell }) transitively (src/lib/acp/registry.ts) — RCE-via-tunnel surface (Hard Rules #15 + #17, #7948)
  "/api/resilience/connections", // Per-account resilience state. NOTE: prefix matching also gates future /api/resilience/connections-* paths.
  "/dashboard/resilience/connections", // Per-account resilience state. NOTE: this endpoint is READ-ONLY (no child process spawn, unlike every other entry in this list); gated because it exposes per-account operational state (cooldown/breaker/lockout). Do not treat as precedent for non-spawning routes.
  "/api/providers/cursor/agent-availability", // credential-free dashboard-nudge check: spawns `cursor-agent status --format json` via checkCursorAgentAvailability()/getCachedCursorAgentAvailability() (src/lib/cursor/renewal.ts) — RCE-via-tunnel surface (Hard Rules #15 + #17). Narrow-scoped like /login and /refresh-cursor, not the whole /api/providers/ tree. Placed under /api/providers/ rather than /api/oauth/ because /api/oauth/ is PUBLIC-classified and never reaches this LOCAL_ONLY gate.
  "/api/modality-bridge/video/", // Video Bridge status + extraction broker; fixed ffmpeg/ffprobe subprocesses, strict loopback only (Hard Rules #15 + #17)
];

export const LOCAL_ONLY_API_REGEXES: ReadonlyArray<RegExp> = [
  /^\/api\/providers\/[^/]+\/login\/?$/,
  /^\/api\/providers\/volcengine-plan\/connect(\/.*)?$/, // manual headful flow + session-based phone/SMS auto-login (both spawn Playwright)
  /^\/api\/providers\/[^/]+\/refresh-cursor\/?$/,
  /^\/api\/providers\/[^/]+\/chatgpt-web-codex-doctor\/?$/,
];

/** Match only the static local-only prefix and regex contracts. */
export function isLocalOnlyPath(path: string): boolean {
  return (
    LOCAL_ONLY_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)) ||
    LOCAL_ONLY_API_REGEXES.some((pattern) => pattern.test(path))
  );
}
