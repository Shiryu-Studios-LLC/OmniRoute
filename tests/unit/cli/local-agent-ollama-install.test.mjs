import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  installLocalAgentOllama,
  __ollamaInstallerInternals,
} from "../../../bin/cli/localAgentOllamaInstall.mjs";
import { installLocalAgentOllamaCommand } from "../../../bin/cli/commands/local-agent.mjs";

const archive = Buffer.from("signed-release-fixture");
const digest = createHash("sha256").update(archive).digest("hex");

function metadataResponse({
  size = archive.length,
  hash = digest,
  name = "ollama-linux-amd64.tar.zst",
} = {}) {
  return new Response(
    JSON.stringify({
      tag_name: "v0.40.1",
      assets: [
        {
          name,
          size,
          digest: `sha256:${hash}`,
          browser_download_url:
            "https://github.com/ollama/ollama/releases/download/v0.40.1/ollama-linux-amd64.tar.zst",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function mockFetch({ hash = digest } = {}) {
  return async (url) => {
    if (String(url).startsWith("https://api.github.com/")) return metadataResponse({ hash });
    return new Response(archive, {
      status: 200,
      headers: { "content-length": String(archive.length) },
    });
  };
}

function fakeExtract(_command, args) {
  const destination = args[args.indexOf("-C") + 1];
  mkdirSync(join(destination, "bin"), { recursive: true });
  writeFileSync(join(destination, "bin", "ollama"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { status: 0 };
}

test("official release metadata requires an exact supported asset and SHA-256 digest", () => {
  const valid = {
    tag_name: "v0.40.1",
    assets: [
      {
        name: "ollama-linux-amd64.tar.zst",
        size: archive.length,
        digest: `sha256:${digest}`,
        browser_download_url:
          "https://github.com/ollama/ollama/releases/download/v0.40.1/ollama-linux-amd64.tar.zst",
      },
    ],
  };
  assert.equal(__ollamaInstallerInternals.getReleaseAsset(valid, "amd64").digest, digest);
  assert.throws(
    () =>
      __ollamaInstallerInternals.getReleaseAsset(
        { ...valid, assets: [{ ...valid.assets[0], digest: null }] },
        "amd64"
      ),
    /SHA-256 digest/
  );
  assert.throws(
    () =>
      __ollamaInstallerInternals.getReleaseAsset(
        {
          ...valid,
          assets: [
            { ...valid.assets[0], browser_download_url: "https://example.com/ollama.tar.zst" },
          ],
        },
        "amd64"
      ),
    /URL was not trusted/
  );
});

test("Ollama installs only after explicit yes into a user-local path and does not download a model", async () => {
  const home = mkdtempSync(join(tmpdir(), "omniroute-ollama-install-"));
  const output = {
    value: "",
    write(value) {
      this.value += value;
    },
  };
  try {
    const result = await installLocalAgentOllama({
      platform: "linux",
      architecture: "x64",
      home,
      uid: process.getuid(),
      fetch: mockFetch(),
      run: fakeExtract,
    });
    assert.equal(result.version, "v0.40.1");
    assert.equal(result.binary, join(home, ".local", "bin", "ollama"));
    assert.equal(readFileSync(join(result.path, "bin", "ollama"), "utf8"), "#!/bin/sh\nexit 0\n");

    let installCalls = 0;
    await assert.rejects(
      installLocalAgentOllamaCommand(
        {},
        {
          platform: "linux",
          home,
          stdin: { isTTY: false },
          stdout: { ...output, isTTY: false },
          install: async () => {
            installCalls += 1;
            return result;
          },
        }
      ),
      /confirm.*--yes/
    );
    assert.equal(installCalls, 0);
    const accepted = await installLocalAgentOllamaCommand(
      { yes: true },
      { platform: "linux", home, stdout: output, install: async () => result }
    );
    assert.equal(accepted.installed, true);
    assert.match(output.value, /No model was downloaded/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Ollama install rejects unsupported platforms, architectures, and unverified downloads", async () => {
  const home = mkdtempSync(join(tmpdir(), "omniroute-ollama-reject-"));
  try {
    await assert.rejects(
      installLocalAgentOllama({ platform: "darwin", home, uid: process.getuid() }),
      /Linux only/
    );
    await assert.rejects(
      installLocalAgentOllama({
        platform: "linux",
        architecture: "ia32",
        home,
        uid: process.getuid(),
      }),
      /x86_64 and ARM64/
    );
    await assert.rejects(
      installLocalAgentOllama({
        platform: "linux",
        architecture: "x64",
        home,
        uid: process.getuid(),
        fetch: mockFetch({ hash: "0".repeat(64) }),
        run: () => {
          throw new Error("extraction must not run for unverified archive");
        },
      }),
      /failed its official size or SHA-256 verification/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
