import { google } from "./google.ts";
import { hubspot } from "./hubspot.ts";
import { microsoft } from "./microsoft.ts";
import { salesforce } from "./salesforce.ts";
import type { SignInProvider } from "./types.ts";
import { werdna } from "./werdna.ts";

// Every provider is switched on by its environment settings: the client id and secret from registering this
// app with that provider. One without its settings is simply not offered.

export function providersFromEnv(env: Record<string, string | undefined>): SignInProvider[] {
  const list: SignInProvider[] = [];
  const pair = (prefix: string) => {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const g = pair("GOOGLE");
  if (g) list.push(google(g));
  const ms = pair("MICROSOFT");
  if (ms) list.push(microsoft(ms));
  const sf = pair("SALESFORCE");
  if (sf) list.push(salesforce({ ...sf, loginUrl: env.SALESFORCE_LOGIN_URL }));
  const hs = pair("HUBSPOT");
  if (hs) list.push(hubspot(hs));
  if (env.WERDNA_URL) list.push(werdna({ baseUrl: env.WERDNA_URL }));
  return list;
}
