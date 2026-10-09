import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyHostLocality as classifyShared,
  isLoopbackHost as isLoopbackShared,
  isPrivateLanHost as isPrivateLanShared,
} from "../../../src/shared/authz/peerLocality.ts";
import {
  classifyHostLocality as classifyServer,
  isLoopbackHost as isLoopbackServer,
  isPrivateLanHost as isPrivateLanServer,
} from "../../../src/server/authz/routeGuard.ts";

test("shared and server compatibility exports preserve loopback host classification", () => {
  const cases: ReadonlyArray<[string | null, boolean]> = [
    ["localhost", true],
    ["localhost:20128", true],
    ["127.0.0.1", true],
    ["127.0.0.1:3000", true],
    ["[::1]", true],
    ["[::1]:20128", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.1.1", false],
    ["example.com", false],
    [null, false],
  ];
  for (const [host, expected] of cases) {
    assert.equal(isLoopbackShared(host), expected, `shared: ${host}`);
    assert.equal(isLoopbackServer(host), expected, `server compatibility: ${host}`);
  }
});

test("shared and server compatibility exports preserve private-LAN range classification", () => {
  const accepted = [
    "10.0.0.5",
    "100.64.0.1",
    "100.96.135.160:20128",
    "100.127.255.254",
    "192.168.0.15",
    "172.16.0.9",
    "172.31.255.254",
    "::ffff:192.168.1.20",
    "fd12:3456::1",
    "fe80::1",
  ];
  const rejected = [
    "8.8.8.8",
    "69.164.221.35",
    "100.63.255.255",
    "100.128.0.1",
    "172.32.0.1",
    "127.0.0.1",
    "::1",
    "example.com",
    "",
    null,
  ];
  for (const host of accepted) {
    assert.equal(isPrivateLanShared(host), true, `shared accepts ${host}`);
    assert.equal(isPrivateLanServer(host), true, `server compatibility accepts ${host}`);
  }
  for (const host of rejected) {
    assert.equal(isPrivateLanShared(host), false, `shared rejects ${host}`);
    assert.equal(isPrivateLanServer(host), false, `server compatibility rejects ${host}`);
  }
});

test("shared and server compatibility exports preserve locality tiers and fail-closed null", () => {
  const cases: ReadonlyArray<[string | null, "loopback" | "lan" | "remote"]> = [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["192.168.0.15", "lan"],
    ["::ffff:192.168.1.20", "lan"],
    ["8.8.8.8", "remote"],
    ["69.164.221.35", "remote"],
    [null, "remote"],
  ];
  for (const [ip, expected] of cases) {
    assert.equal(classifyShared(ip), expected, `shared: ${ip}`);
    assert.equal(classifyServer(ip), expected, `server compatibility: ${ip}`);
  }
});

test("shared peer locality helper has no Node or framework imports", () => {
  const source = fs.readFileSync("src/shared/authz/peerLocality.ts", "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:node:|next(?:\/|["']))/);
});
