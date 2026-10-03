import { createHash, randomBytes } from "node:crypto";
import { type SignInContext, SignInError } from "./types.ts";

// The pieces every "Log in with" provider shares: the OAuth 2 authorization-code flow with PKCE, and the
// checks on an OpenID Connect ID token.

export const randomToken = () => randomBytes(24).toString("base64url");

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** POST a form to a token endpoint and return its JSON; an OAuth error comes back as a SignInError. */
export async function postForm(ctx: SignInContext, url: string, form: Record<string, string>, who: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new SignInError(`Could not reach ${who} (${(err as Error).message})`);
  }
  return readJson(res, who);
}

export async function getJson(ctx: SignInContext, url: string, accessToken: string, who: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  } catch (err) {
    throw new SignInError(`Could not reach ${who} (${(err as Error).message})`);
  }
  return readJson(res, who);
}

async function readJson(res: Response, who: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const why = body.error_description ?? body.message ?? body.error;
    throw new SignInError(`${who} refused the sign-in (${res.status}${typeof why === "string" ? `: ${why}` : ""})`);
  }
  return body;
}

/**
 * The claims of an ID token. Its signature is not checked: the token came straight from the provider's token
 * endpoint over https in exchange for a one-time code, which OpenID Connect Core 3.1.3.7 accepts in place of
 * a signature check. Never use this on a token that arrived any other way.
 */
export function idTokenClaims(idToken: unknown, who: string): Record<string, unknown> {
  if (typeof idToken !== "string") throw new SignInError(`${who} sent no ID token`);
  const payload = idToken.split(".")[1];
  try {
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) throw new Error();
    return claims;
  } catch {
    throw new SignInError(`${who} sent an ID token that could not be read`);
  }
}

/** The checks that tie an ID token to this sign-in: our app, this attempt, not expired, the right issuer. */
export function checkIdToken(
  claims: Record<string, unknown>,
  expect: { issuer: (iss: string) => boolean; clientId: string; nonce: string; now: number },
  who: string,
) {
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (typeof claims.iss !== "string" || !expect.issuer(claims.iss)) throw new SignInError(`${who}'s ID token came from the wrong issuer`);
  if (!audiences.includes(expect.clientId)) throw new SignInError(`${who}'s ID token was not issued to this app`);
  if (claims.nonce !== expect.nonce) throw new SignInError(`${who}'s ID token does not belong to this sign-in`);
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expect.now) throw new SignInError(`${who}'s ID token has expired`);
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");

export function workEmail(email: unknown, who: string): string {
  const e = str(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new SignInError(`${who} did not say which email this account uses`);
  return e;
}

export const domainOf = (email: string) => email.slice(email.indexOf("@") + 1);
