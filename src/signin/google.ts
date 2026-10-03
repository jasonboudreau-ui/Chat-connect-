import { checkIdToken, idTokenClaims, postForm, str, withQuery, workEmail } from "./oauth.ts";
import { type RedirectProvider, SignInError } from "./types.ts";

// Log in with Google (Workspace). The company is the workspace domain Google vouches for (`hd`); a personal
// Gmail account has none, so it has no company to join.

const WHO = "Google";

export function google(cfg: { clientId: string; clientSecret: string }): RedirectProvider {
  return {
    kind: "redirect",
    id: "google",
    label: "Google",
    authorizeUrl: ({ state, nonce, challenge, redirectUri }) =>
      withQuery("https://accounts.google.com/o/oauth2/v2/auth", {
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
        "https://oauth2.googleapis.com/token",
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret },
        WHO,
      );
      const claims = idTokenClaims(tokens.id_token, WHO);
      checkIdToken(
        claims,
        { issuer: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com", clientId: cfg.clientId, nonce, now: ctx.now?.() ?? Date.now() },
        WHO,
      );
      if (claims.email_verified !== true) throw new SignInError("Google has not verified this account's email");
      const domain = str(claims.hd).toLowerCase();
      if (!domain) throw new SignInError("That is a personal Google account. Use your work account; a personal Gmail has no company to join.");
      const email = workEmail(claims.email, WHO);
      return { provider: "google", companyId: domain, companyName: domain, email, name: str(claims.name) || email, avatarUrl: str(claims.picture) || undefined };
    },
  };
}
