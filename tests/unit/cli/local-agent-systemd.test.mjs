import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getLocalAgentSystemdStatus,
  installLocalAgentSystemd,
  startLocalAgentSystemd,
  stopLocalAgentSystemd,
  uninstallLocalAgentSystemd,
} from "../../../bin/cli/localAgentSystemd.mjs";

const credential = "a".repeat(43);

function createHome() {
  return mkdtempSync(join(tmpdir(), "omniroute-agent-service-"));
}

function serviceConfig() {
  return {
    gatewayUrl: "https://connect.example.test/",
    deviceId: "device_123",
    credential,
    ollamaUrl: "http://127.0.0.1:11434/",
    comfyUiUrl: undefined,
    heartbeatIntervalMs: 30_000,
  };
}

test("systemd install stores the credential in a protected env file, not the unit", () => {
  const home = createHome();
  const calls = [];
  try {
    const installed = installLocalAgentSystemd(serviceConfig(), {
      home,
      platform: "linux",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/omniroute/bin/omniroute.mjs",
      exec: (...args) => calls.push(args),
    });

    const environment = readFileSync(installed.envFile, "utf8");
    const unit = readFileSync(installed.unitFile, "utf8");
    assert.match(environment, new RegExp(`SHIRYU_LOCAL_AGENT_CREDENTIAL="${credential}"`));
    assert.equal(statSync(installed.envFile).mode & 0o777, 0o600);
    assert.equal(statSync(installed.unitFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".config", "omniroute")).mode & 0o777, 0o700);
    assert.ok(unit.includes("NoNewPrivileges=true"));
    assert.ok(unit.includes("PrivateTmp=true"));
    assert.ok(unit.includes("ProtectSystem=strict"));
    assert.ok(!unit.includes(credential));
    assert.deepEqual(
      calls.map((call) => call[1]),
      [
        ["--user", "daemon-reload"],
        ["--user", "enable", "--now", "omniroute-local-agent.service"],
      ]
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("systemd install refuses unmanaged units and restores files when activation fails", () => {
  const home = createHome();
  try {
    const unmanaged = join(home, ".config", "systemd", "user", "omniroute-local-agent.service");
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unmanaged, "[Service]\nExecStart=custom\n");
    assert.throws(
      () => installLocalAgentSystemd(serviceConfig(), { home, platform: "linux", exec: () => {} }),
      /unmanaged/
    );
    assert.equal(readFileSync(unmanaged, "utf8"), "[Service]\nExecStart=custom\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const rollbackHome = createHome();
  let invocation = 0;
  try {
    assert.throws(
      () =>
        installLocalAgentSystemd(serviceConfig(), {
          home: rollbackHome,
          platform: "linux",
          exec: () => {
            invocation += 1;
            if (invocation === 2) throw new Error("systemctl failed");
          },
        }),
      /systemctl failed/
    );
    assert.throws(
      () =>
        readFileSync(
          join(rollbackHome, ".config", "systemd", "user", "omniroute-local-agent.service")
        ),
      { code: "ENOENT" }
    );
  } finally {
    rmSync(rollbackHome, { recursive: true, force: true });
  }
});

test("systemd reinstall restarts the active managed service with updated configuration", () => {
  const home = createHome();
  const calls = [];
  try {
    installLocalAgentSystemd(serviceConfig(), {
      home,
      platform: "linux",
      exec: (...args) => calls.push(args),
    });
    calls.length = 0;
    const updated = serviceConfig();
    updated.credential = "b".repeat(43);
    installLocalAgentSystemd(updated, {
      home,
      platform: "linux",
      exec: (...args) => calls.push(args),
    });

    assert.deepEqual(
      calls.map((call) => call[1].slice(1)),
      [
        ["is-active", "--quiet", "omniroute-local-agent.service"],
        ["daemon-reload"],
        ["enable", "omniroute-local-agent.service"],
        ["restart", "omniroute-local-agent.service"],
      ]
    );
    assert.match(
      readFileSync(join(home, ".config", "omniroute", "local-agent.env"), "utf8"),
      /b{43}/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("systemd uninstalls a verified orphan environment file and rejects control chars in paths", () => {
  const home = createHome();
  try {
    installLocalAgentSystemd(serviceConfig(), {
      home,
      platform: "linux",
      exec: () => {},
    });
    rmSync(join(home, ".config", "systemd", "user", "omniroute-local-agent.service"));
    const calls = [];
    assert.equal(
      uninstallLocalAgentSystemd({ home, platform: "linux", exec: (...args) => calls.push(args) }),
      true
    );
    assert.deepEqual(calls[0][1], [
      "--user",
      "is-active",
      "--quiet",
      "omniroute-local-agent.service",
    ]);
    assert.deepEqual(calls[1][1], ["--user", "stop", "omniroute-local-agent.service"]);
    assert.throws(
      () =>
        installLocalAgentSystemd(serviceConfig(), {
          home,
          platform: "linux",
          cliPath: "/tmp/unsafe\nExecStart=/bin/sh",
          exec: () => {},
        }),
      /control character/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("systemd uninstall stops only the managed service before deleting its secret", () => {
  const home = createHome();
  const calls = [];
  try {
    const installed = installLocalAgentSystemd(serviceConfig(), {
      home,
      platform: "linux",
      exec: (...args) => calls.push(args),
    });
    calls.length = 0;
    assert.equal(
      uninstallLocalAgentSystemd({ home, platform: "linux", exec: (...args) => calls.push(args) }),
      true
    );
    assert.equal(calls[0][1].join(" "), "--user disable --now omniroute-local-agent.service");
    assert.throws(() => readFileSync(installed.envFile), { code: "ENOENT" });
    assert.throws(() => readFileSync(installed.unitFile), { code: "ENOENT" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("systemd lifecycle controls target only the managed per-user unit", () => {
  const home = createHome();
  const calls = [];
  let active = false;
  const exec = (_command, args) => {
    calls.push(args);
    if (args.includes("is-active")) {
      if (!active) throw Object.assign(new Error("inactive"), { status: 3 });
    } else if (args[1] === "start") {
      active = true;
    } else if (args[1] === "stop") {
      active = false;
    }
  };

  try {
    assert.deepEqual(getLocalAgentSystemdStatus({ home, platform: "linux", exec }), {
      installed: false,
      state: "not-installed",
    });
    assert.equal(startLocalAgentSystemd({ home, platform: "linux", exec }), false);
    installLocalAgentSystemd(serviceConfig(), { home, platform: "linux", exec });
    assert.deepEqual(getLocalAgentSystemdStatus({ home, platform: "linux", exec }), {
      installed: true,
      state: "inactive",
    });
    assert.equal(startLocalAgentSystemd({ home, platform: "linux", exec }), true);
    assert.deepEqual(getLocalAgentSystemdStatus({ home, platform: "linux", exec }), {
      installed: true,
      state: "active",
    });
    assert.equal(stopLocalAgentSystemd({ home, platform: "linux", exec }), true);
    assert.deepEqual(getLocalAgentSystemdStatus({ home, platform: "linux", exec }), {
      installed: true,
      state: "inactive",
    });
    assert.ok(
      calls.some((args) => args.join(" ") === "--user start omniroute-local-agent.service")
    );
    assert.ok(calls.some((args) => args.join(" ") === "--user stop omniroute-local-agent.service"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("systemd lifecycle controls reject an unmanaged unit", () => {
  const home = createHome();
  const unit = join(home, ".config", "systemd", "user", "omniroute-local-agent.service");
  try {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unit, "[Service]\nExecStart=custom\n");
    assert.throws(
      () => startLocalAgentSystemd({ home, platform: "linux", exec: () => {} }),
      /unmanaged/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
