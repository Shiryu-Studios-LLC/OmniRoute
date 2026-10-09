import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

const TASK_MARKER = "OmniRoute Local Agent managed task v1";
const DEFAULT_USER_ID_PATTERN = /^S-(?:\d+-){1,14}\d+$/i;

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteWindowsArgument(value) {
  const input = String(value);
  let result = '"';
  let slashes = 0;
  for (const character of input) {
    if (character === "\\") {
      slashes += 1;
    } else if (character === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      result += "\\".repeat(slashes) + character;
      slashes = 0;
    }
  }
  result += "\\".repeat(slashes * 2) + '"';
  return result;
}

function taskXml({ nodePath, cliPath, userId }) {
  if (!win32.isAbsolute(nodePath) || !win32.isAbsolute(cliPath)) {
    throw new Error("Windows Local Agent executable paths must be absolute.");
  }
  if (!DEFAULT_USER_ID_PATTERN.test(userId)) throw new Error("Windows user SID is invalid.");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${TASK_MARKER}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
    '  <Principals><Principal id="Author">',
    `    <UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
    "  </Principal></Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
    "  </Settings>",
    "  <Actions Context=" + '"Author">',
    `    <Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(`${quoteWindowsArgument(cliPath)} local-agent run`)}</Arguments><WorkingDirectory>${xml(dirname(cliPath))}</WorkingDirectory></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

function run(args, exec) {
  return exec("schtasks.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

const INSPECT_TASK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false",
  "$service = New-Object -ComObject Schedule.Service",
  "$service.Connect()",
  "$name = $env:OMNIROUTE_TASK_NAME.TrimStart('\\')",
  "try {",
  "  $task = $service.GetFolder('\\').GetTask($name)",
  "  [Console]::Out.Write((@{ exists = $true; xml = $task.Xml; state = [int]$task.State } | ConvertTo-Json -Compress))",
  "} catch {",
  "  if ([int]$_.Exception.HResult -eq -2147024894) { [Console]::Out.Write('{\"exists\":false}') } else { throw }",
  "}",
].join("\n");

function inspectTask(identity, exec) {
  let result;
  try {
    result = exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", INSPECT_TASK_SCRIPT],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, OMNIROUTE_TASK_NAME: identity.taskName },
      }
    );
  } catch {
    throw new Error("Could not safely inspect the Windows Local Agent scheduled task.");
  }
  const stdout = typeof result === "string" || Buffer.isBuffer(result) ? result : result?.stdout;
  const output = outputText(stdout).trim();
  let inspection;
  try {
    inspection = JSON.parse(output);
  } catch {
    throw new Error("Could not safely inspect the Windows Local Agent scheduled task.");
  }
  if (inspection?.exists === false) return null;
  if (
    inspection?.exists !== true ||
    typeof inspection.xml !== "string" ||
    !Number.isInteger(inspection.state)
  ) {
    throw new Error("Could not safely inspect the Windows Local Agent scheduled task.");
  }
  return inspection;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (!Buffer.isBuffer(value)) return String(value ?? "");
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
    return value.subarray(2).toString("utf16le");
  }
  if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
    return value.subarray(2).swap16().toString("utf16le");
  }
  if (value.length > 4 && value[1] === 0 && value[3] === 0) return value.toString("utf16le");
  return value.toString("utf8");
}

function decodeXml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function isExpectedManagedTask(contents, userId) {
  const registration = contents.match(/<RegistrationInfo>([\s\S]*?)<\/RegistrationInfo>/);
  if (!registration) return false;
  const descriptions = [...registration[1].matchAll(/<Description>([\s\S]*?)<\/Description>/g)];
  if (descriptions.length !== 1 || decodeXml(descriptions[0][1]) !== TASK_MARKER) return false;

  const principals = [...contents.matchAll(/<Principal\b([^>]*)>([\s\S]*?)<\/Principal>/g)];
  if (principals.length !== 1 || !/\bid="Author"/.test(principals[0][1])) return false;
  const principal = principals[0][2];
  if (
    decodeXml(principal.match(/<UserId>([\s\S]*?)<\/UserId>/)?.[1] ?? "") !== userId ||
    decodeXml(principal.match(/<LogonType>([\s\S]*?)<\/LogonType>/)?.[1] ?? "") !==
      "InteractiveToken" ||
    decodeXml(principal.match(/<RunLevel>([\s\S]*?)<\/RunLevel>/)?.[1] ?? "") !== "LeastPrivilege"
  ) {
    return false;
  }

  const actionBlocks = [...contents.matchAll(/<Actions\b([^>]*)>([\s\S]*?)<\/Actions>/g)];
  if (actionBlocks.length !== 1 || !/\bContext="Author"/.test(actionBlocks[0][1])) return false;
  const executables = [...actionBlocks[0][2].matchAll(/<Exec>([\s\S]*?)<\/Exec>/g)];
  if (executables.length !== 1) return false;
  const action = executables[0][1];
  const command = decodeXml(action.match(/<Command>([\s\S]*?)<\/Command>/)?.[1] ?? "");
  const args = decodeXml(action.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1] ?? "");
  const workingDirectory = decodeXml(
    action.match(/<WorkingDirectory>([\s\S]*?)<\/WorkingDirectory>/)?.[1] ?? ""
  );
  const cliPath = args.match(/^"([^\"]+)" local-agent run$/)?.[1];
  return (
    win32.isAbsolute(command) &&
    win32.basename(command).toLowerCase() === "node.exe" &&
    Boolean(cliPath && win32.isAbsolute(cliPath)) &&
    win32.isAbsolute(workingDirectory)
  );
}

function getCurrentUserId(exec) {
  let result;
  try {
    result = exec("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Could not determine the current Windows user SID.");
  }
  const output = outputText(result);
  const sid =
    output.match(/"[^\"]+"\s*,\s*"(S-[0-9-]+)"/i)?.[1] ?? output.match(/\b(S-[0-9-]+)\b/i)?.[1];
  if (!sid || !DEFAULT_USER_ID_PATTERN.test(sid) || /^S-1-5-(?:18|19|20)$/i.test(sid)) {
    throw new Error("The current Windows account did not return a valid user SID.");
  }
  return sid;
}

function resolveTaskIdentity({ userId, taskName, exec }) {
  const sid = userId ?? getCurrentUserId(exec);
  if (!DEFAULT_USER_ID_PATTERN.test(sid) || /^S-1-5-(?:18|19|20)$/i.test(sid)) {
    throw new Error("Windows Local Agent requires a valid non-service user SID.");
  }
  const name = taskName ?? `\\OmniRouteLocalAgent-${sid.replaceAll("-", "_")}`;
  if (!/^\\OmniRouteLocalAgent-[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Windows Local Agent task name is invalid.");
  }
  return { userId: sid, taskName: name };
}

function readManagedTask(exec, identity) {
  const inspection = inspectTask(identity, exec);
  if (inspection === null) return null;
  if (!isExpectedManagedTask(inspection.xml, identity.userId)) {
    throw new Error("Refusing to modify an unmanaged Windows Local Agent scheduled task.");
  }
  return inspection;
}

function writeTaskFile(contents) {
  const directory = mkdtempSync(join(tmpdir(), "omniroute-agent-task-"));
  const filePath = join(directory, "task.xml");
  const utf16Contents = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(contents, "utf16le"),
  ]);
  writeFileSync(filePath, utf16Contents, { flag: "wx", mode: 0o600 });
  return { directory, filePath };
}

function cleanupTaskFile(file) {
  rmSync(file.directory, { recursive: true, force: true });
}

export function installLocalAgentWindowsTask(
  _config,
  {
    platform = process.platform,
    nodePath = process.execPath,
    cliPath = process.argv[1],
    userId,
    taskName,
    exec = execFileSync,
  } = {}
) {
  if (platform !== "win32")
    throw new Error("Windows Local Agent task install is supported on Windows.");
  const identity = resolveTaskIdentity({ userId, taskName, exec });
  const prior = readManagedTask(exec, identity);
  const file = writeTaskFile(taskXml({ nodePath, cliPath, userId: identity.userId }));
  try {
    run(["/Create", "/TN", identity.taskName, "/XML", file.filePath, "/F"], exec);
    run(["/Run", "/TN", identity.taskName], exec);
  } catch (error) {
    if (prior !== null) {
      const rollback = writeTaskFile(prior.xml);
      try {
        run(["/Create", "/TN", identity.taskName, "/XML", rollback.filePath, "/F"], exec);
      } catch {
        // Preserve the activation error; the existing task remains managed.
      } finally {
        cleanupTaskFile(rollback);
      }
    } else {
      try {
        run(["/Delete", "/TN", identity.taskName, "/F"], exec);
      } catch {
        // Preserve the original creation/activation error.
      }
    }
    throw error;
  } finally {
    cleanupTaskFile(file);
  }
  return { serviceName: identity.taskName };
}

export function uninstallLocalAgentWindowsTask({
  platform = process.platform,
  userId,
  taskName,
  exec = execFileSync,
} = {}) {
  if (platform !== "win32")
    throw new Error("Windows Local Agent task uninstall is supported on Windows.");
  const identity = resolveTaskIdentity({ userId, taskName, exec });
  const existing = readManagedTask(exec, identity);
  if (existing === null) return false;
  const status = readTaskStatus(identity, exec, existing.state);
  if (status.state.toLowerCase() === "running") run(["/End", "/TN", identity.taskName], exec);
  else if (status.state === "unknown") {
    throw new Error("Could not verify whether the Windows Local Agent task is running.");
  }
  run(["/Delete", "/TN", identity.taskName, "/F"], exec);
  return true;
}

export function startLocalAgentWindowsTask({
  platform = process.platform,
  userId,
  taskName,
  exec = execFileSync,
} = {}) {
  if (platform !== "win32")
    throw new Error("Windows Local Agent task controls are supported on Windows.");
  const identity = resolveTaskIdentity({ userId, taskName, exec });
  if (readManagedTask(exec, identity) === null) return false;
  run(["/Run", "/TN", identity.taskName], exec);
  return true;
}

export function stopLocalAgentWindowsTask({
  platform = process.platform,
  userId,
  taskName,
  exec = execFileSync,
} = {}) {
  if (platform !== "win32")
    throw new Error("Windows Local Agent task controls are supported on Windows.");
  const identity = resolveTaskIdentity({ userId, taskName, exec });
  if (readManagedTask(exec, identity) === null) return false;
  run(["/End", "/TN", identity.taskName], exec);
  return true;
}

function readTaskStatus(identity, exec, knownState) {
  const inspection = knownState === undefined ? inspectTask(identity, exec) : { state: knownState };
  if (inspection === null) return { installed: false, state: "not-installed" };
  const state = new Map([
    [0, "Unknown"],
    [1, "Disabled"],
    [2, "Queued"],
    [3, "Ready"],
    [4, "Running"],
  ]);
  return { installed: true, state: state.get(inspection.state) ?? "unknown" };
}

export function getLocalAgentWindowsTaskStatus({
  platform = process.platform,
  userId,
  taskName,
  exec = execFileSync,
} = {}) {
  if (platform !== "win32")
    throw new Error("Windows Local Agent task status is supported on Windows.");
  const identity = resolveTaskIdentity({ userId, taskName, exec });
  const existing = readManagedTask(exec, identity);
  if (existing === null) return { installed: false, state: "not-installed" };
  return readTaskStatus(identity, exec, existing.state);
}

export function getLocalAgentWindowsTaskName(userId) {
  return resolveTaskIdentity({ userId, exec: execFileSync }).taskName;
}
