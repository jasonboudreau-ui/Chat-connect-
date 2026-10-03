import { domainOf, getJson, postForm, str, withQuery, workEmail } from "./oauth.ts";
import { type RedirectProvider, SignInError } from "./types.ts";

// Log in with Salesforce. The company is the Salesforce org. Who the person is comes from Salesforce's
// userinfo endpoint, called once with the access token, which is then dropped.

const WHO = "Salesforce";

export function salesforce(cfg: { clientId: string; clientSecret: string; loginUrl?: string }): RedirectProvider {
  const login = new URL(cfg.loginUrl || "https://login.salesforce.com").origin;
  if (!login.startsWith("https://")) throw new Error("SALESFORCE_LOGIN_URL must start with https://");
  return {
    kind: "redirect",
    id: "salesforce",
    label: "Salesforce",
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      withQuery(`${login}/services/oauth2/authorize`, {
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "login",
      }),
    async finish({ code, verifier, redirectUri }, ctx) {
      const tokens = await postForm(
        ctx,
        `${login}/services/oauth2/token`,
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret },
        WHO,
      );
      const accessToken = str(tokens.access_token);
      if (!accessToken) throw new SignInError("Salesforce sent no access token");
      const me = await getJson(ctx, `${login}/services/oauth2/userinfo`, accessToken, WHO);
      const org = str(me.organization_id);
      if (!org) throw new SignInError("Salesforce did not say which org this account belongs to");
      if (me.email_verified === false) throw new SignInError("Salesforce has not verified this account's email");
      const email = workEmail(me.email, WHO);
      return { provider: "salesforce", companyId: org, companyName: domainOf(email), email, name: str(me.name) || email, avatarUrl: str(me.picture) || undefined };
    },
  };
}
