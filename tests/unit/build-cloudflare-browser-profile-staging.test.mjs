import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageCloudflareBrowserProfiles } from "../../scripts/build/cloudflareBrowserProfileStaging.mjs";

function makeRepo() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cloudflare-profile-staging-"));
  const repoRoot = path.join(parent, "repo");
  const profileRoot = path.join(repoRoot, ".data", "adobe-chrome-profiles", "session-a");
  fs.mkdirSync(profileRoot, { recursive: true });
  fs.writeFileSync(path.join(profileRoot, "Local State"), "preserve me", { mode: 0o600 });
  return { parent, repoRoot, profileRoot };
}

test("profile staging moves only Chromium profiles outside the trace root and restores them", () => {
  const fixture = makeRepo();
  const lockPath = path.join(fixture.profileRoot, "SingletonLock");
  fs.symlinkSync(`stale-host-${process.pid + 900_000}`, lockPath);
  const cookiePath = path.join(fixture.profileRoot, "SingletonCookie");
  fs.symlinkSync("stale-cookie-id", cookiePath);
  const sessionPath = path.join(fixture.repoRoot, ".data", "adobe-browser-sessions");
  fs.mkdirSync(sessionPath, { recursive: true });
  fs.writeFileSync(path.join(sessionPath, "cookie.json"), "keep");

  const restore = stageCloudflareBrowserProfiles(fixture.repoRoot, { suffix: "unit" });
  const stagingRoot = path.join(fixture.parent, `.repo-adobe-profiles-${process.pid}-unit`);
  assert.equal(fs.existsSync(fixture.profileRoot), false);
  assert.equal(fs.readFileSync(path.join(sessionPath, "cookie.json"), "utf8"), "keep");
  assert.equal(
    fs.readFileSync(path.join(stagingRoot, "session-a", "Local State"), "utf8"),
    "preserve me"
  );
  assert.equal(
    fs.readlinkSync(path.join(stagingRoot, "session-a", "SingletonCookie")),
    "stale-cookie-id"
  );

  restore();
  assert.equal(
    fs.readFileSync(path.join(fixture.profileRoot, "Local State"), "utf8"),
    "preserve me"
  );
  assert.equal(fs.readlinkSync(cookiePath), "stale-cookie-id");
  assert.equal(fs.existsSync(stagingRoot), false);
  fs.rmSync(fixture.parent, { recursive: true, force: true });
});

test("profile staging refuses a live Chrome lock without moving profile data", () => {
  const fixture = makeRepo();
  const lockPath = path.join(fixture.profileRoot, "SingletonLock");
  fs.symlinkSync(`localhost-${process.pid}`, lockPath);

  assert.throws(() => stageCloudflareBrowserProfiles(fixture.repoRoot), /is in use/);
  assert.equal(
    fs.readFileSync(path.join(fixture.profileRoot, "Local State"), "utf8"),
    "preserve me"
  );
  fs.rmSync(fixture.parent, { recursive: true, force: true });
});

test("profile staging preserves originals when another profile root appears before restore", () => {
  const fixture = makeRepo();
  const lockPath = path.join(fixture.profileRoot, "SingletonLock");
  fs.symlinkSync(`stale-host-${process.pid + 900_000}`, lockPath);
  const restore = stageCloudflareBrowserProfiles(fixture.repoRoot, { suffix: "collision" });
  const stagingRoot = path.join(fixture.parent, `.repo-adobe-profiles-${process.pid}-collision`);
  const recreated = path.join(fixture.repoRoot, ".data", "adobe-chrome-profiles");
  fs.mkdirSync(recreated, { recursive: true });

  assert.throws(() => restore(), /original profiles remain at/);
  assert.equal(
    fs.readFileSync(path.join(stagingRoot, "session-a", "Local State"), "utf8"),
    "preserve me"
  );
  assert.equal(fs.existsSync(recreated), true);
  fs.rmSync(fixture.parent, { recursive: true, force: true });
});
