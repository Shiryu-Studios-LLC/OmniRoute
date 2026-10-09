import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getLocalAgentLaunchdStatus,
  installLocalAgentLaunchd,
  startLocalAgentLaunchd,
  stopLocalAgentLaunchd,
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

function launchctlInitiallyUnloaded(calls = []) {
  return (command, args, options) => {
    calls.push([command, args, options]);
    if (args[0] === "print" && args[1].endsWith("/com.omniroute.local-agent")) {
      throw Object.assign(new Error("service not loaded"), { status: 113 });
    }
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
      exec: launchctlInitiallyUnloaded(calls),
    });

    const plist = readFileSync(installed.plistFile, "utf8");
    assert.match(plist, /<key>SHIRYU_LOCAL_AGENT_CREDENTIAL<\/key>/);
    assert.match(plist, new RegExp(`<string>${credential}<\\/string>`));
    assert.equal(statSync(installed.plistFile).mode & 0o777, 0o600);
    assert.match(plist, /<key>KeepAlive<\/key>/);
    assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.deepEqual(
      calls.map((call) => call[1]),
      [
        ["print", "gui/501/com.omniroute.local-agent"],
        ["print", "gui/501"],
        ["bootstrap", "gui/501", installed.plistFile],
      ]
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
      exec: launchctlInitiallyUnloaded(),
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
      exec: launchctlInitiallyUnloaded(),
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
      exec: launchctlInitiallyUnloaded(),
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

test("launchd rejects plist and directory symlinks and never follows a predictable temp link", () => {
  const home = createHome();
  const plistFile = join(home, "Library", "LaunchAgents", "com.omniroute.local-agent.plist");
  const secretTarget = join(home, "external-target.txt");
  try {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(secretTarget, "untouched");
    symlinkSync(secretTarget, plistFile);
    assert.throws(
      () => installLocalAgentLaunchd(serviceConfig(), { home, platform: "darwin", uid: 501 }),
      /safely open/
    );
    assert.equal(readFileSync(secretTarget, "utf8"), "untouched");
    rmSync(plistFile);

    const predictableTemp = `${plistFile}.tmp-${process.pid}`;
    symlinkSync(secretTarget, predictableTemp);
    installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: launchctlInitiallyUnloaded(),
    });
    assert.equal(readFileSync(secretTarget, "utf8"), "untouched");
    assert.equal(existsSync(predictableTemp), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const directoryHome = createHome();
  const outside = createHome();
  try {
    symlinkSync(outside, join(directoryHome, "Library"));
    assert.throws(
      () =>
        installLocalAgentLaunchd(serviceConfig(), {
          home: directoryHome,
          platform: "darwin",
          uid: 501,
        }),
      /LaunchAgents path/
    );
    assert.equal(existsSync(join(outside, "LaunchAgents")), false);
  } finally {
    rmSync(directoryHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("launchd uninstall fails closed when launchd cannot verify the GUI domain", () => {
  const home = createHome();
  try {
    const installed = installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: launchctlInitiallyUnloaded(),
    });
    assert.throws(
      () =>
        uninstallLocalAgentLaunchd({
          home,
          platform: "darwin",
          uid: 501,
          exec: (_command, args) => {
            if (args[0] === "print" && args[1].endsWith("/com.omniroute.local-agent")) {
              throw Object.assign(new Error("service not loaded"), { status: 113 });
            }
            throw new Error("GUI domain unavailable");
          },
        }),
      /domain is available/
    );
    assert.equal(existsSync(installed.plistFile), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd refuses to read or remove a plist after its permissions are loosened", () => {
  const home = createHome();
  try {
    const installed = installLocalAgentLaunchd(serviceConfig(), {
      home,
      platform: "darwin",
      uid: 501,
      exec: launchctlInitiallyUnloaded(),
    });
    chmodSync(installed.plistFile, 0o644);
    assert.throws(
      () =>
        uninstallLocalAgentLaunchd({
          home,
          platform: "darwin",
          uid: 501,
          exec: launchctlInitiallyUnloaded(),
        }),
      /unsafe file type, owner, links, or permissions/
    );
    assert.equal(existsSync(installed.plistFile), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd refuses to overwrite a loaded service when its plist is missing", () => {
  const home = createHome();
  let attemptedBootstrap = false;
  try {
    assert.throws(
      () =>
        installLocalAgentLaunchd(serviceConfig(), {
          home,
          platform: "darwin",
          uid: 501,
          exec: (_command, args) => {
            if (args[0] === "bootstrap") attemptedBootstrap = true;
          },
        }),
      /loaded.*without its managed plist/
    );
    assert.equal(attemptedBootstrap, false);
    assert.equal(existsSync(join(home, "Library", "LaunchAgents")), true);
    assert.equal(
      existsSync(join(home, "Library", "LaunchAgents", "com.omniroute.local-agent.plist")),
      false
    );
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
    chmodSync(plistFile, 0o600);
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
          exec: launchctlInitiallyUnloaded(),
        }),
      /control character/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd lifecycle controls load and unload only the managed current-user agent", () => {
  const home = createHome();
  const calls = [];
  let loaded = false;
  const exec = (_command, args) => {
    calls.push(args);
    if (args[0] === "print" && args[1] === "gui/501/com.omniroute.local-agent" && !loaded) {
      throw Object.assign(new Error("service not loaded"), { status: 113 });
    }
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
  };
  const options = { home, platform: "darwin", uid: 501, exec };

  try {
    assert.deepEqual(getLocalAgentLaunchdStatus(options), {
      installed: false,
      state: "not-installed",
    });
    assert.equal(startLocalAgentLaunchd(options), false);
    installLocalAgentLaunchd(serviceConfig(), options);
    assert.deepEqual(getLocalAgentLaunchdStatus(options), { installed: true, state: "loaded" });
    assert.equal(startLocalAgentLaunchd(options), true);
    assert.ok(calls.some((args) => args[0] === "kickstart"));
    assert.equal(stopLocalAgentLaunchd(options), true);
    assert.deepEqual(getLocalAgentLaunchdStatus(options), { installed: true, state: "unloaded" });
    assert.equal(startLocalAgentLaunchd(options), true);
    assert.deepEqual(getLocalAgentLaunchdStatus(options), { installed: true, state: "loaded" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
