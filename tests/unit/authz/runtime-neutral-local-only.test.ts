import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isLocalOnlyPath as isSharedLocalOnlyPath,
  LOCAL_ONLY_API_PREFIXES,
  LOCAL_ONLY_API_REGEXES,
} from "../../../src/shared/authz/localOnlyRoutes.ts";
import {
  isLocalOnlyPath as isServerLocalOnlyPath,
  LOCAL_ONLY_API_PREFIXES as SERVER_LOCAL_ONLY_API_PREFIXES,
  LOCAL_ONLY_API_REGEXES as SERVER_LOCAL_ONLY_API_REGEXES,
  LOCAL_ONLY_API_PATTERNS,
} from "../../../src/server/authz/routeGuard.ts";
import { VNC_ROUTE_PREFIX } from "../../../src/lib/vncSession/manifest.ts";

test("runtime-neutral and server route guards share the same static matcher inventory", () => {
  assert.deepEqual(SERVER_LOCAL_ONLY_API_PREFIXES, LOCAL_ONLY_API_PREFIXES);
  assert.deepEqual(SERVER_LOCAL_ONLY_API_REGEXES.map(String), LOCAL_ONLY_API_REGEXES.map(String));
  assert.equal(LOCAL_ONLY_API_PATTERNS, SERVER_LOCAL_ONLY_API_REGEXES);
  assert.ok(LOCAL_ONLY_API_PREFIXES.includes(VNC_ROUTE_PREFIX));
});

test("shared local-only prefixes preserve exact and subtree boundaries", () => {
  for (const prefix of LOCAL_ONLY_API_PREFIXES) {
    assert.equal(isSharedLocalOnlyPath(prefix), true, `${prefix} exact path`);
    if (prefix.endsWith("/")) {
      assert.equal(isSharedLocalOnlyPath(`${prefix}child`), true, `${prefix} child path`);
    }
  }

  for (const path of [
    "/api/localization",
    "/api/localhost-check",
    "/api/mcping",
    "/api/servicesX",
    "/dashboard/providers/servicesX",
  ]) {
    assert.equal(isSharedLocalOnlyPath(path), false, `${path} must remain outside slash subtree`);
  }

  // These entries intentionally include the bare route and retain the existing
  // startsWith semantics for their sibling spellings.
  assert.equal(isSharedLocalOnlyPath("/api/plugins"), true);
  assert.equal(isSharedLocalOnlyPath("/api/plugins-extra"), true);
});

test("regex local-only routes keep their dynamic segment and suffix boundaries", () => {
  const matching = [
    "/api/providers/account-1/login",
    "/api/providers/account-1/login/",
    "/api/providers/volcengine-plan/connect",
    "/api/providers/volcengine-plan/connect/code",
    "/api/providers/account-1/refresh-cursor",
    "/api/providers/account-1/chatgpt-web-codex-doctor",
  ];
  for (const path of matching) {
    assert.equal(isSharedLocalOnlyPath(path), true, `${path} should match a regex route`);
    assert.equal(isServerLocalOnlyPath(path), true, `${path} server compatibility result`);
  }

  const nonMatching = [
    "/api/providers/account-1/login/extra",
    "/api/providers/account-1/refresh-cursor/extra",
    "/api/providers/account-1/chatgpt-web-codex-doctor/extra",
    "/api/providers/account-1/refresh",
  ];
  for (const path of nonMatching) {
    assert.equal(isSharedLocalOnlyPath(path), false, `${path} must not match a regex route`);
    assert.equal(isServerLocalOnlyPath(path), false, `${path} server compatibility result`);
  }
});

test("server compatibility preserves method-aware GET exemption and local route behavior", () => {
  assert.equal(isSharedLocalOnlyPath("/api/system/version"), true);
  assert.equal(isServerLocalOnlyPath("/api/system/version", "GET"), false);
  assert.equal(isServerLocalOnlyPath("/api/system/version", "HEAD"), false);
  assert.equal(isServerLocalOnlyPath("/api/system/version", "OPTIONS"), false);
  assert.equal(isServerLocalOnlyPath("/api/system/version", "POST"), true);
  assert.equal(isServerLocalOnlyPath("/api/mcp/sse", "GET"), true);
  assert.equal(isServerLocalOnlyPath("/api/settings"), false);
});

test("shared local-only matcher has no Node or framework imports", () => {
  const source = fs.readFileSync("src/shared/authz/localOnlyRoutes.ts", "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:node:|next(?:\/|["']))/);
});
