import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { connectors, findConnector } from "./connectors/index.ts";
import type { ConnectorConfig, ConnectorContext } from "./connectors/types.ts";
import { type Channel, type Connection, isActive, type Person, Store, teamsOf } from "./store.ts";

// A dependency-free HTTP server: JSON API, Server-Sent Events for live updates, and the static UI.

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 256 * 1024;
const MAX_MESSAGE = 4000;
const COOKIE = "crmchat_sid";

export interface AppOptions {
  store?: Store;
  ctx?: ConnectorContext;
  /** When set, connecting directories needs this token. When not, only requests from this machine may. */
  adminToken?: string;
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

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const isLoopback = (req: IncomingMessage) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new Store();
  const ctx: ConnectorContext = options.ctx ?? { fetch: (input, init) => fetch(input, init) };
  const sessions = new Map<string, string>(); // session id -> person id
  const streams = new Map<ServerResponse, Person>();

  const online = () => [...new Set([...streams.values()].map((p) => p.id))];

  function broadcast(filter: (p: Person) => boolean, event: unknown) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const [res, p] of streams) if (filter(p)) res.write(line);
  }

  store.on((e) => {
    if (e.type === "message") {
      const channel = store.channels.get(e.message.channelId);
      if (channel) broadcast((p) => store.canSee(p, channel), e);
    } else if (e.type === "channel") {
      // Each viewer gets the channel as they see it (a DM names the other person).
      for (const [res, p] of streams) {
        if (store.canSee(p, e.channel)) res.write(`data: ${JSON.stringify({ type: "channel", channel: channelView(e.channel, p) })}\n\n`);
      }
    } else {
      broadcast(() => true, { type: "directory" });
    }
  });

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

  function channelView(c: Channel, viewer: Person | undefined) {
    const peerId = c.kind === "dm" && viewer ? c.memberIds?.find((id) => id !== viewer.id) ?? viewer.id : undefined;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      title: c.title,
      peerId,
      memberCount: c.kind === "team" ? store.teamMembers(c).length : undefined,
    };
  }

  function connectionView(c: Connection) {
    const connector = findConnector(c.connectorId);
    return {
      id: c.id,
      connectorId: c.connectorId,
      connectorLabel: connector?.label ?? c.connectorId,
      label: c.label,
      createdAt: c.createdAt,
      lastSync: c.lastSync,
      people: [...store.people.values()].filter((p) => p.sources.some((s) => s.connectionId === c.id && s.active)).length,
    };
  }

  function viewer(req: IncomingMessage): Person | undefined {
    const sid = cookie(req, COOKIE);
    const id = sid ? sessions.get(sid) : undefined;
    const person = id ? store.people.get(id) : undefined;
    // Someone removed from every directory loses access on their next request.
    return person && isActive(person) ? person : undefined;
  }

  function requireViewer(req: IncomingMessage): Person {
    const p = viewer(req);
    if (!p) throw new HttpError(401, "Sign in first");
    return p;
  }

  function isAdmin(req: IncomingMessage): boolean {
    if (options.adminToken) {
      const given = req.headers["x-admin-token"];
      return typeof given === "string" && sameSecret(given, options.adminToken);
    }
    return isLoopback(req);
  }

  function requireAdmin(req: IncomingMessage) {
    if (!isAdmin(req)) throw new HttpError(403, options.adminToken ? "Admin token required" : "Connect directories from the machine running the app, or set ADMIN_TOKEN");
  }

  function visibleChannel(req: IncomingMessage, id: string): [Person, Channel] {
    const p = requireViewer(req);
    const channel = store.channels.get(id);
    if (!channel || !store.canSee(p, channel)) throw new HttpError(404, "No such channel");
    return [p, channel];
  }

  async function connect(connectorId: string, config: ConnectorConfig, label?: string) {
    const connector = findConnector(connectorId);
    if (!connector) throw new HttpError(400, "Unknown directory");
    const connection = store.addConnection(connectorId, label?.trim() || connector.label, config);
    const result = await store.sync(connection, connector, ctx);
    if (!result.ok) {
      // Test-before-save: a connection that cannot read its directory is not kept.
      store.connections.delete(connection.id);
      throw new HttpError(400, result.error ?? "Could not read the directory");
    }
    return connection;
  }

  async function syncAll() {
    for (const c of store.connections.values()) {
      const connector = findConnector(c.connectorId);
      if (connector) await store.sync(c, connector, ctx);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const route = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    if (route === "GET /api/connectors") {
      return send(res, 200, connectors.map(({ id, label, description, setupHelp, fields }) => ({ id, label, description, setupHelp, fields })));
    }
    if (route === "GET /api/admin") return send(res, 200, { admin: isAdmin(req), tokenRequired: !!options.adminToken });
    if (route === "GET /api/connections") {
      requireAdmin(req);
      return send(res, 200, [...store.connections.values()].map(connectionView));
    }
    if (route === "POST /api/connections") {
      requireAdmin(req);
      const body = await readJson(req);
      const raw = body.config && typeof body.config === "object" ? (body.config as Record<string, unknown>) : {};
      const config: ConnectorConfig = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === "string") config[k] = v;
      const connection = await connect(str(body, "connectorId"), config, str(body, "label"));
      return send(res, 201, connectionView(connection));
    }
    if ((m = route.match(/^POST \/api\/connections\/([\w-]+)\/sync$/))) {
      requireAdmin(req);
      const c = store.connections.get(m[1]);
      const connector = c && findConnector(c.connectorId);
      if (!c || !connector) throw new HttpError(404, "No such connection");
      await store.sync(c, connector, ctx);
      return send(res, 200, connectionView(c));
    }
    if ((m = route.match(/^DELETE \/api\/connections\/([\w-]+)$/))) {
      requireAdmin(req);
      const c = store.connections.get(m[1]);
      if (!c) throw new HttpError(404, "No such connection");
      store.connections.delete(c.id);
      // People keep their history; they just lose this source.
      for (const p of store.people.values()) for (const s of p.sources) if (s.connectionId === c.id) s.active = false;
      broadcast(() => true, { type: "directory" });
      return send(res, 200, { ok: true });
    }

    if (route === "GET /api/demo-people") {
      // Quick sign-in buttons, only ever for the made-up company: a real directory is not listed to strangers.
      const people = [...store.people.values()].filter((p) => isActive(p) && p.sources.some((s) => s.active && s.connectorId === "demo"));
      return send(res, 200, people.map((p) => ({ email: p.email, name: p.name, title: p.title })));
    }
    if (route === "POST /api/session") {
      const body = await readJson(req);
      const person = store.personByEmail(str(body, "email"));
      // The whole idea: nobody signs up here. You are in a connected directory, or you are not in.
      // Proof of concept: the email is trusted. Production swaps this for "Sign in with Google / HubSpot /
      // Salesforce" and matches the verified email the same way.
      if (!person || !isActive(person)) throw new HttpError(403, "That email is not in any connected directory");
      const sid = randomBytes(24).toString("base64url");
      sessions.set(sid, person.id);
      res.setHeader("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`);
      return send(res, 200, personView(person));
    }
    if (route === "DELETE /api/session") {
      const sid = cookie(req, COOKIE);
      if (sid) sessions.delete(sid);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    if (route === "GET /api/me") {
      const p = viewer(req);
      return send(res, 200, { person: p ? personView(p) : null });
    }

    if (route === "GET /api/people") {
      requireViewer(req);
      const people = [...store.people.values()].filter(isActive).sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { people: people.map(personView), online: online() });
    }
    if (route === "GET /api/channels") {
      const p = requireViewer(req);
      const list = [...store.channels.values()].filter((c) => store.canSee(p, c));
      return send(res, 200, list.map((c) => channelView(c, p)));
    }
    if (route === "POST /api/channels") {
      const p = requireViewer(req);
      const title = str(await readJson(req), "title").slice(0, 80);
      try {
        return send(res, 201, channelView(store.createChannel(title), p));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    if (route === "POST /api/dms") {
      const p = requireViewer(req);
      const other = store.people.get(str(await readJson(req), "personId"));
      if (!other || !isActive(other)) throw new HttpError(404, "No such person");
      return send(res, 200, channelView(store.openDm(p, other), p));
    }
    if ((m = path.match(/^\/api\/channels\/([^/]+)\/messages$/))) {
      const [p, channel] = visibleChannel(req, decodeURIComponent(m[1]));
      if (method === "GET") return send(res, 200, store.history(channel));
      if (method === "POST") {
        const text = str(await readJson(req), "text").trim();
        if (!text) throw new HttpError(400, "Say something");
        if (text.length > MAX_MESSAGE) throw new HttpError(400, `Keep it under ${MAX_MESSAGE} characters`);
        return send(res, 201, store.post(p, channel, text));
      }
    }
    if (route === "GET /api/events") {
      const p = requireViewer(req);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.set(res, p);
      broadcast(() => true, { type: "presence", online: online() });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
        broadcast(() => true, { type: "presence", online: online() });
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
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (path.startsWith("/api/")) await api(req, res, path);
      else await staticFile(res, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong" : (err as Error).message });
    }
  });

  return { server, store, connect, syncAll };
}
