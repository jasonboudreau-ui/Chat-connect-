import { demo } from "./connectors/demo.ts";
import { createApp } from "./server.ts";
import { providersFromEnv } from "./signin/index.ts";
import { Store } from "./store.ts";

// Entry point. Each "Log in with" choice is switched on by its settings in the environment. The made-up
// demo company is there too unless CRM_CHAT_DEMO=0, so the app can be tried before any provider is set up.

const env = process.env;
const port = Number(env.PORT ?? 4310);
const baseUrl = env.PUBLIC_URL || `http://localhost:${port}`;

const providers = providersFromEnv(env);

let demoStore: Store | undefined;
if (env.CRM_CHAT_DEMO !== "0") {
  demoStore = new Store();
  await demoStore.sync(demoStore.addConnection("demo", "Demo company", {}), demo, { fetch: () => Promise.reject(new Error("offline")) });
}

if (!env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: everyone is signed out whenever the app restarts");

const { server } = createApp({ providers, baseUrl, sessionSecret: env.SESSION_SECRET, demo: demoStore });

server.listen(port, () => {
  console.log(`CRM Chat on ${baseUrl}`);
  console.log(`log in with: ${[...providers.map((p) => p.label), ...(demoStore ? ["the demo company"] : [])].join(", ") || "nothing yet; see README"}`);
});
