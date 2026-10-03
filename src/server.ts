import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { seal, unseal } from "./session.ts";
import { pkce, randomToken } from "./signin/oauth.ts";
import { type Identity, type RedirectProvider, type SignInContext, SignInError, type SignInProvider } from "./signin/types.ts";
import { type Channel, isActive, type Person, Store, teamsOf } from "./store.ts";

// A dependency-free HTTP server: "Log in with" sign-in, a JSON API, Server-Sent Events for live updates, and
// the static UI. It keeps no passwords and no user list: each company's own system says who someone is.

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 256 * 1024;
const MAX_MESSAGE = 4000;
const COOKIE = "crmchat_session";
const PENDING = "crmchat_signin";
/** A working day. After that, people sign in through their company again. */
const SESSION_SECONDS = 12 * 60 * 60;
const PENDING_SECONDS = 10 * 60;

export interface AppOptions {
  /** The "Log in with" choices offered; each company's own system does the checking. */
  providers?: SignInProvider[];
  ctx?: SignInContext;
  /** Where people reach this app. Providers send people back to `${baseUrl}/auth/<provider>/callback`. */
  baseUrl?: string;
  /** Signs the session cookie. Without one, a random one per start: a restart then signs everyone out. */
  sessionSecret?: string;
  /** The made-up company, for trying the app before any provider is set up. */
  demo?: Store;
}

/** One company's chat. Companies never see each other's people, channels or messages. */
interface Workspace {
  key: string;
  name: string;
  store: Store;
}

interface SessionClaims {
  /** Workspace key, workspace name. */
  w: string;
  wn: string;
  /** Email, name, picture, and the provider that vouched for them. */
  e: string;
  n: string;
  a?: string;
  p: string;
}

interface PendingClaims {
  p: string;
  s: string;
  n: string;
  v: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring a JSON content type means a cross-site form post cannot reach the API without a CORS preflight.
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
  res.end();
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createApp(options: AppOptions = {}) {
  const providers = options.providers ?? [];
  const ctx: SignInContext = options.ctx ?? { fetch: (input, init) => fetch(input, init) };
  const baseUrl = (options.baseUrl ?? "http://localhost:4310").replace(/\/+$/, "");
  const secret = options.sessionSecret || randomBytes(32).toString("base64url");
  const secure = baseUrl.startsWith("https://") ? "; Secure" : "";
  const workspaces = new Map<string, Workspace>();
  const streams = new Map<ServerResponse, { ws: Workspace; person: Person }>();

  function workspace(key: string, name: string, store = new Store()): Workspace {
    const existing = workspaces.get(key);
    if (existing) return existing;
    const ws: Workspace = { key, name, store };
    workspaces.set(key, ws);
    store.on((e) => {
      if (e.type === "message") {
        const channel = store.channels.get(e.message.channelId);
        if (channel) broadcast(ws, (p) => store.canSee(p, channel), e);
      } else if (e.type === "channel") {
        // Each viewer gets the channel as they see it (a DM names the other person).
        for (const [res, s] of streams) {
          if (s.ws === ws && store.canSee(s.person, e.channel)) res.write(`data: ${JSON.stringify({ type: "channel", channel: channelView(ws, e.channel, s.person) })}\n\n`);
        }
      } else {
        broadcast(ws, () => true, { type: "directory" });
      }
    });
    return ws;
  }
  if (options.demo) workspace("demo", "Demo company", options.demo);

  const online = (ws: Workspace) => [...new Set([...streams.values()].filter((s) => s.ws === ws).map((s) => s.person.id))];

  function broadcast(ws: Workspace, filter: (p: Person) => boolean, event: unknown) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const [res, s] of streams) if (s.ws === ws && filter(s.person)) res.write(line);
  }

  function personView(p: Person) {
    return {
      id: p.id,
      email: p.email,
      name: p.name,
      title: p.title,
      avatarUrl: p.avatarUrl,
      teams: teamsOf(p),
      sources: [...new Set(p.sources.filter((s) => s.active).map((s) => s.connectorId))],
      active: isActive(p),
    };
  }

  function channelView(ws: Workspace, c: Channel, viewer: Person | undefined) {
    const peerId = c.kind === "dm" && viewer ? c.memberIds?.find((id) => id !== viewer.id) ?? viewer.id : undefined;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      title: c.title,
      peerId,
      memberCount: c.kind === "team" ? ws.store.teamMembers(c).length : undefined,
    };
  }

  /**
   * Who is asking, from the signed cookie alone. Nothing about people is stored: after a restart the cookie
   * brings its holder back into their company's chat. When it runs out they sign in through their company
   * again, and someone their company has removed cannot.
   */
  function viewer(req: IncomingMessage): { ws: Workspace; person: Person } | undefined {
    const claims = unseal<SessionClaims>(cookie(req, COOKIE), secret);
    if (!claims) return undefined;
    if (claims.w === "demo") {
      const ws = workspaces.get("demo");
      const person = ws?.store.personByEmail(claims.e);
      return ws && person && isActive(person) ? { ws, person } : undefined;
    }
    const ws = workspace(claims.w, claims.wn);
    const person = ws.store.personByEmail(claims.e) ?? ws.store.admit({ email: claims.e, name: claims.n, avatarUrl: claims.a }, claims.p);
    return isActive(person) ? { ws, person } : undefined;
  }

  function requireViewer(req: IncomingMessage) {
    const v = viewer(req);
    if (!v) throw new HttpError(401, "Sign in first");
    return v;
  }

  function sessionCookie(ws: Workspace, person: Person, provider: string) {
    const claims: SessionClaims = { w: ws.key, wn: ws.name, e: person.email, n: person.name, p: provider };
    if (person.avatarUrl) claims.a = person.avatarUrl;
    return `${COOKIE}=${seal({ ...claims }, secret, SESSION_SECONDS)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`;
  }

  /** Into the company's own chat: the workspace is the provider plus the company it vouched for. */
  function admit(identity: Identity) {
    const ws = workspace(`${identity.provider}:${identity.companyId}`, identity.companyName);
    return { ws, person: ws.store.admit(identity, identity.provider) };
  }

  function visibleChannel(req: IncomingMessage, id: string) {
    const v = requireViewer(req);
    const channel = v.ws.store.channels.get(id);
    if (!channel || !v.ws.store.canSee(v.person, channel)) throw new HttpError(404, "No such channel");
    return { ...v, channel };
  }

  const redirectUri = (p: SignInProvider) => `${baseUrl}/auth/${p.id}/callback`;

  /** "Log in with X": off to X's own sign-in page, with a one-time state, nonce and PKCE secret in a cookie. */
  function startRedirect(res: ServerResponse, provider: RedirectProvider) {
    const { verifier, challenge } = pkce();
    const pending: PendingClaims = { p: provider.id, s: randomToken(), n: randomToken(), v: verifier };
    res.setHeader("Set-Cookie", `${PENDING}=${seal({ ...pending }, secret, PENDING_SECONDS)}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${PENDING_SECONDS}${secure}`);
    redirect(res, provider.authorizeUrl({ state: pending.s, nonce: pending.n, challenge, redirectUri: redirectUri(provider) }));
  }

  async function finishRedirect(req: IncomingMessage, res: ServerResponse, provider: RedirectProvider, query: URLSearchParams) {
    const pending = unseal<PendingClaims>(cookie(req, PENDING), secret);
    // The pending cookie is single-use whatever happens next.
    const clearPending = `${PENDING}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0${secure}`;
    res.setHeader("Set-Cookie", clearPending);
    const fail = (message: string) => redirect(res, `/?error=${encodeURIComponent(message)}`);
    const state = query.get("state") ?? "";
    // A callback we did not start, or one started in another browser, is refused: that is what stops someone
    // from signing you in as them, or from putting their own words on the sign-in page.
    if (!pending || pending.p !== provider.id || !sameText(state, pending.s)) return fail("That sign-in link expired or was not started here. Try again.");
    if (query.get("error")) return fail(`${provider.label} did not sign you in (${query.get("error_description") ?? query.get("error")})`);
    const code = query.get("code");
    if (!code) return fail(`${provider.label} sent no sign-in code`);
    try {
      const identity = await provider.finish({ code, verifier: pending.v, nonce: pending.n, redirectUri: redirectUri(provider) }, ctx);
      const { ws, person } = admit(identity);
      res.setHeader("Set-Cookie", [clearPending, sessionCookie(ws, person, identity.provider)]);
      redirect(res, "/");
    } catch (err) {
      if (!(err instanceof SignInError)) console.error(err);
      fail(err instanceof SignInError ? err.message : "Something went wrong signing you in");
    }
  }

  async function auth(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const m = path.match(/^\/auth\/([\w-]+)\/(start|callback)$/);
    const provider = m && providers.find((p) => p.id === m[1]);
    if (!m || !provider || provider.kind !== "redirect" || req.method !== "GET") return send(res, 404, { error: "Not found" });
    if (m[2] === "start") return startRedirect(res, provider);
    return finishRedirect(req, res, provider, query);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const route = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    if (route === "GET /api/signin") {
      return send(res, 200, {
        providers: providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
        demo: workspaces.has("demo"),
      });
    }
    if (route === "GET /api/demo-people") {
      // Quick sign-in buttons, only ever for the made-up company.
      const store = workspaces.get("demo")?.store;
      const people = store ? [...store.people.values()].filter(isActive) : [];
      return send(res, 200, people.map((p) => ({ email: p.email, name: p.name, title: p.title })));
    }
    if (route === "POST /api/session/demo") {
      const ws = workspaces.get("demo");
      const person = ws?.store.personByEmail(str(await readJson(req), "email"));
      if (!ws || !person || !isActive(person)) throw new HttpError(403, "That is not someone in the demo company");
      res.setHeader("Set-Cookie", sessionCookie(ws, person, "demo"));
      return send(res, 200, personView(person));
    }
    if (route === "POST /api/session/password") {
      const body = await readJson(req);
      const provider = providers.find((p) => p.id === str(body, "provider"));
      if (!provider || provider.kind !== "password") throw new HttpError(404, "No such sign-in");
      try {
        // The password goes to the company's own system and nowhere else: not stored, not logged.
        const identity = await provider.verify(str(body, "email"), str(body, "password"), ctx);
        const { ws, person } = admit(identity);
        res.setHeader("Set-Cookie", sessionCookie(ws, person, identity.provider));
        return send(res, 200, personView(person));
      } catch (err) {
        if (err instanceof SignInError) throw new HttpError(403, err.message);
        throw err;
      }
    }
    if (route === "DELETE /api/session") {
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
      return send(res, 200, { ok: true });
    }
    if (route === "GET /api/me") {
      const v = viewer(req);
      return send(res, 200, { person: v ? personView(v.person) : null, company: v ? v.ws.name : null });
    }

    if (route === "GET /api/people") {
      const { ws } = requireViewer(req);
      const people = [...ws.store.people.values()].filter(isActive).sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { people: people.map(personView), online: online(ws) });
    }
    if (route === "GET /api/channels") {
      const { ws, person } = requireViewer(req);
      const list = [...ws.store.channels.values()].filter((c) => ws.store.canSee(person, c));
      return send(res, 200, list.map((c) => channelView(ws, c, person)));
    }
    if (route === "POST /api/channels") {
      const { ws, person } = requireViewer(req);
      const title = str(await readJson(req), "title").slice(0, 80);
      try {
        return send(res, 201, channelView(ws, ws.store.createChannel(title), person));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    if (route === "POST /api/dms") {
      const { ws, person } = requireViewer(req);
      const other = ws.store.people.get(str(await readJson(req), "personId"));
      if (!other || !isActive(other)) throw new HttpError(404, "No such person");
      return send(res, 200, channelView(ws, ws.store.openDm(person, other), person));
    }
    if ((m = path.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
      const { ws, person, channel } = visibleChannel(req, decodeURIComponent(m[1]));
      if (method === "GET") return send(res, 200, ws.store.history(channel));
      if (method === "POST") {
        const text = str(await readJson(req), "text").trim();
        if (!text) throw new HttpError(400, "Say something");
        if (text.length > MAX_MESSAGE) throw new HttpError(400, `Keep it under ${MAX_MESSAGE} characters`);
        return send(res, 201, ws.store.post(person, channel, text));
      }
    }
    if (route === "GET /api/events") {
      const v = requireViewer(req);
      // no-transform and X-Accel-Buffering keep proxies (Cloudflare, nginx) from compressing or holding back the stream.
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.set(res, v);
      broadcast(v.ws, () => true, { type: "presence", online: online(v.ws) });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
        broadcast(v.ws, () => true, { type: "presence", online: online(v.ws) });
      });
      return;
    }
    throw new HttpError(404, "Not found");
  }

  async function staticFile(res: ServerResponse, path: string) {
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      // Unknown paths fall back to the app shell.
      const data = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"] });
      res.end(data);
    }
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) await api(req, res, path);
      else if (path.startsWith("/auth/")) await auth(req, res, path, url.searchParams);
      else await staticFile(res, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong" : (err as Error).message });
    }
  });

  return { server, workspaces };
}
