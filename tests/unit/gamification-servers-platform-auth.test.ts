import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const routePath = path.join(repoRoot, "src/app/api/gamification/servers/route.ts");

test("shared gamification federation server settings require the platform tenant", () => {
  const source = fs.readFileSync(routePath, "utf8");

  assert.match(source, /getManagementTenantId\(request\).*PLATFORM_TENANT_ID/s);

  for (const method of ["GET", "POST", "DELETE"]) {
    const methodStart = source.indexOf(`export async function ${method}`);
    assert.ok(methodStart >= 0, `${method} handler must exist`);
    const nextMethod = source.indexOf("export async function", methodStart + 1);
    const methodBody = source.slice(methodStart, nextMethod < 0 ? undefined : nextMethod);
    const authIndex = methodBody.indexOf("requirePlatformManagementAuth(request)");
    assert.ok(authIndex >= 0, `${method} handler must enforce platform tenant access`);
    const operationIndex = methodBody.search(/listServers\(|connectServer\(|disconnectServer\(/);
    assert.ok(
      operationIndex > authIndex,
      `${method} must authorize before accessing shared settings`
    );
  }
});
