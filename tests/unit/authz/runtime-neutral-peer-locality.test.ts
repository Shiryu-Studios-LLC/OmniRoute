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
import {
  classifyStampedPeerLocality as classifyStampedPeerShared,
  resolveStampedPeer as resolveStampedPeerShared,
  resolveStampedViaProxy as resolveStampedViaProxyShared,
} from "../../../src/shared/authz/peerStamp.ts";
import {
  classifyStampedPeerLocality as classifyStampedPeerServer,
  resolveStampedPeer as resolveStampedPeerServer,
  resolveStampedViaProxy as resolveStampedViaProxyServer,
} from "../../../src/server/authz/peerStamp.ts";

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

test("shared and server peer-stamp exports preserve trusted locality behavior", () => {
  const token = "process-secret-token-abc";
  const cases: ReadonlyArray<
    [string | null, string | null, string | undefined, string | null, boolean, string]
  > = [
    [`${token}|127.0.0.1`, null, token, "127.0.0.1", false, "loopback"],
    [`${token}|192.168.0.15`, null, token, "192.168.0.15", false, "lan"],
    [`${token}|127.0.0.1`, `${token}|1`, token, "127.0.0.1", true, "remote"],
    ["forged|127.0.0.1", null, token, null, false, "remote"],
    [`${token}|8.8.8.8`, `${token}|0`, token, "8.8.8.8", false, "remote"],
  ];

  for (const [
    peerStamp,
    proxyStamp,
    secret,
    expectedPeer,
    expectedProxy,
    expectedLocality,
  ] of cases) {
    assert.equal(resolveStampedPeerShared(peerStamp, secret), expectedPeer);
    assert.equal(resolveStampedPeerServer(peerStamp, secret), expectedPeer);
    assert.equal(resolveStampedViaProxyShared(proxyStamp, secret), expectedProxy);
    assert.equal(resolveStampedViaProxyServer(proxyStamp, secret), expectedProxy);
    assert.equal(classifyStampedPeerShared(peerStamp, proxyStamp, secret), expectedLocality);
    assert.equal(classifyStampedPeerServer(peerStamp, proxyStamp, secret), expectedLocality);
  }
});

test("shared peer-stamp helper has no Node or framework imports", () => {
  const source = fs.readFileSync("src/shared/authz/peerStamp.ts", "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:node:|next(?:\/|["']))/);
});
