import assert from "node:assert/strict";
import { test } from "node:test";
import { google } from "../src/signin/google.ts";
import { hubspot } from "../src/signin/hubspot.ts";
import { providersFromEnv } from "../src/signin/index.ts";
import { microsoft } from "../src/signin/microsoft.ts";
import { salesforce } from "../src/signin/salesforce.ts";
import type { SignInContext } from "../src/signin/types.ts";
import { werdna } from "../src/signin/werdna.ts";
import { fakeFetch } from "./helpers.ts";

// Each provider against a stand-in that answers the way its documentation says it does. These rest on the
// providers' published flows, not on live accounts: each needs this app registered with it to try for real.

const NOW = Date.parse("2026-10-03T12:00:00Z");
const exp = NOW / 1000 + 3600;
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const with_ = (ctx: SignInContext): SignInContext => ({ ...ctx, now: () => NOW });
const flow = { code: "the-code", verifier: "the-verifier", nonce: "n-1", redirectUri: "https://chat.test/auth/x/callback" };

// ---------- Google ----------

function fakeGoogle(claims: Record<string, unknown>) {
  return fakeFetch((url) => {
    if (url.href === "https://oauth2.googleapis.com/token") return { body: { access_token: "at", id_token: jwt(claims) } };
    return { status: 404, body: {} };
  });
}
const googleClaims = { iss: "https://accounts.google.com", aud: "gid", nonce: "n-1", exp, email: "Ann@Acme.com", email_verified: true, hd: "acme.com", name: "Ann Lee", picture: "https://lh3.test/ann" };
const g = google({ clientId: "gid", clientSecret: "gsecret" });

test("Google: the sign-in page gets our app, the way back, a state, a nonce and a PKCE challenge", () => {
  const url = new URL(g.kind === "redirect" ? g.authorizeUrl({ state: "s-1", nonce: "n-1", challenge: "c-1", redirectUri: flow.redirectUri }) : "");
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.client_id, "gid");
  assert.equal(q.redirect_uri, flow.redirectUri);
  assert.equal(q.state, "s-1");
  assert.equal(q.nonce, "n-1");
  assert.equal(q.code_challenge, "c-1");
  assert.equal(q.code_challenge_method, "S256");
  assert.equal(q.scope, "openid email profile");
});

test("Google: a work account signs in to its workspace domain, and the code is exchanged with the PKCE secret", async () => {
  const f = fakeGoogle(googleClaims);
  const who = await g.finish(flow, with_(f.ctx));
  assert.deepEqual(who, { provider: "google", companyId: "acme.com", companyName: "acme.com", email: "ann@acme.com", name: "Ann Lee", avatarUrl: "https://lh3.test/ann" });
  const sent = form(f.calls[0].init);
  assert.equal(sent.code, "the-code");
  assert.equal(sent.code_verifier, "the-verifier");
  assert.equal(sent.client_secret, "gsecret");
});

test("Google: a personal Gmail account is turned away, since it has no company", async () => {
  const { hd: _, ...personal } = googleClaims;
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...personal, email: "ann@gmail.com" }).ctx)), /personal Google account/);
});

test("Google: an ID token for another app, another sign-in, or past its time is refused", async () => {
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...googleClaims, aud: "someone-else" }).ctx)), /not issued to this app/);
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...googleClaims, nonce: "n-2" }).ctx)), /does not belong to this sign-in/);
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...googleClaims, exp: NOW / 1000 - 1 }).ctx)), /expired/);
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...googleClaims, iss: "https://evil.test" }).ctx)), /wrong issuer/);
  await assert.rejects(g.finish(flow, with_(fakeGoogle({ ...googleClaims, email_verified: false }).ctx)), /not verified/);
});

test("Google: a refused code exchange says what Google said", async () => {
  const f = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }));
  await assert.rejects(g.finish(flow, with_(f.ctx)), /Google refused the sign-in \(400: Bad Request\)/);
});

// ---------- Microsoft ----------

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const msClaims = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: "mid", nonce: "n-1", exp, tid: TENANT, preferred_username: "Bo@Contoso.com", name: "Bo Diaz" };
const ms = microsoft({ clientId: "mid", clientSecret: "msecret" });
const fakeMs = (claims: Record<string, unknown>) =>
  fakeFetch((url) => (url.href.endsWith("/oauth2/v2.0/token") ? { body: { id_token: jwt(claims) } } : { status: 404, body: {} }));

test("Microsoft: a work account signs in to its tenant", async () => {
  const f = fakeMs(msClaims);
  const who = await ms.finish(flow, with_(f.ctx));
  assert.deepEqual(who, { provider: "microsoft", companyId: TENANT, companyName: "contoso.com", email: "bo@contoso.com", name: "Bo Diaz" });
  assert.equal(f.calls[0].url.href, "https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
});

test("Microsoft: the issuer must be the tenant's own, and a personal account is turned away", async () => {
  await assert.rejects(ms.finish(flow, with_(fakeMs({ ...msClaims, iss: "https://login.microsoftonline.com/other/v2.0" }).ctx)), /wrong issuer/);
  const personal = "9188040d-6c67-4c5b-b112-36a304b66dad";
  await assert.rejects(
    ms.finish(flow, with_(fakeMs({ ...msClaims, tid: personal, iss: `https://login.microsoftonline.com/${personal}/v2.0` }).ctx)),
    /personal Microsoft account/,
  );
});

// ---------- Salesforce ----------

test("Salesforce: the org from userinfo is the company, asked once with the access token", async () => {
  const f = fakeFetch((url) => {
    if (url.pathname === "/services/oauth2/token") return { body: { access_token: "sf-at", instance_url: "https://acme.my.salesforce.com" } };
    if (url.pathname === "/services/oauth2/userinfo") return { body: { email: "cy@acme.com", email_verified: true, name: "Cy Ho", organization_id: "00D5g000000abcd" } };
    return { status: 404, body: {} };
  });
  const sf = salesforce({ clientId: "sid", clientSecret: "ssecret" });
  const who = await sf.finish(flow, with_(f.ctx));
  assert.deepEqual(who, { provider: "salesforce", companyId: "00D5g000000abcd", companyName: "acme.com", email: "cy@acme.com", name: "Cy Ho", avatarUrl: undefined });
  assert.equal(new Headers(f.calls[1].init.headers).get("authorization"), "Bearer sf-at");
  assert.equal(f.calls[1].url.origin, "https://login.salesforce.com");
});

test("Salesforce: no org in the answer means no sign-in", async () => {
  const f = fakeFetch((url) => (url.pathname.endsWith("/token") ? { body: { access_token: "sf-at" } } : { body: { email: "cy@acme.com" } }));
  await assert.rejects(salesforce({ clientId: "sid", clientSecret: "s" }).finish(flow, with_(f.ctx)), /which org/);
});

// ---------- HubSpot ----------

test("HubSpot: the access-token lookup names the user and the HubSpot account they approved in", async () => {
  const f = fakeFetch((url) => {
    if (url.pathname === "/oauth/v1/token") return { body: { access_token: "hs-at", refresh_token: "r" } };
    if (url.pathname === "/oauth/v1/access-tokens/hs-at") return { body: { user: "Di@Acme.com", hub_id: 4242, hub_domain: "acme.com" } };
    return { status: 404, body: {} };
  });
  const who = await hubspot({ clientId: "hid", clientSecret: "hsecret" }).finish(flow, with_(f.ctx));
  assert.deepEqual(who, { provider: "hubspot", companyId: "4242", companyName: "acme.com", email: "di@acme.com", name: "di@acme.com" });
  assert.equal(form(f.calls[0].init).client_secret, "hsecret");
});

test("HubSpot: a lookup HubSpot refuses is not a sign-in", async () => {
  const f = fakeFetch((url) => (url.pathname === "/oauth/v1/token" ? { body: { access_token: "hs-at" } } : { status: 404, body: {} }));
  await assert.rejects(hubspot({ clientId: "hid", clientSecret: "s" }).finish(flow, with_(f.ctx)), /would not say who signed in/);
});

// ---------- Werdna ----------

/** Werdna's login as its routes/auth.ts answers it: a CSRF token first, then the login, then the logout. */
function fakeWerdna() {
  const sessions = new Set<string>();
  const log: string[] = [];
  let n = 0;
  const cookies = (init: RequestInit) =>
    Object.fromEntries((new Headers(init.headers).get("cookie") ?? "").split(";").map((c) => c.trim().split("=")).filter((kv) => kv[0]));
  const reply = (status: number, body: unknown, set: string[] = []) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const c of set) headers.append("Set-Cookie", `${c}; Path=/; HttpOnly; Secure`);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const ctx: SignInContext = {
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const jar = cookies(init);
      log.push(`${init.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/csrf-token") return reply(200, { csrfToken: `t${++n}` }, [`csrf-token=t${n}`]);
      if (url.pathname === "/api/auth/login") {
        if (!new Headers(init.headers).get("x-csrf-token")) return reply(403, { error: "Invalid or missing CSRF token" });
        const { email, password } = JSON.parse(String(init.body));
        if (email === "locked@cdl.com") return reply(423, { error: "locked" });
        if (email !== "jo@cdl.com" || password !== "pw") return reply(401, { error: "Invalid email or password" });
        const sid = `s${++n}`;
        sessions.add(sid);
        return reply(200, { user: { id: "u1", email: "jo@cdl.com", firstName: "Jo", lastName: "Park", profileImageUrl: "/api/users/u1/avatar" } }, [`sid=${sid}`]);
      }
      if (url.pathname === "/api/auth/logout") {
        sessions.delete(jar.sid);
        return reply(200, { success: true });
      }
      return reply(404, {});
    },
  };
  return { ctx, sessions, log };
}

test("Werdna: the person's own login is checked by Werdna, and the session it opened is closed at once", async () => {
  const w = fakeWerdna();
  const who = await werdna({ baseUrl: "https://werdnas.com/" }).verify("jo@cdl.com", "pw", w.ctx);
  assert.deepEqual(who, {
    provider: "werdna",
    companyId: "werdnas.com",
    companyName: "werdnas.com",
    email: "jo@cdl.com",
    name: "Jo Park",
    avatarUrl: "https://werdnas.com/api/users/u1/avatar",
  });
  assert.equal(w.log.at(-1), "POST /api/auth/logout");
  assert.equal(w.sessions.size, 0);
});

test("Werdna: a wrong password or a locked account says so", async () => {
  const w = fakeWerdna();
  const wd = werdna({ baseUrl: "https://werdnas.com" });
  await assert.rejects(wd.verify("jo@cdl.com", "nope", w.ctx), /Wrong Werdna email or password/);
  await assert.rejects(wd.verify("locked@cdl.com", "pw", w.ctx), /locked/);
  assert.ok(!w.log.includes("POST /api/auth/logout"), "no session was opened, so none is closed");
});

// ---------- which ones are on ----------

test("only providers with their settings are offered, in a fixed order", () => {
  assert.deepEqual(providersFromEnv({}), []);
  const list = providersFromEnv({
    HUBSPOT_CLIENT_ID: "h",
    HUBSPOT_CLIENT_SECRET: "h",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "g",
    MICROSOFT_CLIENT_ID: "m",
    WERDNA_URL: "https://werdnas.com",
  });
  assert.deepEqual(list.map((p) => `${p.id}:${p.kind}`), ["google:redirect", "hubspot:redirect", "werdna:password"]);
  assert.throws(() => providersFromEnv({ WERDNA_URL: "http://werdnas.com" }), /must start with https/);
});
