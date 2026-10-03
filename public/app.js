// CRM Chat UI. Plain JS, no build step. Every piece of user or directory text goes through textContent.

const $ = (id) => document.getElementById(id);
const SOURCE_LABEL = { werdna: "Werdna", hubspot: "HubSpot", salesforce: "Salesforce", google: "Google", microsoft: "Microsoft", demo: "Demo" };

const state = {
  me: null,
  people: new Map(),
  online: new Set(),
  channels: new Map(),
  current: null,
  messages: [],
  filter: "",
  unread: new Set(),
  events: null,
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function avatar(person, size = "") {
  const node = el("span", { class: `avatar ${size}` });
  if (person?.avatarUrl) {
    const img = el("img", { src: person.avatarUrl, alt: "" });
    img.addEventListener("error", () => img.replaceWith(initials(person.name)));
    node.append(img);
  } else node.textContent = initials(person?.name ?? "?");
  // A stable hue per person, so the same face reads the same everywhere.
  let h = 0;
  for (const ch of person?.email ?? "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  node.style.setProperty("--hue", h);
  return node;
}

function sourceBadges(sources) {
  return sources.map((s) => el("span", { class: `badge src-${s}` }, SOURCE_LABEL[s] ?? s));
}

function channelLabel(c) {
  if (c.kind === "dm") return state.people.get(c.peerId)?.name ?? "Direct message";
  return `# ${c.title}`;
}

// ---------- sign in ----------

let passwordProvider = null;

async function showSignin() {
  $("app").hidden = true;
  $("signin").hidden = false;
  // A failed "Log in with" comes back as ?error=...; show it once, then tidy the address bar.
  const params = new URLSearchParams(location.search);
  showSigninError(params.get("error"));
  if (params.has("error")) history.replaceState(null, "", "/");

  const { providers, demo } = await api("/api/signin");
  passwordProvider = providers.find((p) => p.kind === "password") ?? null;
  // One plain choice per company system. "Log in with X" goes to X's own page, so those are links; a password
  // provider opens its two fields in place.
  $("signin-buttons").replaceChildren(
    ...providers.map((p) =>
      p.kind === "redirect"
        ? el("a", { class: `signin-btn src-${p.id}`, href: `/auth/${encodeURIComponent(p.id)}/start` }, p.label)
        : el("button", { type: "button", class: `signin-btn src-${p.id}`, onclick: openPasswordForm }, p.label),
    ),
  );
  $("signin-buttons").hidden = false;
  $("password-form").hidden = true;
  $("signin-none").hidden = providers.length > 0 || demo;

  $("demo-people").hidden = !demo;
  $("demo-list").hidden = true;
  if (demo) {
    const people = await api("/api/demo-people").catch(() => []);
    $("demo-people").hidden = people.length === 0;
    $("demo-list").replaceChildren(
      ...people.map((p) => el("button", { type: "button", class: "demo-person", title: p.title ?? "", onclick: () => signIn("/api/session/demo", { email: p.email }) }, p.name)),
    );
  }
}

function openPasswordForm() {
  $("signin-buttons").hidden = true;
  $("password-form").hidden = false;
  $("password-email").placeholder = `${passwordProvider.label} email`;
  $("password-email").focus();
}

$("demo-toggle").addEventListener("click", () => ($("demo-list").hidden = !$("demo-list").hidden));

function closePasswordForm() {
  $("password-form").hidden = true;
  $("signin-buttons").hidden = false;
}
$("password-back").addEventListener("click", closePasswordForm);
$("password-form").addEventListener("keydown", (e) => e.key === "Escape" && closePasswordForm());

function showSigninError(message) {
  $("signin-error").textContent = message ?? "";
  $("signin-error").hidden = !message;
}

async function signIn(path, body) {
  showSigninError(null);
  try {
    state.me = await api(path, { method: "POST", body });
    await startApp();
  } catch (err) {
    showSigninError(err.message);
  }
}

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("password-submit");
  button.disabled = true;
  await signIn("/api/session/password", { provider: passwordProvider.id, email: $("password-email").value, password: $("password-password").value });
  // The password leaves the page as soon as it has been used.
  $("password-password").value = "";
  button.disabled = false;
});

// ---------- app ----------

async function loadDirectory() {
  const me = await api("/api/me");
  $("company").textContent = me.company ?? "";
  const { people, online } = await api("/api/people");
  state.people = new Map(people.map((p) => [p.id, p]));
  state.online = new Set(online);
  const channels = await api("/api/channels");
  state.channels = new Map(channels.map((c) => [c.id, c]));
}

async function startApp() {
  $("signin").hidden = true;
  $("app").hidden = false;
  await loadDirectory();
  renderMe();
  renderSidebar();
  const first = state.current && state.channels.has(state.current) ? state.current : "general";
  await openChannel(first);
  listen();
}

function renderMe() {
  const me = state.me;
  $("me").replaceChildren(
    avatar(me),
    el("div", { class: "me-text" }, el("strong", {}, me.name), el("span", { class: "muted small" }, me.title ?? me.email)),
    el("button", { class: "link small", onclick: signOut }, "Sign out"),
  );
}

async function signOut() {
  await api("/api/session", { method: "DELETE" }).catch(() => {});
  state.events?.close();
  state.me = null;
  showSignin();
}

function matches(text) {
  return !state.filter || text.toLowerCase().includes(state.filter);
}

function renderSidebar() {
  const channels = [...state.channels.values()];
  const item = (c, ...extra) =>
    el(
      "li",
      {},
      el(
        "button",
        { class: `nav-item ${c.id === state.current ? "active" : ""} ${state.unread.has(c.id) ? "unread" : ""}`, onclick: () => openChannel(c.id) },
        el("span", { class: "nav-label" }, channelLabel(c)),
        ...extra,
      ),
    );

  $("channels").replaceChildren(
    ...channels.filter((c) => c.kind === "custom" && matches(c.title)).sort((a, b) => a.title.localeCompare(b.title)).map((c) => item(c)),
  );
  // Teams appear when the company's system names them; a company with none simply has no Teams section.
  $("teams-head").hidden = !channels.some((c) => c.kind === "team");
  $("teams").replaceChildren(
    ...channels
      .filter((c) => c.kind === "team" && matches(c.title))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => item(c, el("span", { class: "count" }, String(c.memberCount ?? "")))),
  );

  const people = [...state.people.values()].filter((p) => p.id !== state.me.id && matches(`${p.name} ${p.email} ${p.title ?? ""}`));
  const dmFor = (p) => [...state.channels.values()].find((c) => c.kind === "dm" && c.peerId === p.id);
  $("people").replaceChildren(
    ...people.map((p) => {
      const dm = dmFor(p);
      return el(
        "li",
        {},
        el(
          "button",
          { class: `nav-item person ${dm && dm.id === state.current ? "active" : ""} ${dm && state.unread.has(dm.id) ? "unread" : ""}`, onclick: () => openDm(p.id) },
          el("span", { class: `dot ${state.online.has(p.id) ? "on" : ""}` }),
          el("span", { class: "nav-label" }, p.name),
          ...sourceBadges(p.sources).map((b) => (b.classList.add("tiny"), b)),
        ),
      );
    }),
  );
}

$("people-search").addEventListener("input", (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  renderSidebar();
});

async function openDm(personId) {
  const channel = await api("/api/dms", { method: "POST", body: { personId } });
  state.channels.set(channel.id, channel);
  await openChannel(channel.id);
}

async function openChannel(id) {
  const c = state.channels.get(id);
  if (!c) return;
  state.current = id;
  state.unread.delete(id);
  document.body.classList.remove("sidebar-open");
  $("channel-title").textContent = channelLabel(c);
  const sub = $("channel-sub");
  if (c.kind === "team") sub.textContent = `${c.memberCount} people on this team`;
  else if (c.kind === "dm") {
    const p = state.people.get(c.peerId);
    sub.replaceChildren(p?.title ?? "", " ", ...(p ? sourceBadges(p.sources) : []));
  } else sub.textContent = "Everyone in the company";
  $("composer-text").placeholder = `Message ${channelLabel(c)}`;
  state.messages = await api(`/api/channels/${encodeURIComponent(id)}/messages`);
  renderSidebar();
  renderMessages();
  $("composer-text").focus();
}

function renderMessages() {
  const box = $("messages");
  const nodes = [];
  let prev = null;
  for (const m of state.messages) {
    const author = state.people.get(m.authorId) ?? { name: "Former member", email: "" };
    const at = new Date(m.at);
    const grouped = prev && prev.authorId === m.authorId && at - new Date(prev.at) < 5 * 60_000;
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    nodes.push(
      grouped
        ? el("div", { class: "msg grouped" }, el("span", { class: "msg-time" }, time), el("div", { class: "msg-text" }, m.text))
        : el(
            "div",
            { class: "msg" },
            el("button", { class: "avatar-btn", onclick: () => showProfile(m.authorId) }, avatar(author)),
            el(
              "div",
              {},
              el(
                "div",
                { class: "msg-head" },
                el("button", { class: "author", onclick: () => showProfile(m.authorId) }, author.name),
                el("span", { class: "muted small" }, author.title ?? ""),
                el("span", { class: "msg-time" }, time),
              ),
              el("div", { class: "msg-text" }, m.text),
            ),
          ),
    );
    prev = m;
  }
  if (nodes.length === 0) nodes.push(el("div", { class: "empty muted" }, "No messages yet. Say hello."));
  box.replaceChildren(...nodes);
  box.scrollTop = box.scrollHeight;
}

function showProfile(personId) {
  const p = state.people.get(personId);
  const panel = $("profile");
  if (!p) return;
  panel.replaceChildren(
    el("button", { class: "icon-btn close", onclick: () => (panel.hidden = true) }, "✕"),
    avatar(p, "large"),
    el("h3", {}, p.name),
    el("div", { class: "muted" }, p.title ?? ""),
    el("a", { href: `mailto:${p.email}` }, p.email),
    el("div", { class: "profile-section" }, el("div", { class: "muted small" }, "From"), el("div", {}, ...sourceBadges(p.sources))),
    p.teams.length ? el("div", { class: "profile-section" }, el("div", { class: "muted small" }, "Teams"), el("div", {}, p.teams.join(", "))) : null,
    p.id !== state.me.id ? el("button", { onclick: () => { panel.hidden = true; openDm(p.id); } }, "Message") : null,
  );
  panel.hidden = false;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = $("composer-text");
  const text = box.value.trim();
  if (!text || !state.current) return;
  box.value = "";
  autosize();
  try {
    await api(`/api/channels/${encodeURIComponent(state.current)}/messages`, { method: "POST", body: { text } });
  } catch (err) {
    box.value = text;
    alert(err.message);
  }
});

function autosize() {
  const box = $("composer-text");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
}
$("composer-text").addEventListener("input", autosize);
$("composer-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("new-channel").addEventListener("click", async () => {
  const title = prompt("Channel name");
  if (!title) return;
  try {
    const c = await api("/api/channels", { method: "POST", body: { title } });
    state.channels.set(c.id, c);
    openChannel(c.id);
  } catch (err) {
    alert(err.message);
  }
});

$("toggle-sidebar").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));

function listen() {
  state.events?.close();
  const es = new EventSource("/api/events");
  state.events = es;
  es.onmessage = async (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "message") {
      if (event.message.channelId === state.current) {
        state.messages.push(event.message);
        renderMessages();
      } else {
        // Unseen activity: bold the channel until it is opened.
        if (!state.channels.has(event.message.channelId)) state.channels = new Map((await api("/api/channels")).map((x) => [x.id, x]));
        state.unread.add(event.message.channelId);
        renderSidebar();
      }
    } else if (event.type === "channel") {
      state.channels.set(event.channel.id, event.channel);
      renderSidebar();
    } else if (event.type === "presence") {
      state.online = new Set(event.online);
      renderSidebar();
    } else if (event.type === "directory") {
      await loadDirectory().catch(() => signOut());
      renderSidebar();
    }
  };
}

// ---------- boot ----------

const { person } = await api("/api/me");
if (person) {
  state.me = person;
  await startApp();
} else {
  await showSignin();
}
