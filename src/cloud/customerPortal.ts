export const CLOUD_CUSTOMER_PORTAL_PATH = "/__cloud/portal";

const PORTAL_SCRIPT = `
(() => {
  const byId = (id) => document.getElementById(id);
  const status = byId("status");
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.dataset.state = error ? "error" : "ok";
  };
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const api = async (path, init = {}) => {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : "Request failed");
    }
    return data;
  };
  const signInForm = byId("signin-form");
  const inviteForm = byId("redeem-form");
  const memberList = byId("members");
  const nextButton = byId("next-page");
  const apiKeyList = byId("api-keys");
  const apiKeyResult = byId("api-key-result");
  const serviceList = byId("business-services");
  const providerList = byId("provider-connections");
  let newlyIssuedToken = null;
  let nextCursor = null;
  let pendingHostChallenge = null;

  const formatDate = (value) => {
    if (typeof value !== "string") return "No expiration";
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
  };

  const clearIssuedToken = () => {
    newlyIssuedToken = null;
    apiKeyResult.replaceChildren();
  };

  const addService = (service = { name: "", price: "" }) => {
    if (serviceList.children.length >= 30) return setStatus("You can add up to 30 services.", true);
    const row = node("li");
    row.className = "service-row";
    const nameLabel = node("label", "Service name");
    const name = node("input");
    name.maxLength = 100;
    name.required = true;
    name.value = typeof service.name === "string" ? service.name : "";
    nameLabel.append(name);
    const priceLabel = node("label", "Price");
    const price = node("input");
    price.maxLength = 60;
    price.value = typeof service.price === "string" ? service.price : "";
    priceLabel.append(price);
    const remove = node("button", "Remove service");
    remove.type = "button";
    remove.addEventListener("click", () => row.remove());
    row.append(nameLabel, priceLabel, remove);
    serviceList.append(row);
  };

  const loadBusinessProfile = async () => {
    const profile = await api("/__cloud/auth/business-profile");
    for (const [id, value] of [
      ["business-name", profile.name], ["business-description", profile.description],
      ["business-hours", profile.hours], ["assistant-name", profile.assistant?.name],
      ["assistant-tone", profile.assistant?.tone], ["assistant-handoff", profile.assistant?.handoff],
    ]) {
      if (typeof value === "string") byId(id).value = value;
    }
    serviceList.replaceChildren();
    if (Array.isArray(profile.services)) {
      for (const service of profile.services) addService(service);
    }
  };

  byId("add-business-service").addEventListener("click", () => addService());
  byId("business-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("save-business-profile");
    button.disabled = true;
    const services = Array.from(serviceList.children, (row) => {
      const inputs = row.querySelectorAll("input");
      return { name: inputs[0].value, price: inputs[1].value };
    });
    const body = {
      name: byId("business-name").value,
      description: byId("business-description").value,
      hours: byId("business-hours").value,
      services,
      assistant: {
        name: byId("assistant-name").value,
        tone: byId("assistant-tone").value,
        handoff: byId("assistant-handoff").value,
      },
    };
    try {
      await api("/__cloud/auth/business-profile", { method: "PUT", body: JSON.stringify(body) });
      setStatus("Business profile saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Business profile could not be saved.", true);
    } finally { button.disabled = false; }
  });

  const loadProviderConnections = async () => {
    const data = await api("/__cloud/auth/provider-connections");
    if (!Array.isArray(data.connections)) throw new Error("Invalid provider connection response");
    providerList.replaceChildren();
    for (const connection of data.connections) {
      if (!connection || typeof connection.id !== "string" || connection.provider !== "openai" ||
          typeof connection.isActive !== "boolean" || typeof connection.hasCredentials !== "boolean") continue;
      const row = node("li");
      row.className = "provider-row";
      row.append(node("h3", connection.name || "OpenAI"));
      row.append(node("p", (connection.isActive ? "Active" : "Inactive") + " · " +
        (connection.hasCredentials ? "Credential stored" : "No credential")));
      const form = node("form");
      form.className = "provider-form";
      const nameLabel = node("label", "Connection name");
      const name = node("input");
      name.maxLength = 200;
      name.value = typeof connection.name === "string" ? connection.name : "";
      nameLabel.append(name);
      const priorityLabel = node("label", "Priority");
      const priority = node("input");
      priority.type = "number";
      priority.min = "0";
      priority.max = "100000";
      priority.step = "1";
      priority.value = String(Number.isInteger(connection.priority) ? connection.priority : 0);
      priorityLabel.append(priority);
      const activeLabel = node("label", "Connection active");
      const active = node("input");
      active.type = "checkbox";
      active.checked = connection.isActive;
      activeLabel.append(active);
      const keyLabel = node("label", "Replace credential (leave blank to keep current)");
      const key = node("input");
      key.type = "password";
      key.autocomplete = "new-password";
      key.maxLength = 8192;
      keyLabel.append(key);
      const save = node("button", "Save connection");
      save.type = "submit";
      form.append(nameLabel, priorityLabel, activeLabel, keyLabel, save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        const body = { name: name.value || null, priority: Number(priority.value), isActive: active.checked };
        if (key.value) body.apiKey = key.value;
        try {
          await api("/__cloud/auth/provider-connections/" + encodeURIComponent(connection.id), {
            method: "PATCH",
            body: JSON.stringify(body),
          });
          setStatus("Provider connection updated. Credential values are never displayed.");
          await loadProviderConnections();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Provider connection could not be updated.", true);
        } finally { key.value = ""; save.disabled = false; }
      });
      const remove = node("button", "Revoke connection");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api("/__cloud/auth/provider-connections/" + encodeURIComponent(connection.id), {
            method: "DELETE",
          });
          setStatus("Provider connection revoked.");
          await loadProviderConnections();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Provider connection could not be revoked.", true);
          remove.disabled = false;
        }
      });
      row.append(form, remove);
      providerList.append(row);
    }
  };

  byId("provider-connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("create-provider-connection");
    const key = byId("provider-api-key");
    button.disabled = true;
    const body = {
      id: "customer-openai-" + crypto.randomUUID(),
      provider: "openai",
      apiKey: key.value,
      name: byId("provider-connection-name").value || null,
      priority: Number(byId("provider-connection-priority").value || 0),
    };
    try {
      await api("/__cloud/auth/provider-connections", { method: "POST", body: JSON.stringify(body) });
      key.value = "";
      byId("provider-connection-name").value = "";
      setStatus("OpenAI connection created. Credential values are never displayed.");
      await loadProviderConnections();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Provider connection could not be created.", true);
    } finally { key.value = ""; button.disabled = false; }
  });

  const isSupportedMcpEndpoint = (value) => {
    try {
      const endpoint = new URL(value);
      return endpoint.protocol === "https:" && endpoint.hostname.length > 0 &&
        (endpoint.port === "" || endpoint.port === "443") && !endpoint.username &&
        !endpoint.password && !endpoint.search && !endpoint.hash;
    } catch { return false; }
  };
  const loadMcpServers = async () => {
    const data = await api("/__cloud/auth/mcp-servers");
    if (!Array.isArray(data.servers)) throw new Error("Invalid MCP server response");
    const list = byId("mcp-servers");
    list.replaceChildren();
    for (const server of data.servers) {
      if (!server || typeof server.id !== "string" || typeof server.name !== "string" ||
          typeof server.endpoint !== "string" || typeof server.transport !== "string" ||
          typeof server.isActive !== "boolean" || typeof server.hasCredential !== "boolean") continue;
      const row = node("li");
      row.className = "mcp-server-row";
      const form = node("form");
      form.className = "mcp-server-form";
      const nameLabel = node("label", "Server name");
      const name = node("input");
      name.maxLength = 128;
      name.required = true;
      name.value = server.name;
      nameLabel.append(name);
      const transportLabel = node("label", "Transport");
      const transport = node("select");
      const transportOptions = [["streamable_http", "Streamable HTTP"]];
      if (server.transport === "sse") {
        transportOptions.push(["sse", "SSE (legacy, unsupported)"]);
      }
      for (const [value, label] of transportOptions) {
        const option = node("option", label);
        option.value = value;
        option.selected = value === server.transport;
        transport.append(option);
      }
      transportLabel.append(transport);
      const endpointLabel = node("label", "HTTPS endpoint (port 443)");
      const endpoint = node("input");
      endpoint.type = "url";
      endpoint.maxLength = 2048;
      endpoint.required = true;
      endpoint.value = server.endpoint;
      const endpointWasSupported = isSupportedMcpEndpoint(server.endpoint);
      endpointLabel.append(endpoint);
      const activeLabel = node("label", "Server active");
      const active = node("input");
      active.type = "checkbox";
      active.checked = server.isActive;
      activeLabel.append(active);
      const credentialLabel = node("label", "Replace credential (leave blank to keep current)");
      const credential = node("input");
      credential.type = "password";
      credential.autocomplete = "new-password";
      credential.maxLength = 8192;
      credentialLabel.append(credential);
      const save = node("button", "Save MCP server");
      save.type = "submit";
      form.append(nameLabel, transportLabel, endpointLabel, activeLabel, credentialLabel, save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        const endpointIsSupported = isSupportedMcpEndpoint(endpoint.value);
        const migratingUnsupportedConfig =
          (server.transport !== "streamable_http" || !endpointWasSupported) &&
          transport.value === "streamable_http" && endpointIsSupported;
        const body = { name: name.value,
          ...(transport.value !== server.transport || migratingUnsupportedConfig
            ? { transport: transport.value }
            : {}),
          ...(endpoint.value !== server.endpoint || endpointWasSupported || migratingUnsupportedConfig
            ? { endpoint: endpoint.value }
            : {}),
          isActive: active.checked };
        if (credential.value) body.credential = credential.value;
        const serializedBody = JSON.stringify(body);
        credential.value = "";
        try {
          await api("/__cloud/auth/mcp-servers/" + encodeURIComponent(server.id), {
            method: "PUT", body: serializedBody,
          });
          setStatus("MCP server updated. Credentials are never displayed.");
          await loadMcpServers();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "MCP server could not be updated.", true);
        } finally { credential.value = ""; save.disabled = false; }
      });
      const remove = node("button", "Delete MCP server");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api("/__cloud/auth/mcp-servers/" + encodeURIComponent(server.id), { method: "DELETE" });
          setStatus("MCP server deleted.");
          await loadMcpServers();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "MCP server could not be deleted.", true);
          remove.disabled = false;
        }
      });
      row.append(node("p", (server.isActive ? "Active" : "Inactive") + " · " +
        (server.hasCredential ? "Credential stored" : "No credential")), form, remove);
      list.append(row);
    }
  };

  byId("mcp-server-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("create-mcp-server");
    const credential = byId("mcp-server-credential");
    button.disabled = true;
    const body = {
      name: byId("mcp-server-name").value,
      transport: byId("mcp-server-transport").value,
      endpoint: byId("mcp-server-endpoint").value,
      credential: credential.value || null,
    };
    const serializedBody = JSON.stringify(body);
    credential.value = "";
    try {
      await api("/__cloud/auth/mcp-servers", { method: "POST", body: serializedBody });
      byId("mcp-server-name").value = "";
      byId("mcp-server-endpoint").value = "";
      setStatus("MCP server created. Credentials are never displayed.");
      await loadMcpServers();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP server could not be created.", true);
    } finally { credential.value = ""; button.disabled = false; }
  });

  const loadOnboardingReadiness = async () => {
    const data = await api("/__cloud/auth/onboarding");
    const steps = [
      ["activeOwner", "Organization owner assigned"],
      ["activeOwnerApiKey", "Active owner/admin API key available", "Create a replacement key in API key management if needed."],
      ["oidcConfigured", "Organization sign-in configured", "OIDC configuration is managed by a platform admin."],
      ["oidcEnabled", "Organization sign-in enabled", "Only a platform admin can enable OIDC."],
      ["activeProviderConnection", "Provider connection active"],
      ["businessProfileConfigured", "Business profile saved"],
      ["enabledInferenceEntitlement", "Inference entitlement enabled", "Inference is default-deny. Only a platform admin can configure entitlements."],
      ["registeredDevice", "Local Agent device registered"],
      ["localAiEnabled", "Local AI enabled"],
      ["mcpEnabled", "MCP enabled"],
      ["activeMcpServer", "MCP server configured"],
      ["frontDeskConfigured", "Front Desk host configured"],
    ];
    const list = byId("onboarding-readiness");
    list.replaceChildren();
    for (const [key, label, note] of steps) {
      if (typeof data[key] !== "boolean") throw new Error("Invalid onboarding readiness response");
      const row = node("li");
      const state = node("strong", data[key] ? "Complete" : "Awaiting setup");
      row.append(node("span", label + ": "), state);
      if (note) row.append(node("p", note));
      list.append(row);
    }
    return data;
  };

  const loadFrontDeskConfig = async () => {
    const data = await api("/__cloud/auth/front-desk");
    if (!Array.isArray(data.hosts) || !Array.isArray(data.devices)) {
      throw new Error("Invalid Front Desk setup response");
    }
    const hostSelect = byId("front-desk-host");
    const selected = hostSelect.value;
    hostSelect.replaceChildren();
    for (const host of data.hosts) {
      if (!host || typeof host.hostname !== "string" || typeof host.configured !== "boolean") continue;
      const option = node("option", host.hostname + (host.configured ? " · configured" : ""));
      option.value = host.hostname;
      hostSelect.append(option);
    }
    const devices = data.devices.filter((device) => device && typeof device.id === "string" &&
      Array.isArray(device.capabilities) && device.capabilities.every((item) => typeof item === "string"));
    const capabilityByDevice = new Map(devices.map((device) => [device.id, device.capabilities]));
    const deviceSelect = byId("front-desk-device");
    deviceSelect.replaceChildren();
    for (const device of devices) {
      const models = device.capabilities.filter((item) => item.startsWith("ollama:chat:"))
        .map((item) => item.slice("ollama:chat:".length));
      for (const model of models) {
        const option = node("option", device.id + " · " + model);
        option.value = JSON.stringify({ id: device.id, model });
        deviceSelect.append(option);
      }
    }
    const configByHost = new Map(data.hosts.map((host) => [host.hostname, host]));
    hostSelect.value = configByHost.has(selected) ? selected : hostSelect.options[0]?.value || "";
    const fill = () => {
      const host = configByHost.get(hostSelect.value);
      const gateway = host && host.gateway;
      byId("front-desk-configured").textContent = host && host.configured
        ? "Credentials are saved and will never be displayed here. Enter new values only to replace them."
        : "Choose a verified host, then enter the customer API key and gateway details.";
      byId("remove-front-desk-config").disabled = !host?.configured;
      if (!gateway) {
        byId("front-desk-base-url").value = "";
        byId("front-desk-customer-key").value = "";
        byId("front-desk-dashboard-token").value = "";
        byId("front-desk-image-enabled").checked = false;
        byId("front-desk-image-checkpoint").value = "";
        return;
      }
      byId("front-desk-base-url").value = gateway.baseUrl || "";
      const match = devices.flatMap((device) => device.capabilities
        .filter((item) => item === "ollama:chat:" + gateway.ollamaModel)
        .map(() => JSON.stringify({ id: device.id, model: gateway.ollamaModel })))[0];
      if (match) deviceSelect.value = match;
      byId("front-desk-image-enabled").checked = Boolean(gateway.imageGeneration);
      byId("front-desk-image-checkpoint").value = gateway.imageGeneration?.checkpoint || "";
    };
    const updateImageCapability = () => {
      let selection = null;
      try { selection = JSON.parse(deviceSelect.value || "null"); } catch {}
      const capabilities = selection ? capabilityByDevice.get(selection.id) || [] : [];
      const supported = capabilities.includes("comfyui:image");
      byId("front-desk-image-enabled").disabled = !supported;
      if (!supported) byId("front-desk-image-enabled").checked = false;
      byId("front-desk-image-help").textContent = supported
        ? "This device advertises image generation."
        : "Image generation requires a registered device with ComfyUI capability.";
    };
    hostSelect.onchange = fill;
    deviceSelect.onchange = updateImageCapability;
    fill();
    updateImageCapability();
    byId("front-desk-device-help").textContent = devices.length
      ? "Only active tenant devices with an Ollama chat capability are listed."
      : "No active Ollama-capable Local Agent is registered yet.";
  };

  const loadVerifiedCustomerHosts = async () => {
    const data = await api("/__cloud/auth/front-desk/hosts");
    if (!Array.isArray(data.hosts)) throw new Error("Invalid verified host response");
    const list = byId("verified-customer-hosts");
    list.replaceChildren();
    for (const host of data.hosts) {
      if (!host || typeof host.hostname !== "string" || typeof host.verifiedAt !== "string") continue;
      list.append(node("li", host.hostname + " · verified " + host.verifiedAt));
    }
    if (!data.hosts.length) list.append(node("li", "No verified hosts yet."));
  };

  byId("customer-host-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("issue-host-challenge");
    button.disabled = true;
    byId("host-challenge-result").replaceChildren();
    pendingHostChallenge = null;
    try {
      const result = await api("/__cloud/auth/front-desk/hosts/challenge", {
        method: "POST",
        body: JSON.stringify({ hostname: byId("customer-hostname").value }),
      });
      if (typeof result.hostname !== "string" || typeof result.challengeId !== "string" ||
          typeof result.recordName !== "string" || typeof result.recordValue !== "string" ||
          typeof result.expiresAt !== "string") throw new Error("Invalid DNS challenge response");
      pendingHostChallenge = { hostname: result.hostname, challengeId: result.challengeId };
      const output = byId("host-challenge-result");
      output.append(node("p", "Add this DNS TXT record, then verify it. The value is shown only once."));
      output.append(node("p", "Record name: " + result.recordName));
      output.append(node("p", "Record type: TXT"));
      const value = node("code", result.recordValue);
      output.append(value, node("p", "Expires: " + result.expiresAt));
      byId("verify-host-challenge").disabled = false;
      setStatus("DNS ownership challenge issued.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Host challenge could not be issued.", true);
    } finally { button.disabled = false; }
  });

  byId("verify-host-challenge").addEventListener("click", async () => {
    if (!pendingHostChallenge) return;
    const button = byId("verify-host-challenge");
    button.disabled = true;
    try {
      await api("/__cloud/auth/front-desk/hosts/verify", {
        method: "POST",
        body: JSON.stringify(pendingHostChallenge),
      });
      pendingHostChallenge = null;
      byId("host-challenge-result").replaceChildren();
      byId("customer-hostname").value = "";
      setStatus("Host ownership verified and added to Front Desk setup.");
      await loadVerifiedCustomerHosts();
      await loadFrontDeskConfig();
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Host ownership could not be verified.", true);
      button.disabled = false;
    }
  });

  byId("front-desk-config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("save-front-desk-config");
    button.disabled = true;
    try {
      const selection = JSON.parse(byId("front-desk-device").value || "null");
      if (!selection) throw new Error("Register an active Ollama-capable Local Agent first.");
      const imageGeneration = byId("front-desk-image-enabled").checked
        ? { checkpoint: byId("front-desk-image-checkpoint").value || null, width: 1024, height: 1024, steps: 25, cfg: 7 }
        : null;
      await api("/__cloud/auth/front-desk", {
        method: "PUT",
        body: JSON.stringify({
          hostname: byId("front-desk-host").value,
          customerApiKey: byId("front-desk-customer-key").value,
          dashboardToken: byId("front-desk-dashboard-token").value,
          gateway: {
            baseUrl: byId("front-desk-base-url").value,
            deviceId: selection.id,
            ollamaModel: selection.model,
            imageGeneration,
          },
        }),
      });
      byId("front-desk-customer-key").value = "";
      byId("front-desk-dashboard-token").value = "";
      setStatus("Front Desk setup saved. Secret values are never displayed.");
      await loadFrontDeskConfig();
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Front Desk setup could not be saved.", true);
    } finally {
      byId("front-desk-customer-key").value = "";
      byId("front-desk-dashboard-token").value = "";
      button.disabled = false;
    }
  });

  byId("remove-front-desk-config").addEventListener("click", async () => {
    const hostname = byId("front-desk-host").value;
    if (!hostname) return;
    const button = byId("remove-front-desk-config");
    button.disabled = true;
    try {
      await api("/__cloud/auth/front-desk/" + encodeURIComponent(hostname), { method: "DELETE" });
      setStatus("Front Desk configuration removed.");
      await loadFrontDeskConfig();
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Front Desk config could not be removed.", true);
    } finally { button.disabled = false; }
  });

  byId("local-ai-opt-in-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("save-local-ai-opt-in");
    button.disabled = true;
    const localAiEnabled = byId("local-ai-opt-in-enabled").checked;
    try {
      const result = await api("/__cloud/auth/local-ai-settings", {
        method: "PUT", body: JSON.stringify({ localAiEnabled }),
      });
      if (result.localAiEnabled !== localAiEnabled) {
        throw new Error("Local AI setting could not be confirmed");
      }
      setStatus(localAiEnabled
        ? "Local AI enabled. Existing device sessions were revoked; reconnect devices to use Local AI."
        : "Local AI disabled. Existing device sessions were revoked.");
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Local AI setting could not be saved.", true);
    } finally { button.disabled = false; }
  });

  byId("mcp-opt-in-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("save-mcp-opt-in");
    button.disabled = true;
    const mcpEnabled = byId("mcp-opt-in-enabled").checked;
    try {
      const result = await api("/__cloud/auth/mcp-settings", {
        method: "PUT", body: JSON.stringify({ mcpEnabled }),
      });
      if (result.mcpEnabled !== mcpEnabled) throw new Error("MCP setting could not be confirmed");
      byId("mcp-server-panel").hidden = !mcpEnabled;
      if (mcpEnabled) {
        await loadMcpServers();
        setStatus("MCP configuration enabled. Discovery and invocation remain disabled.");
      } else {
        byId("mcp-servers").replaceChildren();
        setStatus("MCP configuration disabled.");
      }
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP setting could not be saved.", true);
    } finally { button.disabled = false; }
  });

  const loadApiKeys = async () => {
    const data = await api("/__cloud/auth/api-keys");
    if (!Array.isArray(data.keys)) throw new Error("Invalid API key list response");
    apiKeyList.replaceChildren();
    for (const key of data.keys) {
      if (!key || typeof key.id !== "string" || typeof key.createdAt !== "string" ||
          (key.expiresAt !== null && typeof key.expiresAt !== "string") ||
          (key.revokedAt !== null && typeof key.revokedAt !== "string")) continue;
      const row = node("li");
      row.className = "api-key-row";
      const revoked = key.revokedAt !== null;
      row.append(node("p", "Created " + formatDate(key.createdAt) + " · " +
        (key.expiresAt ? "Expires " + formatDate(key.expiresAt) : "Does not expire") + " · " +
        (revoked ? "Revoked " + formatDate(key.revokedAt) : "Active")));
      if (!revoked) {
        const revoke = node("button", "Revoke key");
        revoke.type = "button";
        revoke.addEventListener("click", async () => {
          revoke.disabled = true;
          try {
            await api("/__cloud/auth/api-keys/" + encodeURIComponent(key.id), { method: "DELETE" });
            setStatus("API key revoked.");
            await loadApiKeys();
            await loadOnboardingReadiness();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not revoke API key.", true);
            revoke.disabled = false;
          }
        });
        row.append(revoke);
      }
      apiKeyList.append(row);
    }
  };

  byId("api-key-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearIssuedToken();
    const button = byId("issue-api-key");
    button.disabled = true;
    const expiration = byId("api-key-expires-at").value;
    try {
      const data = await api("/__cloud/auth/api-keys", {
        method: "POST",
        body: JSON.stringify({ expiresAt: expiration ? new Date(expiration).toISOString() : null }),
      });
      if (!data.key || typeof data.key.id !== "string" || typeof data.key.createdAt !== "string" ||
          typeof data.key.token !== "string" || !data.key.token) {
        throw new Error("Invalid API key response");
      }
      newlyIssuedToken = data.key.token;
      const token = node("code", newlyIssuedToken);
      const copy = node("button", "Copy and hide token");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(newlyIssuedToken);
          clearIssuedToken();
          setStatus("API key copied. The token was hidden.");
        } catch {
          setStatus("Could not copy the token. You can still copy it manually or hide it.", true);
        }
      });
      const dismiss = node("button", "Hide token");
      dismiss.type = "button";
      dismiss.addEventListener("click", clearIssuedToken);
      apiKeyResult.append(
        node("p", "Copy this API key now. It will not be shown again."), token, copy, dismiss
      );
      byId("api-key-expires-at").value = "";
      setStatus("API key created.");
      await loadApiKeys();
      await loadOnboardingReadiness();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create API key.", true);
    } finally { button.disabled = false; }
  });

  const signIn = (event) => {
    event.preventDefault();
    const slug = byId("tenant-slug").value.trim();
    if (!slug) return setStatus("Enter your organization sign-in name.", true);
    const url = new URL("/__cloud/auth/oidc/login", window.location.origin);
    url.searchParams.set("tenant", slug);
    window.location.assign(url.href);
  };

  const loadMembers = async (cursor = null, append = false) => {
    const url = new URL("/__cloud/auth/members", window.location.origin);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = await api(url.pathname + url.search);
    if (!Array.isArray(data.members)) throw new Error("Invalid member list response");
    if (!append) memberList.replaceChildren();
    for (const member of data.members) {
      if (!member || typeof member.id !== "string" || typeof member.role !== "string" ||
          typeof member.isActive !== "boolean" || typeof member.updatedAt !== "string") continue;
      const row = node("li");
      row.className = "member-row";
      const summary = node("p", member.role + " · " + (member.isActive ? "Active" : "Inactive"));
      const form = node("form");
      form.className = "member-form";
      const roleLabel = node("label", "Role");
      const role = node("select");
      role.setAttribute("aria-label", "Member role");
      const choices = member.role === "owner"
        ? [["owner", "Owner"], ["admin", "Admin"], ["member", "Member"], ["viewer", "Viewer"]]
        : [["admin", "Admin"], ["member", "Member"], ["viewer", "Viewer"]];
      for (const [value, label] of choices) {
        const option = node("option", label);
        option.value = value;
        option.selected = value === member.role;
        role.append(option);
      }
      roleLabel.append(role);
      const activeLabel = node("label", "Active membership");
      const active = node("input");
      active.type = "checkbox";
      active.checked = member.isActive;
      active.setAttribute("aria-label", "Membership active");
      activeLabel.append(active);
      const save = node("button", "Save changes");
      save.type = "submit";
      if (window.customerPortalRole === "admin" && member.role === "owner") {
        role.disabled = true;
        active.disabled = true;
        save.disabled = true;
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = { expectedUpdatedAt: member.updatedAt };
        if (role.value !== member.role) body.role = role.value;
        if (active.checked !== member.isActive) body.isActive = active.checked;
        if (Object.keys(body).length === 1) return setStatus("No membership changes to save.");
        save.disabled = true;
        try {
          await api("/__cloud/auth/members/" + encodeURIComponent(member.id), {
            method: "PATCH",
            body: JSON.stringify(body),
          });
          setStatus("Membership updated.");
          await refreshMembers();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Membership update failed.", true);
        } finally {
          save.disabled = false;
        }
      });
      form.append(roleLabel, activeLabel, save);
      row.append(summary, form);
      memberList.append(row);
    }
    nextCursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
    nextButton.hidden = !nextCursor;
  };

  const refreshMembers = async () => {
    nextCursor = null;
    nextButton.hidden = true;
    await loadMembers();
  };

  signInForm.addEventListener("submit", signIn);
  nextButton.addEventListener("click", async () => {
    if (!nextCursor) return;
    nextButton.disabled = true;
    try { await loadMembers(nextCursor, true); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not load members.", true); }
    finally { nextButton.disabled = false; }
  });

  byId("logout").addEventListener("click", async () => {
    try {
      await api("/__cloud/auth/logout", { method: "POST" });
      window.location.assign("/__cloud/portal");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign out failed.", true);
    }
  });

  byId("invitation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("issue-invitation");
    button.disabled = true;
    try {
      const data = await api("/__cloud/auth/members/invitations", {
        method: "POST",
        body: JSON.stringify({ role: byId("invite-role").value }),
      });
      byId("invitation-result").replaceChildren(
        node("p", "Share this one-use invitation code. It expires " + data.expiresAt + "."),
        node("code", data.code)
      );
      setStatus("Invitation created.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create invitation.", true);
    } finally { button.disabled = false; }
  });

  const loadOidcDraft = async () => {
    const result = await api("/__cloud/auth/oidc-draft");
    const draft = result.draft;
    byId("oidc-draft-status").textContent = draft
      ? "A pending issuer draft is saved. It does not change organization sign-in."
      : "No pending issuer draft is saved.";
    byId("oidc-draft-issuer").value = draft?.issuer || "";
    byId("oidc-draft-client-id").value = draft?.clientId || "";
    byId("oidc-draft-scopes").value = Array.isArray(draft?.scopes)
      ? draft.scopes.join(" ")
      : "openid profile email";
    byId("oidc-draft-client-secret").value = "";
    byId("delete-oidc-draft").disabled = !draft;
    byId("test-oidc-draft").disabled = !draft;
    byId("promote-oidc-draft").disabled = !draft || window.customerPortalRole !== "owner";
  };

  byId("oidc-draft-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("save-oidc-draft");
    const secret = byId("oidc-draft-client-secret");
    button.disabled = true;
    try {
      const scopes = byId("oidc-draft-scopes").value.trim().split(/\s+/).filter(Boolean);
      await api("/__cloud/auth/oidc-draft", {
        method: "PUT",
        body: JSON.stringify({
          issuer: byId("oidc-draft-issuer").value.trim(),
          clientId: byId("oidc-draft-client-id").value.trim(),
          clientSecret: secret.value,
          scopes,
        }),
      });
      secret.value = "";
      setStatus("Pending issuer draft saved. Organization sign-in is unchanged.");
      await loadOidcDraft();
    } catch (error) {
      secret.value = "";
      setStatus(error instanceof Error ? error.message : "Could not save issuer draft.", true);
    } finally { secret.value = ""; button.disabled = false; }
  });

  byId("delete-oidc-draft").addEventListener("click", async () => {
    const button = byId("delete-oidc-draft");
    button.disabled = true;
    try {
      await api("/__cloud/auth/oidc-draft", { method: "DELETE" });
      setStatus("Pending issuer draft deleted.");
      await loadOidcDraft();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete issuer draft.", true);
    } finally { button.disabled = false; }
  });

  byId("test-oidc-draft").addEventListener("click", async () => {
    const button = byId("test-oidc-draft");
    button.disabled = true;
    try {
      const result = await api("/__cloud/auth/oidc-draft", { method: "POST" });
      if (result.validated !== true) throw new Error("Issuer discovery could not be confirmed.");
      setStatus("Issuer discovery succeeded. This does not test sign-in or activate the setup.");
    } catch (error) {
      setStatus(
        error instanceof Error && error.message !== "Request failed"
          ? error.message
          : "Issuer discovery could not be confirmed. Check the issuer setup and try again.",
        true
      );
    } finally { button.disabled = false; }
  });

  byId("promote-oidc-draft").addEventListener("click", async () => {
    const button = byId("promote-oidc-draft");
    button.disabled = true;
    try {
      const preview = await api("/__cloud/auth/oidc-draft/promotion", {
        method: "POST",
        body: JSON.stringify({ action: "preview" }),
      });
      const count = Number(preview.otherIdentityLinkCount);
      const noun = count === 1 ? "other identity link" : "other identity links";
      const confirmed = window.confirm(
        "Switch organization sign-in to the pending issuer? " + count + " " + noun +
          " will be invalidated. Other affected members will need to be re-invited and sign in again. Your owner account will be verified with the new issuer. Existing memberships and API keys stay in place. Continue?"
      );
      if (!confirmed) {
        setStatus("Issuer switch cancelled. The active sign-in setup is unchanged.");
        return;
      }
      const result = await api("/__cloud/auth/oidc-draft/promotion", {
        method: "POST",
        body: JSON.stringify({
          action: "confirm",
          draftUpdatedAt: preview.draftUpdatedAt,
          configUpdatedAt: preview.configUpdatedAt,
          otherIdentityLinkCount: count,
        }),
      });
      const authorizationUrl = new URL(result.authorizationUrl);
      if (authorizationUrl.protocol !== "https:") throw new Error("Invalid sign-in destination");
      window.location.assign(authorizationUrl.href);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start issuer verification.", true);
    } finally { button.disabled = false; }
  });

  inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("redeem-invitation");
    button.disabled = true;
    try {
      const data = await api("/__cloud/auth/oidc/invitations/redeem", {
        method: "POST",
        body: JSON.stringify({ code: byId("invitation-code").value.trim() }),
      });
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== "https:") throw new Error("Invalid sign-in destination");
      byId("invitation-code").value = "";
      window.location.assign(authorizationUrl.href);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invitation could not be accepted.", true);
      button.disabled = false;
    }
  });

  (async () => {
    let session;
    try {
      session = await api("/__cloud/auth/session");
      if (session.authenticated !== true || !session.tenant || !session.membership) {
        throw new Error("Session response unavailable");
      }
    } catch {
      byId("signin-panel").hidden = false;
      return;
    }
    try {
      byId("signin-panel").hidden = true;
      byId("portal-panel").hidden = false;
      byId("tenant-name").textContent = session.tenant.name;
      byId("tenant-slug-label").textContent = session.tenant.slug;
      byId("membership-role").textContent = session.membership.role;
      window.customerPortalRole = session.membership.role;
      if (session.membership.role === "owner" || session.membership.role === "admin") {
        byId("api-key-panel").hidden = false;
        byId("manager-panel").hidden = false;
        byId("business-profile-panel").hidden = false;
        byId("provider-connection-panel").hidden = false;
        byId("local-ai-settings-panel").hidden = false;
        byId("mcp-settings-panel").hidden = false;
        byId("front-desk-config-panel").hidden = false;
        byId("customer-host-panel").hidden = false;
        byId("onboarding-readiness-panel").hidden = false;
        byId("oidc-draft-panel").hidden = false;
        try {
          await loadBusinessProfile();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load business profile.", true);
        }
        try {
          await loadVerifiedCustomerHosts();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load verified hosts.", true);
        }
        try {
          await loadFrontDeskConfig();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load Front Desk setup.", true);
        }
        try {
          await loadProviderConnections();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load provider connections.", true);
        }
        try {
          const readiness = await loadOnboardingReadiness();
          byId("local-ai-opt-in-enabled").checked = readiness.localAiEnabled;
          byId("mcp-opt-in-enabled").checked = readiness.mcpEnabled;
          byId("mcp-server-panel").hidden = !readiness.mcpEnabled;
          if (readiness.mcpEnabled) await loadMcpServers();
        } catch (error) {
          byId("mcp-server-panel").hidden = true;
          setStatus(error instanceof Error ? error.message : "Could not load onboarding readiness.", true);
        }
        try {
          await loadApiKeys();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load API keys.", true);
        }
        try {
          await loadMembers();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load members.", true);
        }
        try {
          await loadOidcDraft();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load issuer draft.", true);
        }
      } else {
        byId("member-readonly").hidden = false;
      }
    } catch { setStatus("Customer portal could not be loaded.", true); }
  })();
})();
`;

function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function handleCloudCustomerPortalRequest(request: Request): Response | null {
  if (new URL(request.url).pathname !== CLOUD_CUSTOMER_PORTAL_PATH) return null;
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" },
    });
  }
  const nonce = createNonce();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OmniRoute customer portal</title>
    <style nonce="${nonce}">
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0 auto; max-width: 54rem; padding: 2rem 1rem; }
      main { display: grid; gap: 1.5rem; }
      section, .member-row, .provider-row { border: 1px solid #8888; border-radius: .75rem; padding: 1rem; }
      form, .member-form, .service-row, .provider-form { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; }
      textarea { font: inherit; min-width: min(28rem, 80vw); min-height: 4rem; }
      label { display: grid; gap: .25rem; }
      input, select, button { font: inherit; padding: .5rem; }
      button { cursor: pointer; }
      button:disabled { cursor: wait; }
      ul { display: grid; gap: .75rem; padding: 0; list-style: none; }
      [hidden] { display: none !important; }
      #status[data-state="error"] { color: #d33; }
      code { display: block; overflow-wrap: anywhere; margin-top: .5rem; }
    </style>
  </head>
  <body>
    <main>
      <header><h1>OmniRoute customer portal</h1><p id="status" role="status" aria-live="polite"></p></header>
      <section id="signin-panel" hidden>
        <h2>Sign in</h2>
        <form id="signin-form">
          <label for="tenant-slug">Organization sign-in name</label>
          <input id="tenant-slug" name="tenant" autocomplete="organization" required maxlength="100">
          <button type="submit">Continue with your organization</button>
        </form>
        <h2>Accept an invitation</h2>
        <form id="redeem-form">
          <label for="invitation-code">One-use invitation code</label>
          <input id="invitation-code" autocomplete="off" required maxlength="128">
          <button id="redeem-invitation" type="submit">Continue to sign in</button>
        </form>
      </section>
      <section id="portal-panel" hidden>
        <h2 id="tenant-name"></h2>
        <p>Organization: <span id="tenant-slug-label"></span> · Your role: <span id="membership-role"></span></p>
        <button id="logout" type="button">Sign out</button>
        <p id="member-readonly" hidden>Your account does not have member-management access.</p>
      </section>
      <section id="api-key-panel" hidden>
        <h2>Your API keys</h2>
        <p>API keys grant access to your organization. Store them securely and revoke any key you no longer need.</p>
        <ul id="api-keys"></ul>
        <h3>Create an API key</h3>
        <form id="api-key-form">
          <label for="api-key-expires-at">Expiration (optional)</label>
          <input id="api-key-expires-at" type="datetime-local">
          <button id="issue-api-key" type="submit">Create API key</button>
        </form>
        <div id="api-key-result" aria-live="polite"></div>
      </section>
      <section id="manager-panel" hidden>
        <h2>Members</h2>
        <ul id="members"></ul>
        <button id="next-page" type="button" hidden>Load more members</button>
        <h2>Invite a member</h2>
        <form id="invitation-form">
          <label for="invite-role">Role</label>
          <select id="invite-role">
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
          <button id="issue-invitation" type="submit">Create one-use invitation</button>
        </form>
        <div id="invitation-result" aria-live="polite"></div>
      </section>
      <section id="business-profile-panel" hidden>
        <h2>Business profile</h2>
        <p>This information is used by your configured customer experience.</p>
        <form id="business-profile-form">
          <label for="business-name">Business name</label>
          <input id="business-name" maxlength="120" required>
          <label for="business-description">Description</label>
          <textarea id="business-description" maxlength="1000"></textarea>
          <label for="business-hours">Hours</label>
          <input id="business-hours" maxlength="250">
          <h3>Services</h3>
          <ul id="business-services"></ul>
          <button id="add-business-service" type="button">Add service</button>
          <h3>Assistant</h3>
          <label for="assistant-name">Assistant name</label>
          <input id="assistant-name" maxlength="100" required>
          <label for="assistant-tone">Tone</label>
          <input id="assistant-tone" maxlength="250" required>
          <label for="assistant-handoff">When to hand off to a person</label>
          <textarea id="assistant-handoff" maxlength="1000" required></textarea>
          <button id="save-business-profile" type="submit">Save business profile</button>
        </form>
      </section>
      <section id="provider-connection-panel" hidden>
        <h2>OpenAI provider connections</h2>
        <p>Inference requests can select supported OpenAI text models enabled by your organization’s platform-admin D1 entitlements. The original gpt-4o-mini-2024-07-18 model remains the default. Credentials are encrypted before storage and are never returned to this page.</p>
        <ul id="provider-connections"></ul>
        <h3>Add an OpenAI connection</h3>
        <form id="provider-connection-form">
          <label for="provider-connection-name">Connection name</label>
          <input id="provider-connection-name" maxlength="200" autocomplete="off">
          <label for="provider-connection-priority">Priority</label>
          <input id="provider-connection-priority" type="number" min="0" max="100000" step="1" value="0" required>
          <label for="provider-api-key">OpenAI API key</label>
          <input id="provider-api-key" type="password" autocomplete="new-password" maxlength="8192" required>
          <button id="create-provider-connection" type="submit">Add OpenAI connection</button>
        </form>
      </section>
      <section id="local-ai-settings-panel" hidden>
        <h2>Local AI</h2>
        <p>Allow this tenant to connect registered Local Agent devices. Local services stay on customer hardware and are reached through the authenticated outbound gateway.</p>
        <form id="local-ai-opt-in-form">
          <label for="local-ai-opt-in-enabled">Allow Local AI connections</label>
          <input id="local-ai-opt-in-enabled" type="checkbox">
          <button id="save-local-ai-opt-in" type="submit">Save Local AI setting</button>
        </form>
      </section>
      <section id="mcp-settings-panel" hidden>
        <h2>MCP configuration</h2>
        <p>This allows your organization to manage saved MCP server settings. It does not enable discovery or tool invocation.</p>
        <form id="mcp-opt-in-form">
          <label for="mcp-opt-in-enabled">Allow MCP server configuration</label>
          <input id="mcp-opt-in-enabled" type="checkbox">
          <button id="save-mcp-opt-in" type="submit">Save MCP setting</button>
        </form>
      </section>
      <section id="mcp-server-panel" hidden>
        <h2>MCP server registrations</h2>
          <p>Configure tenant-owned Streamable HTTP MCP endpoints on HTTPS port 443. Credentials are encrypted before storage and never shown again. Discovery and tool calls remain disabled until controlled egress is enabled.</p>
        <ul id="mcp-servers"></ul>
        <h3>Add an MCP server</h3>
        <form id="mcp-server-form">
          <label for="mcp-server-name">Server name</label>
          <input id="mcp-server-name" maxlength="128" required>
          <label for="mcp-server-transport">Transport</label>
          <select id="mcp-server-transport"><option value="streamable_http">Streamable HTTP</option></select>
          <label for="mcp-server-endpoint">HTTPS endpoint (port 443)</label>
          <input id="mcp-server-endpoint" type="url" maxlength="2048" required>
          <label for="mcp-server-credential">Credential (optional)</label>
          <input id="mcp-server-credential" type="password" autocomplete="new-password" maxlength="8192">
          <button id="create-mcp-server" type="submit">Add MCP server</button>
        </form>
      </section>
      <section id="customer-host-panel" hidden>
        <h2>Verify a Front Desk host</h2>
        <p>Enter the hostname you control. Add the DNS TXT record shown below, then verify ownership. TXT values are disclosed once and are never stored in plain text.</p>
        <ul id="verified-customer-hosts"></ul>
        <form id="customer-host-form">
          <label for="customer-hostname">Hostname</label>
          <input id="customer-hostname" type="text" maxlength="253" autocomplete="url" required>
          <button id="issue-host-challenge" type="submit">Issue DNS challenge</button>
        </form>
        <div id="host-challenge-result" aria-live="polite"></div>
        <button id="verify-host-challenge" type="button" disabled>Verify DNS record</button>
      </section>
      <section id="front-desk-config-panel" hidden>
        <h2>Front Desk setup</h2>
        <p>Configure one of your verified customer hosts.</p>
        <p id="front-desk-configured" aria-live="polite"></p>
        <form id="front-desk-config-form">
          <label for="front-desk-host">Verified customer host</label>
          <select id="front-desk-host" required></select>
          <label for="front-desk-customer-key">Customer owner/admin API key</label>
          <input id="front-desk-customer-key" type="password" autocomplete="new-password" maxlength="128" required>
          <label for="front-desk-dashboard-token">Front Desk dashboard token</label>
          <input id="front-desk-dashboard-token" type="password" autocomplete="new-password" minlength="32" maxlength="256" required>
          <label for="front-desk-base-url">Local Agent gateway URL</label>
          <input id="front-desk-base-url" type="url" maxlength="2048" required>
          <label for="front-desk-device">Active Local Agent and model</label>
          <select id="front-desk-device" required></select>
          <p id="front-desk-device-help"></p>
          <label for="front-desk-image-enabled">Enable image generation for this gateway</label>
          <input id="front-desk-image-enabled" type="checkbox">
          <p id="front-desk-image-help"></p>
          <label for="front-desk-image-checkpoint">Image checkpoint (optional)</label>
          <input id="front-desk-image-checkpoint" maxlength="128">
          <button id="save-front-desk-config" type="submit">Save Front Desk setup</button>
          <button id="remove-front-desk-config" type="button">Remove this host setup</button>
        </form>
      </section>
      <section id="onboarding-readiness-panel" hidden>
        <h2>Onboarding readiness</h2>
        <p>This checklist reports setup status only. OIDC configuration and inference entitlements can be changed only by a platform admin. Inference access is default-deny.</p>
        <ul id="onboarding-readiness"></ul>
      </section>
      <section id="oidc-draft-panel" hidden>
        <h2>Pending organization sign-in setup</h2>
        <p id="oidc-draft-status" aria-live="polite"></p>
        <p>Owners and admins can save issuer details and test discovery. Only an owner can switch sign-in, which requires verified sign-in with the new issuer and explicit confirmation. Other linked users will need to be re-invited; their memberships and API keys remain.</p>
        <form id="oidc-draft-form">
          <label for="oidc-draft-issuer">Issuer URL</label>
          <input id="oidc-draft-issuer" type="url" maxlength="500" required>
          <label for="oidc-draft-client-id">Client ID</label>
          <input id="oidc-draft-client-id" maxlength="200" required>
          <label for="oidc-draft-client-secret">Client secret</label>
          <input id="oidc-draft-client-secret" type="password" autocomplete="new-password" maxlength="500" required>
          <label for="oidc-draft-scopes">Scopes (space separated)</label>
          <input id="oidc-draft-scopes" maxlength="2000" value="openid profile email" required>
          <button id="save-oidc-draft" type="submit">Save pending sign-in setup</button>
          <button id="test-oidc-draft" type="button" disabled>Test issuer discovery</button>
          <button id="promote-oidc-draft" type="button" disabled>Verify and switch sign-in</button>
          <button id="delete-oidc-draft" type="button" disabled>Delete pending setup</button>
        </form>
      </section>
    </main>
    <script nonce="${nonce}">${PORTAL_SCRIPT}</script>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'none'; font-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
