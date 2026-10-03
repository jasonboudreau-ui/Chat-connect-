// The one interface every user directory implements. A "directory" is wherever a company already keeps its
// people: a CRM (HubSpot, Salesforce), Google Workspace, or the demo company. Chat never creates users of its
// own; it only mirrors what a directory says.

export interface DirectoryUser {
  /** The directory's own id for this person; stable across syncs. */
  externalId: string;
  email: string;
  name: string;
  title?: string;
  /** Teams, departments or org units; each becomes an auto-managed channel. */
  teams: string[];
  avatarUrl?: string;
  /** False when the directory says this person is archived, suspended or deactivated. */
  active: boolean;
}

/** One field on the "connect" form. Secret fields are never sent back to the browser. */
export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea";
  required: boolean;
  help?: string;
  placeholder?: string;
}

export type ConnectorConfig = Record<string, string>;

export interface DirectoryPage {
  users: DirectoryUser[];
  /** Absent when this was the last page. */
  nextCursor?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConnectorContext {
  fetch: FetchLike;
}

export interface DirectoryConnector {
  /** Stable key, e.g. "hubspot". */
  id: string;
  label: string;
  /** One line shown on the connect card. */
  description: string;
  /** Where to get the credentials, shown under the form. */
  setupHelp: string;
  fields: ConfigField[];
  /** Reads one page of people. Throws on any error; a failed page must never look like an empty directory. */
  listUsers(config: ConnectorConfig, ctx: ConnectorContext, cursor?: string): Promise<DirectoryPage>;
}
