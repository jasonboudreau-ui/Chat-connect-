import { createHmac, timingSafeEqual } from "node:crypto";

// A signed, expiring value kept by the browser, so the server holds no session table. The signature stops
// anyone from editing it; it is not encrypted, so it carries nothing secret (who you are, which company).

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function seal(data: Record<string, unknown>, secret: string, maxAgeSeconds: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(now / 1000) + maxAgeSeconds })).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function unseal<T>(token: string | undefined, secret: string, now = Date.now()): T | undefined {
  if (!token) return undefined;
  const [body, sig] = token.split(".");
  if (!body || !sig) return undefined;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data?.exp !== "number" || data.exp * 1000 <= now) return undefined;
    return data as T;
  } catch {
    return undefined;
  }
}
