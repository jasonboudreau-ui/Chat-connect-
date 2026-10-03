import { createApp } from "./server.ts";

// Entry point. Directories can be connected from the UI, or here from the environment so a deploy comes up
// already connected. With none configured, the demo company is connected so there is someone to talk to.

const env = process.env;
const port = Number(env.PORT ?? 4310);
const syncMinutes = Number(env.SYNC_MINUTES ?? 15);

const { server, connect, syncAll } = createApp({ adminToken: env.ADMIN_TOKEN || undefined });

const fromEnv: [string, Record<string, string | undefined>][] = [
  ["hubspot", { accessToken: env.HUBSPOT_ACCESS_TOKEN }],
  ["salesforce", { instanceUrl: env.SALESFORCE_INSTANCE_URL, accessToken: env.SALESFORCE_ACCESS_TOKEN }],
  ["google", { serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, adminEmail: env.GOOGLE_ADMIN_EMAIL, domain: env.GOOGLE_DOMAIN }],
];

let connected = 0;
for (const [id, raw] of fromEnv) {
  const values = Object.entries(raw).filter((e): e is [string, string] => !!e[1]);
  if (values.length === 0) continue;
  try {
    await connect(id, Object.fromEntries(values));
    connected++;
    console.log(`connected ${id} from the environment`);
  } catch (err) {
    console.error(`could not connect ${id}: ${(err as Error).message}`);
  }
}
if (connected === 0 && env.CRM_CHAT_DEMO !== "0") {
  await connect("demo", {});
  console.log("no directory configured; connected the demo company");
}

if (syncMinutes > 0) setInterval(() => void syncAll(), syncMinutes * 60_000).unref();

server.listen(port, () => {
  console.log(`CRM Chat on http://localhost:${port}`);
});
