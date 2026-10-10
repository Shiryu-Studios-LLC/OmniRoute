import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function safeOwnedDirectory(path, uid, create = false) {
  if (create) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o022) {
    throw new Error(
      "Ollama install directories must be current-user-owned and not writable by others."
    );
  }
  chmodSync(path, 0o700);
}

function ensureDirectory(path, uid) {
  try {
    safeOwnedDirectory(path, uid);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    safeOwnedDirectory(path, uid);
  }
}

async function readJsonBounded(response, maxBytes) {
  if (!response.ok || !response.body)
    throw new Error("Could not read official Ollama release metadata.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Official Ollama release metadata exceeded the size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Official Ollama release metadata was invalid.");
  }
}

function getReleaseAsset(metadata, architecture) {
  const assetName = `ollama-linux-${architecture}.tar.zst`;
  const asset = metadata?.assets?.find((row) => row?.name === assetName);
  if (
    typeof metadata?.tag_name !== "string" ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(metadata.tag_name) ||
    !asset ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_ARCHIVE_BYTES ||
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
    typeof asset.browser_download_url !== "string"
  ) {
    throw new Error("Official Ollama release lacks a supported Linux archive and SHA-256 digest.");
  }
  const downloadUrl = new URL(asset.browser_download_url);
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== "github.com" ||
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.search ||
    downloadUrl.hash ||
    !downloadUrl.pathname.startsWith(`/ollama/ollama/releases/download/${metadata.tag_name}/`)
  ) {
    throw new Error("Official Ollama release archive URL was not trusted.");
  }
  return {
    tag: metadata.tag_name,
    name: assetName,
    size: asset.size,
    digest: asset.digest.slice(7),
    url: downloadUrl,
  };
}

async function fetchArchive(url, archivePath, expectedSize, expectedDigest, { fetch }) {
  let current = new URL(url);
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (current.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(current.hostname)) {
      throw new Error("Ollama archive download redirected to an untrusted host.");
    }
    response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "OmniRoute-Local-Agent" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3)
        throw new Error("Ollama archive download had too many redirects.");
      current = new URL(location, current);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body)
    throw new Error("Could not download the official Ollama archive.");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength !== expectedSize) {
    await response.body.cancel();
    throw new Error("Ollama archive size did not match release metadata.");
  }
  const fd = openSync(archivePath, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize || size > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("Ollama archive exceeded the release metadata size.");
      }
      const chunk = Buffer.from(value);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    closeSync(fd);
    throw error;
  } finally {
    reader.releaseLock();
  }
  closeSync(fd);
  if (size !== expectedSize || digest.digest("hex") !== expectedDigest) {
    throw new Error("Ollama archive failed its official size or SHA-256 verification.");
  }
}

function extractVerifiedArchive(archivePath, destination, run = spawnSync) {
  const result = run(
    "tar",
    ["--zstd", "-xf", archivePath, "-C", destination, "--no-same-owner", "--no-same-permissions"],
    {
      stdio: "ignore",
      timeout: 120_000,
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Could not safely extract the verified Ollama archive (GNU tar with zstd support is required)."
    );
  }
  const binary = join(destination, "bin", "ollama");
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Verified Ollama archive did not contain a regular executable.");
  chmodSync(binary, 0o700);
  return binary;
}

/** Install the official Linux Ollama release into the user's private ~/.local directories. */
export async function installLocalAgentOllama({
  architecture = process.arch,
  platform = process.platform,
  home = homedir(),
  uid = process.getuid?.(),
  fetch = globalThis.fetch,
  run = spawnSync,
} = {}) {
  if (platform !== "linux")
    throw new Error("Ollama installation is currently supported on Linux only.");
  const releaseArchitecture =
    architecture === "x64" ? "amd64" : architecture === "arm64" ? "arm64" : null;
  if (!releaseArchitecture)
    throw new Error("Ollama installation supports Linux x86_64 and ARM64 only.");
  if (typeof uid !== "number" || typeof fetch !== "function")
    throw new Error("Ollama installation environment is unsupported.");

  const canonicalHome = realpathSync(home);
  const homeStat = lstatSync(canonicalHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== uid) {
    throw new Error("Ollama installation requires a current-user-owned home directory.");
  }
  const local = join(canonicalHome, ".local");
  const binDir = join(local, "bin");
  const shareDir = join(local, "share");
  const appDir = join(shareDir, "omniroute", "ollama");
  for (const directory of [local, binDir, shareDir, join(shareDir, "omniroute"), appDir])
    ensureDirectory(directory, uid);

  const metadataResponse = await fetch(RELEASE_API, {
    redirect: "error",
    headers: { accept: "application/vnd.github+json", "user-agent": "OmniRoute-Local-Agent" },
  });
  const metadata = await readJsonBounded(metadataResponse, MAX_METADATA_BYTES);
  const release = getReleaseAsset(metadata, releaseArchitecture);
  const versionDir = join(appDir, release.tag);
  if (existsSync(versionDir))
    throw new Error(`Ollama ${release.tag} is already installed; refusing to overwrite it.`);
  const stagingDir = join(appDir, `.install-${randomBytes(8).toString("hex")}`);
  mkdirSync(stagingDir, { mode: 0o700 });
  const archivePath = join(stagingDir, "ollama.tar.zst");
  const unpackedDir = join(stagingDir, "unpacked");
  mkdirSync(unpackedDir, { mode: 0o700 });
  let installedVersion = false;
  let temporaryLink = null;
  let linkCommitted = false;
  try {
    await fetchArchive(release.url, archivePath, release.size, release.digest, { fetch });
    extractVerifiedArchive(archivePath, unpackedDir, run);
    const binaryPath = join(unpackedDir, "bin", "ollama");
    const binaryFd = openSync(binaryPath, "r");
    const extractedStat = fstatSync(binaryFd);
    closeSync(binaryFd);
    if (extractedStat.uid !== uid)
      throw new Error("Extracted Ollama executable has unexpected ownership.");
    const installedStage = join(stagingDir, "version");
    renameSync(unpackedDir, installedStage);
    renameSync(installedStage, versionDir);
    installedVersion = true;
    const link = join(binDir, "ollama");
    temporaryLink = join(binDir, `.ollama-${randomBytes(8).toString("hex")}`);
    let existing;
    try {
      existing = lstatSync(link);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!existing.isSymbolicLink() || existing.uid !== uid)
        throw new Error("Refusing to replace a non-symlink ~/.local/bin/ollama.");
      const target = resolve(dirname(link), readlinkSync(link));
      if (!target.startsWith(`${appDir}${sep}`))
        throw new Error(
          "Refusing to replace an Ollama link outside OmniRoute's install directory."
        );
    }
    symlinkSync(join(versionDir, "bin", "ollama"), temporaryLink);
    renameSync(temporaryLink, link);
    temporaryLink = null;
    linkCommitted = true;
    // The install is committed once the user-local link points at the verified
    // release. Cleanup failure must not remove the linked version.
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // A later install can remove an orphaned private staging directory.
    }
    return { version: release.tag, binary: link, path: versionDir, digest: release.digest };
  } catch (error) {
    if (temporaryLink) rmSync(temporaryLink, { force: true });
    if (installedVersion && !linkCommitted) {
      rmSync(versionDir, { recursive: true, force: true });
    }
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export const __ollamaInstallerInternals = {
  getReleaseAsset,
  fetchArchive,
  extractVerifiedArchive,
  MAX_ARCHIVE_BYTES,
};
