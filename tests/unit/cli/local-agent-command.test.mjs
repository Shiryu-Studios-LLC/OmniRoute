import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Command } from "commander";
import {
  registerLocalAgent,
  resolveLocalAgentConfig,
  runLocalAgentCommand,
} from "../../../bin/cli/commands/local-agent.mjs";

const credential = "a".repeat(43);

test("local-agent run is registered with explicit non-secret options", () => {
  const program = new Command();
  registerLocalAgent(program);

  const localAgent = program.commands.find((command) => command.name() === "local-agent");
  assert.ok(localAgent);
  const run = localAgent.commands.find((command) => command.name() === "run");
  assert.ok(run);
  assert.deepEqual(
    run.options.map((option) => option.long),
    [
      "--gateway-url",
      "--device-id",
      "--credential-env",
      "--ollama-url",
      "--comfyui-url",
      "--heartbeat-interval-ms",
    ]
  );
});

test("configuration accepts HTTPS cloud URL and reads credential only from its named env var", () => {
  const config = resolveLocalAgentConfig(
    {
      gatewayUrl: "https://connect.example.test",
      deviceId: "device_123",
      credentialEnv: "DEVICE_CREDENTIAL",
      heartbeatIntervalMs: "30000",
      ollamaUrl: "http://127.0.0.1:11434",
    },
    { DEVICE_CREDENTIAL: credential }
  );

  assert.deepEqual(config, {
    gatewayUrl: "https://connect.example.test/",
    deviceId: "device_123",
    credential,
    heartbeatIntervalMs: 30000,
    ollamaUrl: "http://127.0.0.1:11434/",
    comfyUiUrl: undefined,
    mcpServers: [],
  });
});

test("configuration accepts HTTP only for a loopback Local Agent gateway", () => {
  for (const gatewayUrl of [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]) {
    const config = resolveLocalAgentConfig(
      { gatewayUrl, deviceId: "local_device" },
      { SHIRYU_LOCAL_AGENT_CREDENTIAL: credential }
    );
    assert.equal(config.gatewayUrl, `${gatewayUrl}/`);
  }

  assert.throws(
    () =>
      resolveLocalAgentConfig(
        { gatewayUrl: "http://gateway.example.test", deviceId: "remote_device" },
        { SHIRYU_LOCAL_AGENT_CREDENTIAL: credential }
      ),
    /HTTP is allowed only on loopback/
  );
});

test("configuration supports the documented Local Agent environment variables", () => {
  const config = resolveLocalAgentConfig(
    {},
    {
      SHIRYU_LOCAL_AGENT_GATEWAY_URL: "https://connect.example.test",
      SHIRYU_LOCAL_AGENT_DEVICE_ID: "device_env",
      SHIRYU_LOCAL_AGENT_CREDENTIAL: credential,
      SHIRYU_LOCAL_AGENT_OLLAMA_URL: "http://localhost:11434",
      SHIRYU_LOCAL_AGENT_COMFYUI_URL: "http://192.168.1.20:8188",
      SHIRYU_LOCAL_AGENT_HEARTBEAT_INTERVAL_MS: "45000",
      SHIRYU_LOCAL_AGENT_MCP_SERVERS: JSON.stringify([
        { id: "docs", endpoint: "http://localhost:9911/mcp" },
      ]),
    }
  );

  assert.equal(config.gatewayUrl, "https://connect.example.test/");
  assert.equal(config.deviceId, "device_env");
  assert.equal(config.credential, credential);
  assert.equal(config.ollamaUrl, "http://localhost:11434/");
  assert.equal(config.comfyUiUrl, "http://192.168.1.20:8188/");
  assert.equal(config.heartbeatIntervalMs, 45000);
  assert.deepEqual(config.mcpServers, [{ id: "docs", endpoint: "http://localhost:9911/mcp" }]);
});

test("configuration rejects insecure gateway URLs, invalid credentials, and invalid local URLs", () => {
  const baseOptions = { gatewayUrl: "https://connect.example.test", deviceId: "device_123" };
  assert.throws(
    () =>
      resolveLocalAgentConfig(
        { ...baseOptions, gatewayUrl: "http://connect.example.test" },
        { SHIRYU_LOCAL_AGENT_CREDENTIAL: credential }
      ),
    /HTTPS origin/
  );
  assert.throws(() => resolveLocalAgentConfig(baseOptions, {}), /one-time device credential/);
  assert.throws(
    () =>
      resolveLocalAgentConfig(
        { ...baseOptions, ollamaUrl: "https://127.0.0.1:11434" },
        { SHIRYU_LOCAL_AGENT_CREDENTIAL: credential }
      ),
    /Ollama URL must be HTTP/
  );
  assert.throws(
    () =>
      resolveLocalAgentConfig(
        { ...baseOptions },
        {
          SHIRYU_LOCAL_AGENT_CREDENTIAL: credential,
          SHIRYU_LOCAL_AGENT_MCP_SERVERS: JSON.stringify([
            { id: "bad", endpoint: "http://192.168.1.5:9911/mcp" },
          ]),
        }
      ),
    /loopback HTTP\(S\) or public HTTPS/
  );
});

test("run command aborts the runner on SIGTERM and removes signal handlers", async () => {
  const signals = new EventEmitter();
  const configEnv = {
    SHIRYU_LOCAL_AGENT_GATEWAY_URL: "https://connect.example.test",
    SHIRYU_LOCAL_AGENT_DEVICE_ID: "device_123",
    SHIRYU_LOCAL_AGENT_CREDENTIAL: credential,
  };
  let observedConfig;
  const pending = runLocalAgentCommand(
    {},
    {
      env: configEnv,
      signalTarget: signals,
      runAgent: async (config, signal) => {
        observedConfig = config;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    }
  );

  signals.emit("SIGTERM");
  await pending;
  assert.equal(observedConfig.credential, credential);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
