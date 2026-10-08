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
  let nextCursor = null;

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
        byId("manager-panel").hidden = false;
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
      section, .member-row { border: 1px solid #8888; border-radius: .75rem; padding: 1rem; }
      form, .member-form { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; }
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
