import { str, workEmail } from "./oauth.ts";
import { type PasswordProvider, type SignInContext, SignInError } from "./types.ts";

// Log in with Werdna. Werdna has no "Log in with" for other apps yet (its OAuth server serves only its Claude
// connector), so the person's own Werdna email and password go straight to Werdna's login, exactly as its web
// page sends them. Werdna says who they are; the session it opened is closed at once; nothing is kept.
//   GET  /api/csrf-token   -> csrf-token + csrf-key cookies
//   POST /api/auth/login   -> { user } and a sid cookie (needs the x-csrf-token header)
//   POST /api/auth/logout  -> needs a CSRF token tied to the new session

/** Just enough of a cookie jar for one sign-in: name=value pairs from Set-Cookie, sent back on every call. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  get(name: string) {
    return this.cookies.get(name);
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export function werdnaOrigin(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  // Werdna's cookies are Secure, so only https gets a session back. localhost is allowed for development.
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("WERDNA_URL must start with https://");
  }
  return url.origin;
}

async function call(ctx: SignInContext, jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, headers, redirect: "manual" });
  } catch (err) {
    throw new SignInError(`Could not reach Werdna (${(err as Error).message})`);
  }
  jar.take(res);
  return res;
}

async function signOut(ctx: SignInContext, jar: Jar, base: string) {
  const res = await call(ctx, jar, `${base}/api/csrf-token`);
  const token = ((await res.json()) as { csrfToken?: string }).csrfToken;
  if (token) await call(ctx, jar, `${base}/api/auth/logout`, { method: "POST", headers: { "x-csrf-token": token } });
}

export function werdna(cfg: { baseUrl: string }): PasswordProvider {
  const base = werdnaOrigin(cfg.baseUrl);
  const host = new URL(base).host;
  return {
    kind: "password",
    id: "werdna",
    label: "Werdna",
    async verify(email, password, ctx) {
      if (!email.trim() || !password) throw new SignInError("Enter your Werdna email and password");
      const jar = new Jar();
      const tokenRes = await call(ctx, jar, `${base}/api/csrf-token`);
      const csrf = ((await tokenRes.json().catch(() => ({}))) as { csrfToken?: string }).csrfToken ?? jar.get("csrf-token");
      if (!tokenRes.ok || !csrf) throw new SignInError(`Werdna is not answering sign-ins right now (${tokenRes.status})`);

      const login = await call(ctx, jar, `${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (login.status === 401) throw new SignInError("Wrong Werdna email or password");
      if (login.status === 423) throw new SignInError("That Werdna account is locked after too many tries; wait and retry");
      if (!login.ok) throw new SignInError(`Werdna refused the sign-in (${login.status})`);
      try {
        const { user } = (await login.json()) as { user?: Record<string, unknown> };
        const signedIn = workEmail(user?.email, "Werdna");
        const name = [str(user?.firstName), str(user?.lastName)].filter(Boolean).join(" ").trim();
        const picture = str(user?.profileImageUrl);
        return {
          provider: "werdna",
          companyId: host,
          companyName: host,
          email: signedIn,
          name: name || signedIn,
          avatarUrl: picture ? new URL(picture, base).toString() : undefined,
        };
      } finally {
        // Leave no session behind on Werdna. Best effort: a failed sign-out does not undo the sign-in.
        if (jar.get("sid")) await signOut(ctx, jar, base).catch(() => {});
      }
    },
  };
}
