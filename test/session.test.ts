import assert from "node:assert/strict";
import { test } from "node:test";
import { seal, unseal } from "../src/session.ts";

test("a sealed value opens with the same secret and not with another", () => {
  const token = seal({ e: "ann@acme.com" }, "secret-a", 60);
  assert.equal(unseal<{ e: string }>(token, "secret-a")?.e, "ann@acme.com");
  assert.equal(unseal(token, "secret-b"), undefined);
});

test("an edited value is refused, so nobody can turn their cookie into someone else's", () => {
  const token = seal({ e: "ann@acme.com" }, "s", 60);
  const [, sig] = token.split(".");
  const forged = `${Buffer.from(JSON.stringify({ e: "boss@acme.com", exp: 9e9 })).toString("base64url")}.${sig}`;
  assert.equal(unseal(forged, "s"), undefined);
  assert.equal(unseal("not-a-token", "s"), undefined);
  assert.equal(unseal(undefined, "s"), undefined);
});

test("a sealed value stops opening once it expires", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const token = seal({ e: "ann@acme.com" }, "s", 60, now);
  assert.ok(unseal(token, "s", now + 59_000));
  assert.equal(unseal(token, "s", now + 60_000), undefined);
});
