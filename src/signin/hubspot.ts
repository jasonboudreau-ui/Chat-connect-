import { postForm, str, withQuery, workEmail } from "./oauth.ts";
import { type RedirectProvider, SignInError } from "./types.ts";

// Log in with HubSpot. HubSpot is plain OAuth, not OpenID Connect: after the code exchange, its access-token
// lookup says which user approved and in which HubSpot account (the company). The token is then dropped.

const WHO = "HubSpot";

export function hubspot(cfg: { clientId: string; clientSecret: string }): RedirectProvider {
  return {
    kind: "redirect",
    id: "hubspot",
    label: "HubSpot",
    authorizeUrl: ({ state, redirectUri }) =>
      withQuery("https://app.hubspot.com/oauth/authorize", { client_id: cfg.clientId, redirect_uri: redirectUri, scope: "oauth", state }),
    async finish({ code, redirectUri }, ctx) {
      const tokens = await postForm(
        ctx,
        "https://api.hubapi.com/oauth/v1/token",
        { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret },
        WHO,
      );
      const accessToken = str(tokens.access_token);
      if (!accessToken) throw new SignInError("HubSpot sent no access token");
      let res: Response;
      try {
        res = await ctx.fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, { headers: { Accept: "application/json" } });
      } catch (err) {
        throw new SignInError(`Could not reach HubSpot (${(err as Error).message})`);
      }
      const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new SignInError(`HubSpot would not say who signed in (${res.status})`);
      if (typeof info.hub_id !== "number" && typeof info.hub_id !== "string") throw new SignInError("HubSpot did not say which account this user belongs to");
      const email = workEmail(info.user, WHO);
      return { provider: "hubspot", companyId: String(info.hub_id), companyName: str(info.hub_domain) || `HubSpot ${info.hub_id}`, email, name: email };
    },
  };
}
