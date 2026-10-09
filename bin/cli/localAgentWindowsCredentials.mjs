const SERVICE = "omniroute-local-agent";

/** Load the optional native Windows credential-store adapter without exposing a fallback. */
export async function loadLocalAgentCredentialStore(loader = () => import("keytar")) {
  let imported;
  try {
    imported = await loader();
  } catch {
    throw new Error(
      "Windows Local Agent credential storage requires the optional keytar package; install OmniRoute with optional dependencies enabled."
    );
  }
  const backend = imported?.default ?? imported;
  if (
    !backend ||
    typeof backend.getPassword !== "function" ||
    typeof backend.setPassword !== "function" ||
    typeof backend.deletePassword !== "function"
  ) {
    throw new Error("Windows Local Agent credential storage is unavailable through keytar.");
  }
  return backend;
}

export async function saveLocalAgentCredential(backend, deviceId, credential) {
  try {
    await backend.setPassword(SERVICE, deviceId, credential);
  } catch {
    throw new Error("Could not save the Local Agent credential in Windows Credential Manager.");
  }
}

export async function readLocalAgentCredential(backend, deviceId) {
  let value;
  try {
    value = await backend.getPassword(SERVICE, deviceId);
  } catch {
    throw new Error("Could not read the Local Agent credential from Windows Credential Manager.");
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new Error(
      "No valid Local Agent credential is stored in Windows Credential Manager; pair the agent again."
    );
  }
  return value;
}

export async function deleteLocalAgentCredential(backend, deviceId) {
  try {
    await backend.deletePassword(SERVICE, deviceId);
  } catch {
    throw new Error("Could not remove the Local Agent credential from Windows Credential Manager.");
  }
}
