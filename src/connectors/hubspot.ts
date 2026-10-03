import { type DirectoryConnector, type DirectoryUser, getJson, requireFields } from "./types.ts";

// HubSpot "owners" are the people with seats in the portal: exactly the users a sales team chats with.
// https://developers.hubspot.com/docs/api/crm/owners

interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
  teams?: { id: string; name: string; primary?: boolean }[];
}

interface OwnersResponse {
  results: HubSpotOwner[];
  paging?: { next?: { after: string } };
}

export function mapOwner(o: HubSpotOwner): DirectoryUser | null {
  if (!o.email) return null; // an owner with no email cannot sign in, so it is not a chat user
  const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email;
  return {
    externalId: String(o.id),
    email: o.email,
    name,
    teams: (o.teams ?? []).map((t) => t.name).filter(Boolean),
    active: o.archived !== true,
  };
}

export const hubspot: DirectoryConnector = {
  id: "hubspot",
  label: "HubSpot",
  description: "Everyone with a seat in your HubSpot portal. Their HubSpot teams become channels.",
  setupHelp:
    "In HubSpot: Settings, Integrations, Private Apps, Create. Give it the crm.objects.owners.read scope and paste its access token here.",
  fields: [
    { key: "accessToken", label: "Private app access token", type: "password", required: true, placeholder: "pat-na1-…" },
  ],
  async listUsers(config, ctx, cursor) {
    requireFields(this, config);
    const url = new URL("https://api.hubapi.com/crm/v3/owners/");
    url.searchParams.set("limit", "100");
    url.searchParams.set("archived", "false");
    if (cursor) url.searchParams.set("after", cursor);
    const page = await getJson<OwnersResponse>(ctx, "HubSpot", url.toString(), {
      Authorization: `Bearer ${config.accessToken.trim()}`,
    });
    return {
      users: page.results.map(mapOwner).filter((u): u is DirectoryUser => u !== null),
      nextCursor: page.paging?.next?.after,
    };
  },
};
