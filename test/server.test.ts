import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { noFetch, scripted, user } from "./helpers.ts";

const store = new Store();
const dir = scripted();
const conn = store.addConnection("test", "Test", {});
const app = createApp({ store, ctx: noFetch, adminToken: "s3cret" });
let base = "";

before(async () => {
  dir.state.pages = [[user("1", "a@co.com", ["Sales"]), user("2", "b@co.com"), user("3", "c@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.server.close());

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const signIn = async (email: string) => (await call("/api/session", { body: { email } })).cookie!;

test("only people in a connected directory can sign in; there is no sign-up", async () => {
  const stranger = await call("/api/session", { body: { email: "nobody@else.com" } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.cookie, undefined);
  const ann = await call("/api/session", { body: { email: "A@co.com" } });
  assert.equal(ann.status, 200);
  assert.equal(ann.json.email, "a@co.com");
});

test("the API needs a session", async () => {
  assert.equal((await call("/api/channels")).status, 401);
  assert.equal((await call("/api/people")).status, 401);
});

test("posting needs JSON, so a cross-site form cannot post as someone", async () => {
  const cookie = await signIn("a@co.com");
  const res = await fetch(`${base}/api/channels/general/messages`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: "text=hi",
  });
  assert.equal(res.status, 415);
});

test("a DM between two people is a 404 to a third", async () => {
  const a = await signIn("a@co.com");
  const c = await signIn("c@co.com");
  const bId = store.personByEmail("b@co.com")!.id;
  const dm = await call("/api/dms", { cookie: a, body: { personId: bId } });
  const path = `/api/channels/${encodeURIComponent(dm.json.id)}/messages`;
  assert.equal((await call(path, { cookie: a, body: { text: "private" } })).status, 201);
  assert.equal((await call(path, { cookie: c })).status, 404);
  const cChannels = (await call("/api/channels", { cookie: c })).json.map((x: { id: string }) => x.id);
  assert.ok(!cChannels.includes(dm.json.id));
});

test("someone removed from the directory loses access on their next request", async () => {
  const b = await signIn("b@co.com");
  assert.equal((await call("/api/channels", { cookie: b })).status, 200);
  dir.state.pages = [[user("1", "a@co.com", ["Sales"]), user("3", "c@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  assert.equal((await call("/api/channels", { cookie: b })).status, 401);
  assert.equal((await call("/api/session", { body: { email: "b@co.com" } })).status, 403);
});

test("connecting a directory needs the admin token when one is set", async () => {
  assert.equal((await call("/api/connections")).status, 403);
  assert.equal((await call("/api/connections", { headers: { "x-admin-token": "wrong!" } })).status, 403);
  const ok = await call("/api/connections", { headers: { "x-admin-token": "s3cret" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json[0].people, 2);
  assert.ok(!JSON.stringify(ok.json).includes("config"), "credentials never go back to the browser");
});

test("a directory that cannot be read is not saved, and the error says why", async () => {
  const before = store.connections.size;
  const res = await call("/api/connections", {
    headers: { "x-admin-token": "s3cret" },
    body: { connectorId: "hubspot", config: { accessToken: "pat-bad" } },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /could not reach api\.hubapi\.com/);
  assert.equal(store.connections.size, before);
});

test("the demo quick sign-in never lists people from a real directory", async () => {
  const res = await call("/api/demo-people");
  assert.deepEqual(res.json, []);
});
