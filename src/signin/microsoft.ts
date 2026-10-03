import { checkIdToken, domainOf, idTokenClaims, postForm, str, withQuery, workEmail } from "./oauth.ts";
import { type RedirectProvider, SignInError } from "./types.ts";

// Log in with Microsoft (Entra ID / Microsoft 365, which Dynamics 365 uses too). The company is the tenant.
// The `organizations` endpoint already keeps personal Microsoft accounts out; the tenant check is a backstop.

const WHO = "Microsoft";
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const BASE = "https://login.microsoftonline.com/organizations/oauth2/v2.0";

export function microsoft(cfg: { clientId: string; clientSecret: string }): RedirectProvider {
  return {
    kind: "redirect",
    id: "microsoft",
    label: "Microsoft",
    authorizeUrl: ({ state, nonce, challenge, redirectUri }) =>
      withQuery(`${BASE}/authorize`, {
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }),
    async finish({ code, verifier, nonce, redirectUri }, ctx) {
      const tokens = await postForm(
        ctx,
        `${BASE}/token`,
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "openid email profile" },
        WHO,
      );
      const claims = idTokenClaims(tokens.id_token, WHO);
      const tenant = str(claims.tid);
      checkIdToken(
        claims,
        { issuer: (iss) => !!tenant && iss === `https://login.microsoftonline.com/${tenant}/v2.0`, clientId: cfg.clientId, nonce, now: ctx.now?.() ?? Date.now() },
        WHO,
      );
      if (tenant === PERSONAL_TENANT) throw new SignInError("That is a personal Microsoft account. Use your work account.");
      const email = workEmail(claims.email || claims.preferred_username, WHO);
      return { provider: "microsoft", companyId: tenant, companyName: domainOf(email), email, name: str(claims.name) || email };
    },
  };
}
