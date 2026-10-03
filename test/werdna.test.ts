import assert from "node:assert/strict";
import { test } from "node:test";
import { werdna } from "../src/connectors/werdna.ts";
import type { ConnectorContext } from "../src/connectors/types.ts";

// A stand-in for Werdna's API that enforces what the real one does (artifacts/api-server/src/app.ts and
// routes/auth.ts in werdnas): a CSRF token bound to the csrf-key cookie before sign-in and to the sid after,
// admin for /users, C-suite for /teams. It rests on reading that code, not on a live Werdna.
function fakeWerdna(accounts: Record<string, { password: string; role: "user" | "admin" | "c_suite" }>) {
  const tokens = new Map<string, string>(); // session key -> csrf token
  const sessions = new Map<string, string>(); // sid -> email
  const log: string[] = [];
  let n = 0;
  const cookiesOf = (init: RequestInit) =>
    Object.fromEntries(
      (new Headers(init.headers).get("cookie") ?? "")
        .split(";")
        .map((c) => c.trim().split("="))
        .filter((kv) => kv[0]),
    ) as Record<string, string>;
  const json = (status: number, body: unknown, setCookies: string[] = []) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const c of setCookies) headers.append("Set-Cookie", `${c}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return new Response(JSON.stringify(body), { status, headers });
  };

  const ctx: ConnectorContext = {
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const cookies = cookiesOf(init);
      const csrf = new Headers(init.headers).get("x-csrf-token");
      const who = cookies.sid ? sessions.get(cookies.sid) : undefined;
      const role = who ? accounts[who].role : undefined;
      log.push(`${method} ${url.pathname}`);

      if (url.pathname === "/api/csrf-token") {
        const token = `t${++n}`;
        const key = cookies.sid && who ? cookies.sid : `k${n}`;
        tokens.set(key, token);
        return json(200, { csrfToken: token }, [`csrf-token=${token}`, ...(who ? [] : [`csrf-key=${key}`])]);
      }
      if (method === "POST") {
        const key = url.pathname === "/api/auth/login" ? cookies.sid || cookies["csrf-key"] : cookies.sid;
        if (!key || !csrf || tokens.get(key) !== csrf) return json(403, { error: "Invalid or missing CSRF token" });
      }
      if (url.pathname === "/api/auth/login") {
        const { email, password } = JSON.parse(String(init.body));
        if (accounts[email]?.password !== password) return json(401, { error: "Invalid email or password" });
        const sid = `s${++n}`;
        sessions.set(sid, email);
        return json(200, { user: { email } }, [`sid=${sid}`]);
      }
      if (url.pathname === "/api/auth/logout") {
        sessions.delete(cookies.sid);
        return json(200, { success: true });
      }
      if (!who) return json(401, { error: "Unauthorized" });
      if (url.pathname === "/api/users") {
        if (role === "user") return json(403, { error: "Forbidden" });
        return json(200, [
          { id: "u1", email: "ann@cdl.com", firstName: "Ann", lastName: "Lee", profileImageUrl: "/api/users/u1/avatar", role: "c_suite" },
          { id: "u2", email: "bo@cdl.com", firstName: null, lastName: null, profileImageUrl: null, role: "user" },
        ]);
      }
      if (url.pathname === "/api/teams" || url.pathname === "/api/teams/members") {
        if (role !== "c_suite") return json(403, { error: "Forbidden" });
        if (url.pathname === "/api/teams") return json(200, { teams: [{ id: 7, name: "Dispatch" }] });
        return json(200, {
          members: [
            { kind: "user", id: "u1", teamId: 7 },
            { kind: "user", id: "u2", teamId: null },
            { kind: "rep", id: 99, teamId: 7 },
          ],
        });
      }
      return json(404, { error: "Not found" });
    },
  };
  return { ctx, log, sessions };
}

const accounts = {
  "boss@cdl.com": { password: "pw-boss", role: "c_suite" as const },
  "admin@cdl.com": { password: "pw-admin", role: "admin" as const },
  "rep@cdl.com": { password: "pw-rep", role: "user" as const },
};

test("Werdna: signs in like the web page, reads users and teams, and signs out again", async () => {
  const w = fakeWerdna(accounts);
  const page = await werdna.listUsers({ baseUrl: "https://werdnas.com/", email: "boss@cdl.com", password: "pw-boss" }, w.ctx);
  assert.deepEqual(page.users, [
    { externalId: "u1", email: "ann@cdl.com", name: "Ann Lee", teams: ["Dispatch"], avatarUrl: "https://werdnas.com/api/users/u1/avatar", active: true },
    { externalId: "u2", email: "bo@cdl.com", name: "bo@cdl.com", teams: [], avatarUrl: undefined, active: true },
  ]);
  assert.equal(page.nextCursor, undefined);
  assert.equal(w.log.at(-1), "POST /api/auth/logout");
  assert.equal(w.sessions.size, 0, "the session it opened on Werdna is closed");
});

test("Werdna: an admin who cannot read teams still brings everyone in, without team channels", async () => {
  const w = fakeWerdna(accounts);
  const page = await werdna.listUsers({ baseUrl: "https://werdnas.com", email: "admin@cdl.com", password: "pw-admin" }, w.ctx);
  assert.deepEqual(page.users.map((u) => [u.email, u.teams]), [["ann@cdl.com", []], ["bo@cdl.com", []]]);
  assert.equal(w.sessions.size, 0);
});

test("Werdna: a wrong password says so and reads nothing", async () => {
  const w = fakeWerdna(accounts);
  await assert.rejects(werdna.listUsers({ baseUrl: "https://werdnas.com", email: "boss@cdl.com", password: "nope" }, w.ctx), /wrong email or password/);
  assert.ok(!w.log.includes("GET /api/users"));
});

test("Werdna: an account that is not an admin is refused with a reason, and its session is still closed", async () => {
  const w = fakeWerdna(accounts);
  await assert.rejects(werdna.listUsers({ baseUrl: "https://werdnas.com", email: "rep@cdl.com", password: "pw-rep" }, w.ctx), /not an admin/);
  assert.equal(w.sessions.size, 0);
});

test("Werdna: a plain-http address is refused before the password is sent anywhere", async () => {
  const w = fakeWerdna(accounts);
  await assert.rejects(werdna.listUsers({ baseUrl: "http://werdnas.com", email: "boss@cdl.com", password: "pw-boss" }, w.ctx), /must start with https/);
  assert.equal(w.log.length, 0);
});
