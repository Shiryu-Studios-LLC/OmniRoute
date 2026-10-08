import { installLocalAgentSystemd, uninstallLocalAgentSystemd } from "../localAgentSystemd.mjs";
import { installLocalAgentLaunchd, uninstallLocalAgentLaunchd } from "../localAgentLaunchd.mjs";

const DEFAULT_CREDENTIAL_ENV = "SHIRYU_LOCAL_AGENT_CREDENTIAL";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CREDENTIAL_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requiredValue(value, envValue, label) {
  const resolved = typeof value === "string" && value.trim() ? value.trim() : envValue?.trim();
  if (!resolved) throw new Error(`Missing Local Agent ${label}`);
  return resolved;
}

function parseGatewayUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Local Agent gateway URL must be a valid HTTPS URL or loopback HTTP URL");
  }
  const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  const secureTransport = url.protocol === "https:" || (url.protocol === "http:" && loopbackHost);
  if (
    !secureTransport ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Local Agent gateway URL must be an HTTPS origin (HTTP is allowed only on loopback) without credentials or path data"
    );
  }
  return url.toString();
}

function optionalLocalUrl(value, envValue, label) {
  const resolved = typeof value === "string" && value.trim() ? value.trim() : envValue?.trim();
  if (!resolved) return undefined;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`${label} must be a valid HTTP URL`);
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be HTTP without credentials, query, or fragment`);
  }
  return url.toString();
}

function parsePositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) {
    throw new Error(`${label} must be an integer between 1 and 86400000`);
  }
  return parsed;
}

/** Resolve process configuration without persisting or displaying the credential. */
export function resolveLocalAgentConfig(options = {}, env = process.env) {
  const gatewayUrl = parseGatewayUrl(
    requiredValue(options.gatewayUrl, env.SHIRYU_LOCAL_AGENT_GATEWAY_URL, "gateway URL")
  );
  const deviceId = requiredValue(options.deviceId, env.SHIRYU_LOCAL_AGENT_DEVICE_ID, "device ID");
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Invalid Local Agent device ID");

  const credentialEnv = options.credentialEnv || DEFAULT_CREDENTIAL_ENV;
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv)) {
    throw new Error("Invalid Local Agent credential environment variable name");
  }
  const credential = env[credentialEnv];
  if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(credential)) {
    throw new Error(`Set a valid one-time device credential in ${credentialEnv}`);
  }

  const heartbeatIntervalMs = parsePositiveInteger(
    options.heartbeatIntervalMs ?? env.SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS,
    "Heartbeat interval"
  );
  return {
    gatewayUrl,
    deviceId,
    credential,
    ollamaUrl: optionalLocalUrl(options.ollamaUrl, env.SHIRYU_LOCAL_AGENT_OLLAMA_URL, "Ollama URL"),
    comfyUiUrl: optionalLocalUrl(
      options.comfyUiUrl,
      env.SHIRYU_LOCAL_AGENT_COMFYUI_URL,
      "ComfyUI URL"
    ),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
  };
}

async function runGatewayAgent(config, signal) {
  const [{ runLocalAgentWithGateway }, { createHttpLocalAgentGatewayTransport }] =
    await Promise.all([
      import("../../../src/lib/localAgent/runner.ts"),
      import("../../../src/lib/localAgent/httpGatewayTransport.ts"),
    ]);
  const fetch = globalThis.fetch;
  const gateway = createHttpLocalAgentGatewayTransport(config.gatewayUrl, { fetch });
  await runLocalAgentWithGateway(config, { fetch, gateway }, signal);
}

/** Run one outbound-only agent process, stopping cleanly when the OS signals it. */
export async function runLocalAgentCommand(
  options = {},
  { env = process.env, signalTarget = process, runAgent = runGatewayAgent } = {}
) {
  const config = resolveLocalAgentConfig(options, env);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  signalTarget.once("SIGINT", shutdown);
  signalTarget.once("SIGTERM", shutdown);
  try {
    await runAgent(config, controller.signal);
  } finally {
    signalTarget.removeListener("SIGINT", shutdown);
    signalTarget.removeListener("SIGTERM", shutdown);
  }
}

export function registerLocalAgent(program) {
  const localAgent = program
    .command("local-agent")
    .description("Manage a tenant-registered outbound Local Agent");

  localAgent
    .command("run")
    .description("Connect to the HTTPS gateway and serve discovered local capabilities")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .option("--device-id <id>", "Registered device ID (or SHIRYU_LOCAL_AGENT_DEVICE_ID)")
    .option(
      "--credential-env <name>",
      "Environment variable containing the one-time device credential",
      DEFAULT_CREDENTIAL_ENV
    )
    .option("--ollama-url <url>", "Local Ollama URL (or SHIRYU_LOCAL_AGENT_OLLAMA_URL)")
    .option("--comfyui-url <url>", "Local ComfyUI URL (or SHIRYU_LOCAL_AGENT_COMFYUI_URL)")
    .option(
      "--heartbeat-interval-ms <milliseconds>",
      "Heartbeat interval in milliseconds (or SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS)"
    )
    .action(async (options) => {
      try {
        await runLocalAgentCommand(options);
      } catch {
        // Errors from network or capability execution can contain request data. Keep the
        // process diagnostic generic and never print device credentials or request payloads.
        process.stderr.write("Local Agent stopped after a configuration or runtime error.\n");
        process.exitCode = 1;
      }
    });

  const service = localAgent
    .command("service")
    .description("Install or remove the per-user Local Agent service");
  const install = service
    .command("install")
    .description("Install and start a protected Linux systemd or macOS launchd user service")
    .option("--gateway-url <url>", "HTTPS gateway base URL (or SHIRYU_LOCAL_AGENT_GATEWAY_URL)")
    .option("--device-id <id>", "Registered device ID (or SHIRYU_LOCAL_AGENT_DEVICE_ID)")
    .option(
      "--credential-env <name>",
      "Environment variable containing the one-time device credential",
      DEFAULT_CREDENTIAL_ENV
    )
    .option("--ollama-url <url>", "Local Ollama URL (or SHIRYU_LOCAL_AGENT_OLLAMA_URL)")
    .option("--comfyui-url <url>", "Local ComfyUI URL (or SHIRYU_LOCAL_AGENT_COMFYUI_URL)")
    .option(
      "--heartbeat-interval-ms <milliseconds>",
      "Heartbeat interval in milliseconds (or SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS)"
    );
  install.action(async (options) => {
    try {
      const config = resolveLocalAgentConfig(options);
      const installed =
        process.platform === "darwin"
          ? installLocalAgentLaunchd(config)
          : installLocalAgentSystemd(config);
      process.stdout.write(`Local Agent service installed: ${installed.serviceName}\n`);
    } catch {
      process.stderr.write(
        "Local Agent service install failed; check systemd or launchd and configuration.\n"
      );
      process.exitCode = 1;
    }
  });

  service
    .command("uninstall")
    .description("Stop and remove the installed Local Agent user service")
    .action(() => {
      try {
        const removed =
          process.platform === "darwin"
            ? uninstallLocalAgentLaunchd()
            : uninstallLocalAgentSystemd();
        process.stdout.write(
          removed ? "Local Agent service removed.\n" : "Local Agent service is not installed.\n"
        );
      } catch {
        process.stderr.write(
          "Local Agent service uninstall failed; existing files were preserved.\n"
        );
        process.exitCode = 1;
      }
    });
}
