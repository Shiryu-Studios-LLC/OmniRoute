import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyRoute as classifyShared } from "../../../src/shared/authz/classify.ts";
import { classifyRoute as classifyServer } from "../../../src/server/authz/classify.ts";

const CASES = [
  ["/", "GET", "MANAGEMENT", "root_redirect", "/"],
  ["/dashboard/onboarding", "GET", "PUBLIC", "setup_wizard", "/dashboard/onboarding"],
  ["/connect/codex/ticket", "GET", "PUBLIC", "public_connect_page", "/connect/codex/ticket"],
  ["/V1/chat/completions", "POST", "CLIENT_API", "client_api_alias", "/api/v1/chat/completions"],
  ["/v1/v1/models", "GET", "CLIENT_API", "client_api_double_prefix", "/api/v1/models"],
  ["/CODEX", "POST", "CLIENT_API", "client_api_codex_alias", "/api/v1/responses"],
  ["/api/auth/login", "POST", "PUBLIC", "public_prefix", "/api/auth/login"],
  ["/api/health/ping", "GET", "PUBLIC", "public_readonly_prefix", "/api/health/ping"],
  ["/api/health/ping", "POST", "MANAGEMENT", "management_api", "/api/health/ping"],
  [
    "/api/usage/om-usage-shadow",
    "GET",
    "MANAGEMENT",
    "management_api",
    "/api/usage/om-usage-shadow",
  ],
  [
    "/api/oauth/cursor/auto-import",
    "POST",
    "MANAGEMENT",
    "management_api",
    "/api/oauth/cursor/auto-import",
  ],
  ["/unknown/path", "GET", "MANAGEMENT", "fallback_management", "/unknown/path"],
] as const;

test("runtime-neutral and server compatibility classifiers preserve route decisions", () => {
  for (const [path, method, routeClass, reason, normalizedPath] of CASES) {
    const expected = { routeClass, reason, normalizedPath };
    assert.deepEqual(classifyShared(path, method), expected, `${method} ${path} shared result`);
    assert.deepEqual(classifyServer(path, method), expected, `${method} ${path} server result`);
  }
});

test("shared authz classifier and DTO modules have no Node or framework imports", () => {
  for (const file of ["src/shared/authz/classify.ts", "src/shared/authz/types.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:node:|next(?:\/|["']))/,
      `${file} must stay runtime-neutral`
    );
  }
});
