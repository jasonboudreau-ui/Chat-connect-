import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.ts";
import { type PasswordProvider, type RedirectProvider, SignInError } from "../src/signin/types.ts";
import { Store } from "../src/store.ts";
import { noFetch, scripted, user } from "./helpers.ts";

// The server with stand-in providers: "Log in with Acme ID" sends back whoever the one-time code names, and a
// password provider knows one login. The stand-ins check nothing themselves; what is tested is what the server
// does with their answer.

const PEOPLE: Record<string, { companyId: string; companyName: string; email: string; name: string }> = {
  ann: { companyId: "acme", companyName: "Acme", email: "ann@acme.com", name: "Ann" },
  bo: { companyId: "acme", companyName: "Acme", email: "bo@acme.com", name: "Bo" },
  cy: { companyId: "acme", companyName: "Acme", email: "cy@acme.com", name: "Cy" },
  zed: { companyId: "other", companyName: "Other Inc", email: "zed@other.com", name: "Zed" },
};

const idp: RedirectProvider = {
  kind: "redirect",
  id: "acmeid",
  label: "Acme ID",
  authorizeUrl: ({ state, nonce, challenge, redirectUri }) =>
    `https://idp.test/authorize?${new URLSearchParams({ state, nonce, challenge, redirect_uri: redirectUri })}`,
  async finish({ code }) {
    const p = PEOPLE[code];
    if (!p) throw new SignInError("Acme ID does not know that code");
    return { provider: "acmeid", ...p };
  },
};

let passwordsSeen: string[] = [];
const pw: PasswordProvider = {
  kind: "password",
  id: "crm",
  label: "The CRM",
  async verify(email, password) {
    passwordsSeen.push(password);
    if (email !== "dee@acme.com" || password !== "right") throw new SignInError("Wrong CRM email or password");
    return { provider: "crm", companyId: "acme", companyName: "Acme", email, name: "Dee" };
  },
};

const demo = new Store();
const SECRET = "test-secret";
const app = createApp({ providers: [idp, pw], ctx: noFetch, baseUrl: "https://chat.test", sessionSecret: SECRET, demo });
let base = "";

before(async () => {
  const dir = scripted("demo");
  dir.state.pages = [[user("1", "avery@demo.test", ["Sales"])]];
  await demo.sync(demo.addConnection("demo", "Demo", {}), dir.connector, noFetch);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.server.close());

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; at?: string } = {}) {
  const res = await fetch((opts.at ?? base) + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    redirect: "manual",
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const cookies = Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split(/=(.*)/s).slice(0, 2)));
  return { status: res.status, location: res.headers.get("location"), cookies, json: await res.json().catch(() => null) };
}

/** The whole "Log in with Acme ID" round trip, as a browser makes it. */
async function logIn(code: string) {
  const start = await call("/auth/acmeid/start");
  const state = new URL(start.location!).searchParams.get("state")!;
  const back = await call(`/auth/acmeid/callback?code=${code}&state=${state}`, { cookie: `crmchat_signin=${start.cookies.crmchat_signin}` });
  return { back, cookie: back.cookies.crmchat_session ? `crmchat_session=${back.cookies.crmchat_session}` : "" };
}

test("Log in with: off to the provider's page with our way back, then home signed in to the company's chat", async () => {
  const start = await call("/auth/acmeid/start");
  assert.equal(start.status, 302);
  const to = new URL(start.location!);
  assert.equal(to.origin, "https://idp.test");
  assert.equal(to.searchParams.get("redirect_uri"), "https://chat.test/auth/acmeid/callback");
  assert.ok(to.searchParams.get("state") && to.searchParams.get("nonce") && to.searchParams.get("challenge"));

  const { back, cookie } = await logIn("ann");
  assert.equal(back.status, 302);
  assert.equal(back.location, "/");
  assert.equal(back.cookies.crmchat_signin, "", "the one-time sign-in cookie is cleared");
  const me = await call("/api/me", { cookie });
  assert.equal(me.json.person.email, "ann@acme.com");
  assert.equal(me.json.company, "Acme");
});

test("a callback this browser did not start is refused, so nobody can sign you in as them", async () => {
  const start = await call("/auth/acmeid/start");
  const state = new URL(start.location!).searchParams.get("state")!;
  const pending = `crmchat_signin=${start.cookies.crmchat_signin}`;
  const noCookie = await call(`/auth/acmeid/callback?code=ann&state=${state}`);
  const wrongState = await call(`/auth/acmeid/callback?code=ann&state=guessed`, { cookie: pending });
  for (const r of [noCookie, wrongState]) {
    assert.equal(r.status, 302);
    assert.match(decodeURIComponent(r.location!), /^\/\?error=That sign-in link expired/);
    assert.equal(r.cookies.crmchat_session, undefined);
  }
});

test("a provider's refusal comes back to the sign-in page in its own words", async () => {
  const { back } = await logIn("nobody");
  assert.equal(decodeURIComponent(back.location!), "/?error=Acme ID does not know that code");
  const start = await call("/auth/acmeid/start");
  const state = new URL(start.location!).searchParams.get("state")!;
  const denied = await call(`/auth/acmeid/callback?error=access_denied&state=${state}`, { cookie: `crmchat_signin=${start.cookies.crmchat_signin}` });
  assert.match(decodeURIComponent(denied.location!), /Acme ID did not sign you in \(access_denied\)/);
});

test("companies are walled off: other people, channels and messages are invisible across them", async () => {
  const ann = (await logIn("ann")).cookie;
  const bo = (await logIn("bo")).cookie;
  const zed = (await logIn("zed")).cookie;
  assert.equal((await call("/api/channels/general/messages", { cookie: ann, body: { text: "acme only" } })).status, 201);

  const zedPeople = (await call("/api/people", { cookie: zed })).json.people.map((p: { email: string }) => p.email);
  assert.deepEqual(zedPeople, ["zed@other.com"]);
  assert.deepEqual((await call("/api/channels/general/messages", { cookie: zed })).json, []);
  assert.equal((await call("/api/me", { cookie: zed })).json.company, "Other Inc");

  const boPeople = (await call("/api/people", { cookie: bo })).json.people.map((p: { email: string }) => p.email);
  assert.ok(boPeople.includes("ann@acme.com") && !boPeople.includes("zed@other.com"));
  const annId = (await call("/api/me", { cookie: ann })).json.person.id;
  assert.equal((await call("/api/dms", { cookie: zed, body: { personId: annId } })).status, 404);
});

test("nothing is stored: the signed cookie alone brings someone back after a restart, and an edited one is refused", async () => {
  const { cookie } = await logIn("cy");
  const restarted = createApp({ providers: [idp], ctx: noFetch, baseUrl: "https://chat.test", sessionSecret: SECRET });
  await new Promise<void>((r) => restarted.server.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(restarted.server.address() as AddressInfo).port}`;
  try {
    const me = await call("/api/me", { cookie, at });
    assert.equal(me.json.person.email, "cy@acme.com");
    const [body, sig] = cookie.split("=")[1].split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, e: "boss@acme.com" })).toString("base64url");
    assert.equal((await call("/api/channels", { cookie: `crmchat_session=${forged}.${sig}`, at })).status, 401);
  } finally {
    restarted.server.close();
  }
});

test("a password sign-in goes to the company's system, is not echoed back, and a wrong one gets no session", async () => {
  passwordsSeen = [];
  const wrong = await call("/api/session/password", { body: { provider: "crm", email: "dee@acme.com", password: "nope" } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error, "Wrong CRM email or password");
  assert.equal(wrong.cookies.crmchat_session, undefined);
  const right = await call("/api/session/password", { body: { provider: "crm", email: "dee@acme.com", password: "right" } });
  assert.equal(right.status, 200);
  assert.ok(!JSON.stringify(right.json).includes("right"));
  assert.ok(!decodeURIComponent(right.cookies.crmchat_session).includes("right"), "the password is not in the cookie");
  assert.deepEqual(passwordsSeen, ["nope", "right"]);
  const people = (await call("/api/people", { cookie: `crmchat_session=${right.cookies.crmchat_session}` })).json.people;
  // A company is the provider plus the company it vouches for: one provider can never vouch for another's.
  assert.deepEqual(people.map((p: { email: string }) => p.email), ["dee@acme.com"]);
});

test("the API needs a session, and posting needs JSON so a cross-site form cannot post as someone", async () => {
  assert.equal((await call("/api/channels")).status, 401);
  assert.equal((await call("/api/people")).status, 401);
  const { cookie } = await logIn("ann");
  const res = await fetch(`${base}/api/channels/general/messages`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: "text=hi",
  });
  assert.equal(res.status, 415);
});

test("a DM between two people is a 404 to a third in the same company", async () => {
  const ann = (await logIn("ann")).cookie;
  const bo = (await logIn("bo")).cookie;
  const cy = (await logIn("cy")).cookie;
  const boId = (await call("/api/me", { cookie: bo })).json.person.id;
  const dm = await call("/api/dms", { cookie: ann, body: { personId: boId } });
  const path = `/api/channels/${encodeURIComponent(dm.json.id)}/messages`;
  assert.equal((await call(path, { cookie: ann, body: { text: "private" } })).status, 201);
  assert.equal((await call(path, { cookie: cy })).status, 404);
});

test("the demo company is its own space, reachable only through its quick sign-in", async () => {
  const people = await call("/api/demo-people");
  assert.deepEqual(people.json.map((p: { email: string }) => p.email), ["avery@demo.test"]);
  assert.equal((await call("/api/session/demo", { body: { email: "ann@acme.com" } })).status, 403);
  const avery = await call("/api/session/demo", { body: { email: "avery@demo.test" } });
  const cookie = `crmchat_session=${avery.cookies.crmchat_session}`;
  const seen = (await call("/api/people", { cookie })).json.people.map((p: { email: string }) => p.email);
  assert.deepEqual(seen, ["avery@demo.test"]);
  const signin = await call("/api/signin");
  assert.deepEqual(signin.json, { providers: [{ id: "acmeid", label: "Acme ID", kind: "redirect" }, { id: "crm", label: "The CRM", kind: "password" }], demo: true });
});

test("a provider that is not switched on has no sign-in route", async () => {
  assert.equal((await call("/auth/google/start")).status, 404);
  assert.equal((await call("/auth/crm/start")).status, 404, "a password provider has no redirect");
});
