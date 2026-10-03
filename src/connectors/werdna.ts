import { ConnectorError, type ConnectorContext, type DirectoryConnector, type DirectoryUser, requireFields } from "./types.ts";

// Werdna (the CDL PowerSuite CRM) users. Werdna has no API keys yet, so this signs in the way its own web
// page does: fetch a CSRF token, sign in with an admin's email and password, read the users, sign out.
//   GET  /api/csrf-token     -> csrf-token + csrf-key cookies
//   POST /api/auth/login     -> sid cookie (needs the x-csrf-token header)
//   GET  /api/users          -> every CRM user (admin or above)
//   GET  /api/teams, /api/teams/members -> team names (C-suite only; skipped when refused)

interface WerdnaUser {
  id: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
}

interface WerdnaTeamMember {
  kind: string;
  id: string | number;
  teamId: number | null;
}

/** Just enough of a cookie jar for one sign-in: name=value pairs from Set-Cookie, sent back on every call. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  get(name: string) {
    return this.cookies.get(name);
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function origin(config: Record<string, string>): string {
  let url: URL;
  try {
    url = new URL(config.baseUrl.trim());
  } catch {
    throw new ConnectorError("Werdna: the address is not a URL");
  }
  // Werdna's cookies are Secure, so only https gets a session back. localhost is allowed for development.
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new ConnectorError("Werdna: the address must start with https://");
  }
  return url.origin;
}

async function call(ctx: ConnectorContext, jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, headers, redirect: "manual" });
  } catch (err) {
    throw new ConnectorError(`Werdna: could not reach ${new URL(url).host} (${(err as Error).message})`);
  }
  jar.take(res);
  return res;
}

async function failure(res: Response, what: string): Promise<ConnectorError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new ConnectorError(`Werdna ${what} answered ${res.status}${body.error ? `: ${body.error}` : ""}`, res.status);
}

async function signOut(ctx: ConnectorContext, jar: Jar, base: string) {
  const res = await call(ctx, jar, `${base}/api/csrf-token`);
  const token = ((await res.json()) as { csrfToken?: string }).csrfToken;
  if (token) await call(ctx, jar, `${base}/api/auth/logout`, { method: "POST", headers: { "x-csrf-token": token } });
}

export function mapWerdnaUser(u: WerdnaUser, base: string, teamName?: string): DirectoryUser | null {
  if (!u.email) return null;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email;
  return {
    externalId: String(u.id),
    email: u.email,
    name,
    teams: teamName ? [teamName] : [],
    // Avatars are served by Werdna itself, usually as a path on the same host.
    avatarUrl: u.profileImageUrl ? new URL(u.profileImageUrl, base).toString() : undefined,
    active: true,
  };
}

export const werdna: DirectoryConnector = {
  id: "werdna",
  label: "Werdna",
  description: "Everyone with a Werdna login. Their Werdna teams become channels.",
  setupHelp:
    "Use a Werdna account with admin access (C-suite to also bring in teams). A dedicated account for the chat app is best, since its password is kept here.",
  fields: [
    { key: "baseUrl", label: "Werdna address", type: "text", required: true, placeholder: "https://werdnas.com" },
    { key: "email", label: "Admin email", type: "text", required: true },
    { key: "password", label: "Password", type: "password", required: true },
  ],
  async listUsers(config, ctx) {
    requireFields(this, config);
    const base = origin(config);
    const jar = new Jar();

    const tokenRes = await call(ctx, jar, `${base}/api/csrf-token`);
    if (!tokenRes.ok) throw await failure(tokenRes, "CSRF token");
    const csrf = ((await tokenRes.json()) as { csrfToken?: string }).csrfToken ?? jar.get("csrf-token");
    if (!csrf) throw new ConnectorError("Werdna sent no CSRF token");

    const login = await call(ctx, jar, `${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ email: config.email.trim(), password: config.password }),
    });
    if (login.status === 401) throw new ConnectorError("Werdna: wrong email or password", 401);
    if (login.status === 423) throw new ConnectorError("Werdna: that account is locked after too many tries; wait and retry", 423);
    if (!login.ok) throw await failure(login, "sign-in");
    if (!jar.get("sid")) throw new ConnectorError("Werdna signed in but sent no session cookie");

    try {
      const usersRes = await call(ctx, jar, `${base}/api/users`);
      if (usersRes.status === 403) throw new ConnectorError("Werdna: that account is not an admin, so it cannot list users", 403);
      if (!usersRes.ok) throw await failure(usersRes, "user list");
      const users = (await usersRes.json()) as WerdnaUser[];
      if (!Array.isArray(users)) throw new ConnectorError("Werdna's user list was not a list");

      // Teams are a bonus: only C-suite may read them, and an admin still gets everyone, just without channels.
      const teamOf = new Map<string, string>();
      const [teamsRes, membersRes] = [await call(ctx, jar, `${base}/api/teams`), await call(ctx, jar, `${base}/api/teams/members`)];
      if (teamsRes.ok && membersRes.ok) {
        const { teams } = (await teamsRes.json()) as { teams: { id: number; name: string }[] };
        const { members } = (await membersRes.json()) as { members: WerdnaTeamMember[] };
        const names = new Map(teams.map((t) => [t.id, t.name]));
        for (const m of members) {
          const name = m.teamId === null ? undefined : names.get(m.teamId);
          if (m.kind === "user" && name) teamOf.set(String(m.id), name);
        }
      }

      return { users: users.map((u) => mapWerdnaUser(u, base, teamOf.get(String(u.id)))).filter((u): u is DirectoryUser => u !== null) };
    } finally {
      // Leave no session behind on Werdna. A signed-in POST needs a CSRF token tied to the new session, so
      // ask for one first. Best effort: a failed sign-out changes nothing here.
      await signOut(ctx, jar, base).catch(() => {});
    }
  },
};
