import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  installLocalAgentLaunchd,
  uninstallLocalAgentLaunchd,
} from "../../../bin/cli/localAgentLaunchd.mjs";

const credential = "a".repeat(43);

function createHome() {
  return mkdtempSync(join(tmpdir(), "omniroute-agent-launchd-"));
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

test("launchd install stores a protected plist and starts the per-user LaunchAgent", () => {
  const home = createHome();
  const calls = [];
  try {
    const installed = installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/omniroute/bin/omniroute.mjs",
      exec: (...args) => calls.push(args),
    });

    const plist = readFileSync(installed.plistFile, "utf8");
    assert.match(plist, /<key>SHIRYU_LOCAL_AGENT_CREDENTIAL<\/key>/);
    assert.match(plist, new RegExp(`<string>${credential}<\\/string>`));
    assert.equal(statSync(installed.plistFile).mode & 0o777, 0o600);
    assert.match(plist, /<key>KeepAlive<\/key>/);
    assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.deepEqual(
      calls.map((call) => call[1]),
      [["bootstrap", "gui/501", installed.plistFile]]
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd update reloads only a managed plist and restores it if bootstrap fails", () => {
  const home = createHome();
  try {
    installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: () => {},
    });
    const plistFile = join(home, "Library", "LaunchAgents", "com.omniroute.local-agent.plist");
    const original = readFileSync(plistFile, "utf8");
    const calls = [];
    const changed = serviceConfig();
    changed.credential = "b".repeat(43);
    assert.throws(
      () =>
        installLocalAgentLaunchd(changed, {
          home,
          platform: "darwin",
          uid: 501,
          exec: (...args) => {
            calls.push(args);
            if (args[1][0] === "bootstrap") throw new Error("launchctl failed");
          },
        }),
      /launchctl failed/
    );
    assert.ok(calls.some((call) => call[1][0] === "bootout"));
    assert.equal(readFileSync(plistFile, "utf8"), original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd uninstall removes only its managed plist after bootout", () => {
  const home = createHome();
  const calls = [];
  try {
    const installed = installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: () => {},
    });
    assert.equal(
      uninstallLocalAgentLaunchd({
        home,
        platform: "darwin",
        uid: 501,
        exec: (...args) => calls.push(args),
      }),
      true
    );
    assert.equal(calls[0][1].join(" "), "print gui/501/com.omniroute.local-agent");
    assert.equal(calls[1][1].join(" "), "bootout gui/501/com.omniroute.local-agent");
    assert.equal(existsSync(installed.plistFile), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd uninstall preserves credentials when launchd state cannot be checked", () => {
  const home = createHome();
  try {
    const installed = installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: () => {},
    });
    assert.throws(
      () =>
        uninstallLocalAgentLaunchd({
          home,
          platform: "darwin",
          uid: 501,
          exec: () => {
            throw new Error("launchctl unavailable");
          },
        }),
      /Could not verify/
    );
    assert.equal(existsSync(installed.plistFile), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd refuses unmanaged files, unsafe paths, and root user domains", () => {
  const home = createHome();
  const plistFile = join(home, "Library", "LaunchAgents", "com.omniroute.local-agent.plist");
  try {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistFile, '<?xml version="1.0"?><plist/>');
    assert.throws(
      () => installLocalAgentLaunchd(serviceConfig(), { home, platform: "darwin", uid: 501 }),
      /unmanaged/
    );
    assert.throws(
      () => installLocalAgentLaunchd(serviceConfig(), { home, platform: "darwin", uid: 0 }),
      /non-root/
    );
    rmSync(plistFile);
    assert.throws(
      () =>
        installLocalAgentLaunchd(serviceConfig(), {
          home,
          platform: "darwin",
          uid: 501,
          cliPath: "/tmp/unsafe\nProgramArguments=/bin/sh",
        }),
      /control character/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
