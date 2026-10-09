import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import {
  pairLocalAgentCommand,
  registerLocalAgent,
  resolveLocalAgentConfigAsync,
  saveWindowsLocalAgentConfig,
} from "../../../bin/cli/commands/local-agent.mjs";
import {
  getLocalAgentWindowsTaskStatus,
  getLocalAgentWindowsTaskName,
  installLocalAgentWindowsTask,
  startLocalAgentWindowsTask,
  stopLocalAgentWindowsTask,
  uninstallLocalAgentWindowsTask,
} from "../../../bin/cli/localAgentWindowsTask.mjs";

const credential = "a".repeat(43);
const userId = "S-1-5-21-100-200-300-1001";
const taskName = `\\OmniRouteLocalAgent-${userId.replaceAll("-", "_")}`;

function managedXml(principalUserId = userId, command = "C:\\Program Files\\Node\\node.exe") {
  return [
    "<Task>",
    "<RegistrationInfo><Description>OmniRoute Local Agent managed task v1</Description></RegistrationInfo>",
    `<Principals><Principal id="Author"><UserId>${principalUserId}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    `<Actions Context="Author"><Exec><Command>${command}</Command><Arguments>\"C:\\OmniRoute\\omniroute.mjs\" local-agent run</Arguments><WorkingDirectory>C:\\OmniRoute</WorkingDirectory></Exec></Actions>`,
    "</Task>",
  ].join("");
}

function createHome() {
  return mkdtempSync(join(tmpdir(), "omniroute-agent-windows-"));
}

function inspection(exists, xml = managedXml(), state = 4) {
  return JSON.stringify(exists ? { exists, xml, state } : { exists });
}

test("Windows task install keeps secrets out of task arguments and starts the managed task", () => {
  const calls = [];
  let xml;
  const installed = installLocalAgentWindowsTask(
    { credential },
    {
      platform: "win32",
      nodePath: "C:\\Program Files\\Node\\node.exe",
      cliPath: "C:\\Users\\owner\\App Data\\OmniRoute\\omniroute.mjs",
      userId,
      exec: (command, args) => {
        calls.push([command, args]);
        if (command === "whoami.exe") return `"HOST\\\\owner","${userId}"`;
        if (command === "powershell.exe") return inspection(false);
        if (args[0] === "/Create") {
          const filePath = args[4];
          xml = readFileSync(filePath, "utf16le").replace(/^\uFEFF/, "");
        }
        return "";
      },
    }
  );

  assert.equal(installed.serviceName, taskName);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, new RegExp(`<UserId>${userId}<\\/UserId>`));
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Description>OmniRoute Local Agent managed task v1<\/Description>/);
  assert.match(xml, /omniroute\.mjs/);
  assert.doesNotMatch(xml, new RegExp(credential));
  assert.equal(
    calls.some(([, args]) => args.includes(credential)),
    false
  );
  assert.deepEqual(
    calls.slice(1).map(([, args]) => args[0]),
    ["/Create", "/Run"]
  );
});

test("Windows task controls inspect ownership and provide install, run, stop, status, uninstall", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push(args);
    if (command === "powershell.exe") return inspection(true, managedXml(), 4);
    return "";
  };

  const options = { platform: "win32", userId, taskName, exec };
  assert.equal(startLocalAgentWindowsTask(options), true);
  assert.equal(stopLocalAgentWindowsTask(options), true);
  assert.deepEqual(getLocalAgentWindowsTaskStatus(options), {
    installed: true,
    state: "Running",
  });
  assert.equal(uninstallLocalAgentWindowsTask(options), true);
  assert.deepEqual(
    calls.filter((args) => ["/Run", "/End", "/Delete"].includes(args[0])).map((args) => args[0]),
    ["/Run", "/End", "/End", "/Delete"]
  );
});

test("Windows Task Scheduler inspection preserves Unicode paths from UTF-8 PowerShell output", () => {
  const xml = managedXml().replace("Program Files\\Node", "Users\\Jörg\\Node");
  const exec = (command) =>
    command === "powershell.exe" ? Buffer.from(inspection(true, xml, 3), "utf8") : "";
  assert.deepEqual(getLocalAgentWindowsTaskStatus({ platform: "win32", userId, taskName, exec }), {
    installed: true,
    state: "Ready",
  });
});

test("Windows service CLI registers install, uninstall, start, stop, and status", () => {
  const program = new Command();
  registerLocalAgent(program, { platform: "win32" });
  const localAgent = program.commands.find((command) => command.name() === "local-agent");
  const service = localAgent.commands.find((command) => command.name() === "service");
  assert.deepEqual(
    service.commands.map((command) => command.name()),
    ["install", "uninstall", "start", "stop", "status"]
  );
});

test("Windows installer refuses to overwrite an unmanaged scheduled task", () => {
  const calls = [];
  assert.throws(
    () =>
      installLocalAgentWindowsTask(
        {},
        {
          platform: "win32",
          userId,
          taskName,
          nodePath: "C:\\node.exe",
          cliPath: "C:\\omniroute.mjs",
          exec: (command, args) => {
            calls.push(args);
            if (command === "powershell.exe")
              return inspection(true, "<Task><Description>Another app</Description></Task>");
            return "";
          },
        }
      ),
    /unmanaged/
  );
  assert.equal(calls.length, 1);
});

test("Windows task ownership requires exact description, current SID, and expected action", () => {
  for (const candidate of [
    `<Task><Comment>${"OmniRoute Local Agent managed task v1"}</Comment></Task>`,
    managedXml("S-1-5-21-100-200-300-1002"),
    managedXml(userId, "C:\\Windows\\System32\\cmd.exe"),
  ]) {
    assert.throws(
      () =>
        startLocalAgentWindowsTask({
          platform: "win32",
          userId,
          taskName,
          exec: (command) => (command === "powershell.exe" ? inspection(true, candidate) : ""),
        }),
      /unmanaged/
    );
  }
});

test("Windows task names are scoped to validated current-user SIDs", () => {
  assert.equal(getLocalAgentWindowsTaskName(userId), taskName);
  assert.notEqual(getLocalAgentWindowsTaskName("S-1-5-21-100-200-300-1002"), taskName);
  assert.throws(() => getLocalAgentWindowsTaskName("S-1-5-18"), /SID/);
});

test("Windows config storage refuses to overwrite an unmanaged config", async () => {
  const home = createHome();
  const directory = join(home, "AppData", "Roaming", "OmniRoute");
  const filePath = join(directory, "local-agent.json");
  const original = '{"managedBy":"another app"}\n';
  const records = new Map();
  const keytar = {
    async getPassword() {
      return records.get("device_win") ?? null;
    },
    async setPassword(_service, account, value) {
      records.set(account, value);
    },
    async deletePassword(_service, account) {
      records.delete(account);
    },
  };
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(filePath, original);
    await assert.rejects(
      saveWindowsLocalAgentConfig(
        { gatewayUrl: "https://connect.example.test/", deviceId: "device_win", credential },
        { home, keytarLoader: async () => keytar }
      ),
      /unmanaged/
    );
    assert.equal(readFileSync(filePath, "utf8"), original);
    assert.equal(records.has("device_win"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows pairing stores the credential in keytar and writes only non-secret config", async () => {
  const home = createHome();
  const records = new Map();
  const calls = [];
  const keytar = {
    async getPassword(_service, account) {
      return records.get(account) ?? null;
    },
    async setPassword(_service, account, value) {
      records.set(account, value);
    },
    async deletePassword(_service, account) {
      records.delete(account);
    },
  };
  try {
    const paired = await pairLocalAgentCommand(
      { gatewayUrl: "https://connect.example.test" },
      {
        platform: "win32",
        home,
        readCode: async () => "p".repeat(43),
        stdout: { write() {} },
        keytarLoader: async () => keytar,
        fetcher: async () => {
          calls.push("fetch");
          return Response.json({ version: 1, deviceId: "device_win", credential }, { status: 201 });
        },
      }
    );
    const storedConfig = readFileSync(paired.configPath, "utf8");
    assert.equal(records.get("device_win"), credential);
    assert.match(storedConfig, /windows-credential-manager/);
    assert.doesNotMatch(storedConfig, new RegExp(credential));
    assert.deepEqual(calls, ["fetch"]);
    const resolved = await resolveLocalAgentConfigAsync(
      {},
      { HOME: home },
      { platform: "win32", home, keytarLoader: async () => keytar }
    );
    assert.equal(resolved.credential, credential);
    assert.equal(resolved.deviceId, "device_win");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows pairing and config-backed service install fail closed when keytar is absent", async () => {
  const home = createHome();
  let fetched = false;
  const missingKeytar = async () => {
    throw new Error("Cannot find package keytar");
  };
  try {
    await assert.rejects(
      pairLocalAgentCommand(
        { gatewayUrl: "https://connect.example.test" },
        {
          platform: "win32",
          home,
          readCode: async () => "p".repeat(43),
          keytarLoader: missingKeytar,
          fetcher: async () => {
            fetched = true;
            return Response.json({});
          },
        }
      ),
      /optional keytar package/
    );
    assert.equal(fetched, false);

    const keytar = {
      async getPassword() {
        return credential;
      },
      async setPassword() {},
      async deletePassword() {},
    };
    await saveWindowsLocalAgentConfig(
      { gatewayUrl: "https://connect.example.test/", deviceId: "device_win", credential },
      { home, keytarLoader: async () => keytar }
    );
    await assert.rejects(
      resolveLocalAgentConfigAsync(
        {},
        { HOME: home },
        { platform: "win32", home, keytarLoader: missingKeytar }
      ),
      /optional keytar package/
    );
    assert.doesNotMatch(
      readFileSync(join(home, "AppData", "Roaming", "OmniRoute", "local-agent.json"), "utf8"),
      new RegExp(credential)
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
