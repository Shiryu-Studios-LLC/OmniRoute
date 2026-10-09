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
      for (const [value, label] of [["streamable_http", "Streamable HTTP"], ["sse", "SSE"]]) {
        const option = node("option", label);
        option.value = value;
        option.selected = value === server.transport;
        transport.append(option);
      }
      transportLabel.append(transport);
      const endpointLabel = node("label", "HTTPS endpoint");
      const endpoint = node("input");
      endpoint.type = "url";
      endpoint.maxLength = 2048;
      endpoint.required = true;
      endpoint.value = server.endpoint;
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
        const body = { name: name.value, transport: transport.value, endpoint: endpoint.value,
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
        byId("mcp-server-panel").hidden = false;
        try {
          await loadBusinessProfile();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load business profile.", true);
        }
        try {
          await loadProviderConnections();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load provider connections.", true);
        }
        try {
          await loadMcpServers();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not load MCP servers.", true);
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
        <p>Connections use the fixed OmniRoute model gpt-4o-mini-2024-07-18. Credentials are encrypted before storage and are never returned to this page.</p>
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
      <section id="mcp-server-panel" hidden>
        <h2>MCP server registrations</h2>
        <p>Configure tenant-owned MCP endpoints. Credentials are encrypted before storage and never shown again. Discovery and tool calls remain disabled until controlled egress is enabled.</p>
        <ul id="mcp-servers"></ul>
        <h3>Add an MCP server</h3>
        <form id="mcp-server-form">
          <label for="mcp-server-name">Server name</label>
          <input id="mcp-server-name" maxlength="128" required>
          <label for="mcp-server-transport">Transport</label>
          <select id="mcp-server-transport"><option value="streamable_http">Streamable HTTP</option><option value="sse">SSE</option></select>
          <label for="mcp-server-endpoint">HTTPS endpoint</label>
          <input id="mcp-server-endpoint" type="url" maxlength="2048" required>
          <label for="mcp-server-credential">Credential (optional)</label>
          <input id="mcp-server-credential" type="password" autocomplete="new-password" maxlength="8192">
          <button id="create-mcp-server" type="submit">Add MCP server</button>
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
