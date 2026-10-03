import { ConnectorError, type DirectoryConnector, type DirectoryUser, getJson, requireFields } from "./types.ts";

// Salesforce Users via SOQL. Standard users only, so community/portal and integration users stay out.
// https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm

const API_VERSION = "v61.0";
const SOQL =
  "SELECT Id, Name, Email, Title, Department, IsActive, SmallPhotoUrl, UserRole.Name " +
  "FROM User WHERE UserType = 'Standard' ORDER BY Id";

interface SfUser {
  Id: string;
  Name?: string;
  Email?: string;
  Title?: string | null;
  Department?: string | null;
  IsActive?: boolean;
  SmallPhotoUrl?: string | null;
  UserRole?: { Name?: string } | null;
}

interface QueryResponse {
  records: SfUser[];
  done: boolean;
  nextRecordsUrl?: string;
}

export function mapSfUser(u: SfUser): DirectoryUser | null {
  if (!u.Email) return null;
  const teams = [u.Department, u.UserRole?.Name].filter((t): t is string => !!t && t.trim() !== "");
  return {
    externalId: u.Id,
    email: u.Email,
    name: u.Name?.trim() || u.Email,
    title: u.Title ?? undefined,
    teams: [...new Set(teams)],
    avatarUrl: u.SmallPhotoUrl ?? undefined,
    active: u.IsActive !== false,
  };
}

function instance(config: Record<string, string>): string {
  let base: URL;
  try {
    base = new URL(config.instanceUrl.trim());
  } catch {
    throw new ConnectorError("Salesforce: the instance URL is not a URL");
  }
  if (base.protocol !== "https:") throw new ConnectorError("Salesforce: the instance URL must be https");
  return base.origin;
}

export const salesforce: DirectoryConnector = {
  id: "salesforce",
  label: "Salesforce",
  description: "Every standard Salesforce user. Departments and roles become channels.",
  setupHelp:
    "Use a connected app (or `sf org display`) to get an access token with the api scope, plus your instance URL such as https://yourcompany.my.salesforce.com.",
  fields: [
    { key: "instanceUrl", label: "Instance URL", type: "text", required: true, placeholder: "https://yourcompany.my.salesforce.com" },
    { key: "accessToken", label: "Access token", type: "password", required: true },
  ],
  async listUsers(config, ctx, cursor) {
    requireFields(this, config);
    const origin = instance(config);
    // The cursor is Salesforce's own nextRecordsUrl, a path on the same instance.
    const url = cursor
      ? new URL(cursor, origin).toString()
      : `${origin}/services/data/${API_VERSION}/query?q=${encodeURIComponent(SOQL)}`;
    if (new URL(url).origin !== origin) throw new ConnectorError("Salesforce: next page pointed off the instance");
    const page = await getJson<QueryResponse>(ctx, "Salesforce", url, {
      Authorization: `Bearer ${config.accessToken.trim()}`,
    });
    return {
      users: page.records.map(mapSfUser).filter((u): u is DirectoryUser => u !== null),
      nextCursor: page.done ? undefined : page.nextRecordsUrl,
    };
  },
};
