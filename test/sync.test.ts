import assert from "node:assert/strict";
import { test } from "node:test";
import { isActive, Store } from "../src/store.ts";
import { noFetch, scripted, user } from "./helpers.ts";

test("the same person in two directories is one person with two sources, matched by email in any case", async () => {
  const store = new Store();
  const hub = scripted("hubspot");
  const goo = scripted("google");
  hub.state.pages = [[user("h1", "Ann@Co.com", ["Sales"])]];
  goo.state.pages = [[user("g1", "ann@co.com", ["sales "]), user("g2", "bo@co.com", ["Support"])]];
  await store.sync(store.addConnection("hubspot", "HubSpot", {}), hub.connector, noFetch);
  const r = await store.sync(store.addConnection("google", "Google", {}), goo.connector, noFetch);
  assert.deepEqual([r.added, r.updated], [1, 1]);
  assert.equal(store.people.size, 2);
  const ann = store.personByEmail("ANN@co.com")!;
  assert.deepEqual(ann.sources.map((s) => s.connectorId), ["hubspot", "google"]);
  // "Sales" and "sales " are one team channel.
  const teams = [...store.channels.values()].filter((c) => c.kind === "team").map((c) => c.id).sort();
  assert.deepEqual(teams, ["team:sales", "team:support"]);
});

test("someone gone from the directory is deactivated, not deleted, and their messages keep their author", async () => {
  const store = new Store();
  const dir = scripted();
  const conn = store.addConnection("test", "Test", {});
  dir.state.pages = [[user("1", "a@co.com"), user("2", "b@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  const b = store.personByEmail("b@co.com")!;
  store.post(b, store.channels.get("general")!, "hello");

  dir.state.pages = [[user("1", "a@co.com")]];
  const r = await store.sync(conn, dir.connector, noFetch);
  assert.equal(r.deactivated, 1);
  assert.equal(store.people.get(b.id), b);
  assert.equal(isActive(b), false);
  assert.equal(store.messages[0].authorId, b.id);
});

test("a person still active in another directory stays active when one directory drops them", async () => {
  const store = new Store();
  const one = scripted("one");
  const two = scripted("two");
  const c1 = store.addConnection("one", "One", {});
  one.state.pages = [[user("1", "a@co.com")]];
  two.state.pages = [[user("x", "a@co.com")]];
  await store.sync(c1, one.connector, noFetch);
  await store.sync(store.addConnection("two", "Two", {}), two.connector, noFetch);
  one.state.pages = [[user("9", "z@co.com")]];
  await store.sync(c1, one.connector, noFetch);
  assert.equal(isActive(store.personByEmail("a@co.com")!), true);
});

test("a failure on page two changes nothing, so the people on unread pages are not dropped", async () => {
  const store = new Store();
  const dir = scripted();
  const conn = store.addConnection("test", "Test", {});
  dir.state.pages = [[user("1", "a@co.com")], [user("2", "b@co.com")]];
  await store.sync(conn, dir.connector, noFetch);

  dir.state.pages = [[user("1", "a@co.com", [], { name: "Renamed" })], new Error("rate limited")];
  const r = await store.sync(conn, dir.connector, noFetch);
  assert.equal(r.ok, false);
  assert.match(r.error!, /rate limited/);
  assert.equal(isActive(store.personByEmail("b@co.com")!), true);
  assert.equal(store.personByEmail("a@co.com")!.name, "a", "page one was not applied either");
});

test("an empty answer from a directory that had people keeps everyone and reports it", async () => {
  const store = new Store();
  const dir = scripted();
  const conn = store.addConnection("test", "Test", {});
  dir.state.pages = [[user("1", "a@co.com"), user("2", "b@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  dir.state.pages = [[]];
  const r = await store.sync(conn, dir.connector, noFetch);
  assert.equal(r.ok, false);
  assert.match(r.error!, /returned nobody; kept the 2 people/);
  assert.equal([...store.people.values()].filter(isActive).length, 2);
});

test("a directory that repeats a page cursor is stopped instead of looping forever", async () => {
  const store = new Store();
  const conn = store.addConnection("loop", "Loop", {});
  const r = await store.sync(
    conn,
    { id: "loop", label: "Loop", description: "", setupHelp: "", fields: [], listUsers: async () => ({ users: [user("1", "a@co.com")], nextCursor: "same" }) },
    noFetch,
  );
  assert.equal(r.ok, false);
  assert.match(r.error!, /same page twice/);
});

test("DMs are visible to their two members only; inactive people see nothing", async () => {
  const store = new Store();
  const dir = scripted();
  const conn = store.addConnection("test", "Test", {});
  dir.state.pages = [[user("1", "a@co.com"), user("2", "b@co.com"), user("3", "c@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  const [a, b, c] = ["a", "b", "c"].map((x) => store.personByEmail(`${x}@co.com`)!);
  const dm = store.openDm(a, b);
  assert.equal(store.openDm(b, a), dm);
  assert.deepEqual([store.canSee(a, dm), store.canSee(b, dm), store.canSee(c, dm)], [true, true, false]);
  dir.state.pages = [[user("2", "b@co.com"), user("3", "c@co.com")]];
  await store.sync(conn, dir.connector, noFetch);
  assert.equal(store.canSee(a, store.channels.get("general")!), false);
});
