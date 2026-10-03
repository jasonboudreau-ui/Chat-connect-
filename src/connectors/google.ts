import { createSign } from "node:crypto";
import { ConnectorError, type ConnectorContext, type DirectoryConnector, type DirectoryUser, getJson, requireFields } from "./types.ts";

// Google Workspace users from the Admin SDK Directory API.
// https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/list
// Auth is a service account with domain-wide delegation, impersonating an admin: the one setup that keeps
// working unattended. A pasted OAuth access token also works for a quick try (it expires in an hour).

const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleUser {
  id: string;
  primaryEmail?: string;
  name?: { fullName?: string };
  suspended?: boolean;
  archived?: boolean;
  orgUnitPath?: string;
  thumbnailPhotoUrl?: string;
  organizations?: { primary?: boolean; title?: string; department?: string }[];
}

interface UsersResponse {
  users?: GoogleUser[];
  nextPageToken?: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function mapGoogleUser(u: GoogleUser): DirectoryUser | null {
  if (!u.primaryEmail) return null;
  const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0];
  const teams: string[] = [];
  if (org?.department) teams.push(org.department);
  const unit = u.orgUnitPath?.split("/").filter(Boolean).pop();
  if (unit) teams.push(unit);
  return {
    externalId: u.id,
    email: u.primaryEmail,
    name: u.name?.fullName?.trim() || u.primaryEmail,
    title: org?.title || undefined,
    teams: [...new Set(teams)],
    avatarUrl: u.thumbnailPhotoUrl,
    active: u.suspended !== true && u.archived !== true,
  };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A signed JWT-bearer assertion for the service account, acting as `subject` (an admin). */
export function signAssertion(key: ServiceAccountKey, subject: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, sub: subject, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function serviceAccountToken(config: Record<string, string>, ctx: ConnectorContext): Promise<string> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(config.serviceAccountJson);
  } catch {
    throw new ConnectorError("Google: the service account key is not valid JSON");
  }
  if (!key.client_email || !key.private_key) throw new ConnectorError("Google: the key has no client_email or private_key");
  const subject = config.adminEmail?.trim();
  if (!subject) throw new ConnectorError("Google: a service account needs an admin email to act as");

  const cacheKey = `${key.client_email}|${subject}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const assertion = signAssertion(key, subject, Math.floor(Date.now() / 1000));
  const res = await ctx.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConnectorError(
      `Google refused the service account (${res.status}). Check domain-wide delegation for ${SCOPE}. ${body.slice(0, 200)}`.trim(),
      res.status,
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

export const google: DirectoryConnector = {
  id: "google",
  label: "Google Workspace",
  description: "Everyone in your Google Workspace domain. Departments and org units become channels.",
  setupHelp:
    "Create a service account in Google Cloud, give it domain-wide delegation for admin.directory.user.readonly in the Admin console, and paste its JSON key plus an admin's email. Or paste a short-lived OAuth access token to try it out.",
  fields: [
    { key: "serviceAccountJson", label: "Service account key (JSON)", type: "textarea", required: false },
    { key: "adminEmail", label: "Admin email to act as", type: "text", required: false, placeholder: "admin@yourcompany.com" },
    { key: "accessToken", label: "Or: OAuth access token", type: "password", required: false },
    { key: "domain", label: "Domain (optional, defaults to all)", type: "text", required: false, placeholder: "yourcompany.com" },
  ],
  async listUsers(config, ctx, cursor) {
    requireFields(this, config);
    let token: string;
    if (config.serviceAccountJson?.trim()) token = await serviceAccountToken(config, ctx);
    else if (config.accessToken?.trim()) token = config.accessToken.trim();
    else throw new ConnectorError("Google: paste a service account key or an access token");

    const url = new URL("https://admin.googleapis.com/admin/directory/v1/users");
    if (config.domain?.trim()) url.searchParams.set("domain", config.domain.trim());
    else url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("orderBy", "email");
    if (cursor) url.searchParams.set("pageToken", cursor);
    const page = await getJson<UsersResponse>(ctx, "Google", url.toString(), { Authorization: `Bearer ${token}` });
    return {
      users: (page.users ?? []).map(mapGoogleUser).filter((u): u is DirectoryUser => u !== null),
      nextCursor: page.nextPageToken,
    };
  },
};
