import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { google } from "../src/connectors/google.ts";
import { hubspot } from "../src/connectors/hubspot.ts";
import { salesforce } from "../src/connectors/salesforce.ts";
import { fakeFetch, header } from "./helpers.ts";

test("HubSpot: reads owners with the token, follows `after`, maps teams, skips owners without email", async () => {
  const { ctx, calls } = fakeFetch((url) =>
    url.searchParams.get("after") === "abc"
      ? { body: { results: [{ id: "3", email: "c@co.com", firstName: "Cy", teams: [] }] } }
      : {
          body: {
            results: [
              { id: "1", email: "a@co.com", firstName: "Ann", lastName: "Lee", teams: [{ id: "t", name: "West Sales" }] },
              { id: "2", firstName: "No", lastName: "Email" },
            ],
            paging: { next: { after: "abc" } },
          },
        },
  );
  const first = await hubspot.listUsers({ accessToken: "pat-123" }, ctx);
  assert.deepEqual(first.users, [{ externalId: "1", email: "a@co.com", name: "Ann Lee", teams: ["West Sales"], active: true }]);
  assert.equal(first.nextCursor, "abc");
  assert.equal(header(calls[0].init, "authorization"), "Bearer pat-123");
  assert.equal(calls[0].url.host, "api.hubapi.com");

  const second = await hubspot.listUsers({ accessToken: "pat-123" }, ctx, "abc");
  assert.equal(second.users[0].email, "c@co.com");
  assert.equal(second.nextCursor, undefined);
});

test("HubSpot: a 401 is an error naming the credentials, never an empty page", async () => {
  const { ctx } = fakeFetch(() => ({ status: 401, body: { message: "bad token" } }));
  await assert.rejects(hubspot.listUsers({ accessToken: "x" }, ctx), /HubSpot answered 401\. Check the credentials/);
});

test("HubSpot: a missing token is reported before any request", async () => {
  const { ctx, calls } = fakeFetch(() => ({ body: {} }));
  await assert.rejects(hubspot.listUsers({}, ctx), /missing Private app access token/);
  assert.equal(calls.length, 0);
});

test("Salesforce: SOQL on the instance, nextRecordsUrl paging, department and role as teams, inactive kept as inactive", async () => {
  const { ctx, calls } = fakeFetch((url) =>
    url.pathname.endsWith("/query")
      ? {
          body: {
            done: false,
            nextRecordsUrl: "/services/data/v61.0/query/01g-2000",
            records: [{ Id: "005A", Name: "Ann Lee", Email: "ann@co.com", Title: "AE", Department: "Sales", UserRole: { Name: "West AE" }, IsActive: true }],
          },
        }
      : { body: { done: true, records: [{ Id: "005B", Name: "Bo", Email: "bo@co.com", IsActive: false }] } },
  );
  const config = { instanceUrl: "https://co.my.salesforce.com/", accessToken: "00D!tok" };
  const first = await salesforce.listUsers(config, ctx);
  assert.deepEqual(first.users[0].teams, ["Sales", "West AE"]);
  assert.equal(first.users[0].title, "AE");
  assert.match(calls[0].url.searchParams.get("q") ?? "", /FROM User WHERE UserType = 'Standard'/);
  const second = await salesforce.listUsers(config, ctx, first.nextCursor);
  assert.equal(calls[1].url.toString(), "https://co.my.salesforce.com/services/data/v61.0/query/01g-2000");
  assert.equal(second.users[0].active, false);
  assert.equal(second.nextCursor, undefined);
});

test("Salesforce: a next page on another host is refused, so the token is never sent elsewhere", async () => {
  const { ctx, calls } = fakeFetch(() => ({ body: { done: true, records: [] } }));
  const config = { instanceUrl: "https://co.my.salesforce.com", accessToken: "t" };
  await assert.rejects(salesforce.listUsers(config, ctx, "https://evil.example/steal"), /off the instance/);
  await assert.rejects(salesforce.listUsers({ ...config, instanceUrl: "http://co.my.salesforce.com" }, ctx), /must be https/);
  assert.equal(calls.length, 0);
});

test("Google: a service account signs a JWT for the admin, trades it for a token, and lists users", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { client_email: "chat@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  let claims: Record<string, unknown> = {};
  const { ctx, calls } = fakeFetch((url, init) => {
    if (url.host === "oauth2.googleapis.com") {
      const assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      const [h, c, sig] = assertion.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
      if (!ok) return { status: 400, body: { error: "invalid_grant" } };
      claims = JSON.parse(Buffer.from(c, "base64url").toString());
      return { body: { access_token: "ya29.test", expires_in: 3600 } };
    }
    return {
      body: {
        users: [
          { id: "g1", primaryEmail: "ann@co.com", name: { fullName: "Ann Lee" }, orgUnitPath: "/Sales/West", organizations: [{ primary: true, title: "AE", department: "Sales" }] },
          { id: "g2", primaryEmail: "old@co.com", name: { fullName: "Old" }, suspended: true },
        ],
      },
    };
  });
  const page = await google.listUsers({ serviceAccountJson: JSON.stringify(key), adminEmail: "admin@co.com" }, ctx);
  assert.equal(claims.sub, "admin@co.com");
  assert.equal(claims.iss, key.client_email);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/admin.directory.user.readonly");
  const list = calls.find((c) => c.url.host === "admin.googleapis.com");
  assert.equal(header(list!.init, "authorization"), "Bearer ya29.test");
  assert.equal(list!.url.searchParams.get("customer"), "my_customer");
  assert.deepEqual(page.users[0].teams, ["Sales", "West"]);
  assert.equal(page.users[0].title, "AE");
  assert.equal(page.users[1].active, false);
});

test("Google: with neither a key nor a token it says what to paste", async () => {
  const { ctx } = fakeFetch(() => ({ body: {} }));
  await assert.rejects(google.listUsers({}, ctx), /paste a service account key or an access token/);
});
