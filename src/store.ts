import { randomUUID } from "node:crypto";
import type { ConnectorConfig, ConnectorContext, DirectoryConnector, DirectoryUser } from "./connectors/types.ts";

// All chat state. In memory for the proof of concept; the shapes are what a Postgres version would store.

/** Where one person came from. A person found in two directories has two sources and is still one person. */
export interface PersonSource {
  connectionId: string;
  connectorId: string;
  externalId: string;
  teams: string[];
  active: boolean;
}

export interface Person {
  id: string;
  /** Lowercased; the key that joins the same human across directories. */
  email: string;
  name: string;
  title?: string;
  avatarUrl?: string;
  sources: PersonSource[];
}

export interface Connection {
  id: string;
  connectorId: string;
  label: string;
  config: ConnectorConfig;
  createdAt: string;
  lastSync?: SyncResult;
}

export interface SyncResult {
  at: string;
  ok: boolean;
  error?: string;
  seen: number;
  added: number;
  updated: number;
  deactivated: number;
}

export type ChannelKind = "team" | "custom" | "dm";

export interface Channel {
  id: string;
  kind: ChannelKind;
  /** For team channels, the normalized team key; "Sales" from HubSpot and Google is one channel. */
  name: string;
  /** Display name: the team as the directory spells it, or what the creator typed. */
  title: string;
  /** Only DMs restrict membership; team and custom channels are open to every active person. */
  memberIds?: string[];
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  text: string;
  at: string;
}

export const isActive = (p: Person) => p.sources.some((s) => s.active);
export const teamsOf = (p: Person) => [...new Set(p.sources.filter((s) => s.active).flatMap((s) => s.teams))];
export const teamKey = (team: string) => team.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export type StoreEvent =
  | { type: "message"; message: Message }
  | { type: "channel"; channel: Channel }
  | { type: "directory" };

export class Store {
  people = new Map<string, Person>();
  connections = new Map<string, Connection>();
  channels = new Map<string, Channel>();
  messages: Message[] = [];
  private listeners = new Set<(e: StoreEvent) => void>();

  constructor() {
    const general: Channel = { id: "general", kind: "custom", name: "general", title: "general", createdAt: new Date().toISOString() };
    this.channels.set(general.id, general);
  }

  on(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.listeners) fn(e);
  }

  personByEmail(email: string): Person | undefined {
    const key = email.trim().toLowerCase();
    for (const p of this.people.values()) if (p.email === key) return p;
    return undefined;
  }

  /**
   * Someone their company's own system just vouched for at sign-in. Held in memory while the app runs, never
   * written anywhere; the next sign-in brings them back with whatever their company says then.
   */
  admit(u: { email: string; name: string; avatarUrl?: string }, provider: string): Person {
    const email = u.email.trim().toLowerCase();
    const source: PersonSource = { connectionId: `signin:${provider}`, connectorId: provider, externalId: email, teams: [], active: true };
    const existing = this.personByEmail(email);
    if (!existing) {
      const person: Person = { id: randomUUID(), email, name: u.name, avatarUrl: u.avatarUrl, sources: [source] };
      this.people.set(person.id, person);
      this.emit({ type: "directory" });
      return person;
    }
    const i = existing.sources.findIndex((s) => s.connectionId === source.connectionId);
    const changed = i === -1 || !existing.sources[i].active || existing.name !== u.name || existing.avatarUrl !== u.avatarUrl;
    if (i === -1) existing.sources.push(source);
    else existing.sources[i] = source;
    existing.name = u.name || existing.name;
    existing.avatarUrl = u.avatarUrl ?? existing.avatarUrl;
    if (changed) this.emit({ type: "directory" });
    return existing;
  }

  addConnection(connectorId: string, label: string, config: ConnectorConfig): Connection {
    const c: Connection = { id: randomUUID(), connectorId, label, config, createdAt: new Date().toISOString() };
    this.connections.set(c.id, c);
    return c;
  }

  /**
   * Pull every page from the directory, then apply it in one step. A failure on any page changes nothing:
   * a half-read directory must never deactivate the people on the pages we did not get.
   */
  async sync(connection: Connection, connector: DirectoryConnector, ctx: ConnectorContext): Promise<SyncResult> {
    const at = new Date().toISOString();
    const users: DirectoryUser[] = [];
    try {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const page = await connector.listUsers(connection.config, ctx, cursor);
        users.push(...page.users);
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) throw new Error(`${connector.label} returned the same page twice`);
          seenCursors.add(cursor);
        }
      } while (cursor !== undefined);
    } catch (err) {
      return this.recordSync(connection, { at, ok: false, error: (err as Error).message, seen: 0, added: 0, updated: 0, deactivated: 0 });
    }

    const previouslyActive = [...this.people.values()].filter((p) =>
      p.sources.some((s) => s.connectionId === connection.id && s.active),
    ).length;
    if (users.length === 0 && previouslyActive > 0) {
      // An empty answer from a directory that had people is far likelier a scope or filter change than
      // everybody leaving. Keep everyone and say so.
      return this.recordSync(connection, {
        at,
        ok: false,
        error: `${connector.label} returned nobody; kept the ${previouslyActive} people from the last sync`,
        seen: 0,
        added: 0,
        updated: 0,
        deactivated: 0,
      });
    }

    let added = 0;
    let updated = 0;
    let deactivated = 0;
    const seenIds = new Set<string>();
    for (const u of users) {
      const email = u.email.trim().toLowerCase();
      if (!email.includes("@")) continue;
      seenIds.add(u.externalId);
      const source: PersonSource = {
        connectionId: connection.id,
        connectorId: connection.connectorId,
        externalId: u.externalId,
        teams: u.teams,
        active: u.active,
      };
      const existing = this.personByEmail(email);
      if (!existing) {
        const id = randomUUID();
        this.people.set(id, {
          id,
          email,
          name: u.name,
          title: u.title,
          avatarUrl: u.avatarUrl,
          sources: [source],
        });
        added++;
        continue;
      }
      const i = existing.sources.findIndex((s) => s.connectionId === connection.id);
      if (i === -1) existing.sources.push(source);
      else existing.sources[i] = source;
      existing.name = u.name || existing.name;
      if (u.title !== undefined) existing.title = u.title;
      if (u.avatarUrl !== undefined) existing.avatarUrl = u.avatarUrl;
      updated++;
    }
    // Anyone this connection had before but did not list now has left that directory. They are deactivated,
    // never deleted, so their messages keep an author.
    for (const p of this.people.values()) {
      for (const s of p.sources) {
        if (s.connectionId === connection.id && s.active && !seenIds.has(s.externalId)) {
          s.active = false;
          deactivated++;
        }
      }
    }

    this.ensureTeamChannels();
    this.emit({ type: "directory" });
    return this.recordSync(connection, { at, ok: true, seen: users.length, added, updated, deactivated });
  }

  private recordSync(connection: Connection, result: SyncResult): SyncResult {
    connection.lastSync = result;
    return result;
  }

  /** One channel per team any active person belongs to. Channels are never removed, so history stays. */
  ensureTeamChannels() {
    for (const p of this.people.values()) {
      if (!isActive(p)) continue;
      for (const team of teamsOf(p)) {
        const key = teamKey(team);
        if (!key) continue;
        const id = `team:${key}`;
        if (this.channels.has(id)) continue;
        const channel: Channel = { id, kind: "team", name: key, title: team.trim(), createdAt: new Date().toISOString() };
        this.channels.set(id, channel);
        this.emit({ type: "channel", channel });
      }
    }
  }

  /** People on a team channel right now, derived from the directories rather than stored. */
  teamMembers(channel: Channel): Person[] {
    return [...this.people.values()].filter((p) => isActive(p) && teamsOf(p).some((t) => teamKey(t) === channel.name));
  }

  canSee(person: Person, channel: Channel): boolean {
    if (!isActive(person)) return false;
    if (channel.kind === "dm") return channel.memberIds?.includes(person.id) ?? false;
    return true;
  }

  createChannel(title: string): Channel {
    const name = teamKey(title);
    if (!name) throw new Error("A channel needs a name");
    const existing = [...this.channels.values()].find((c) => c.kind !== "dm" && c.name === name);
    if (existing) return existing;
    const channel: Channel = { id: randomUUID(), kind: "custom", name, title: title.trim(), createdAt: new Date().toISOString() };
    this.channels.set(channel.id, channel);
    this.emit({ type: "channel", channel });
    return channel;
  }

  openDm(a: Person, b: Person): Channel {
    const memberIds = [a.id, b.id].sort();
    const id = `dm:${memberIds.join(":")}`;
    let channel = this.channels.get(id);
    if (!channel) {
      channel = { id, kind: "dm", name: id, title: "", memberIds, createdAt: new Date().toISOString() };
      this.channels.set(id, channel);
      this.emit({ type: "channel", channel });
    }
    return channel;
  }

  post(author: Person, channel: Channel, text: string): Message {
    const message: Message = { id: randomUUID(), channelId: channel.id, authorId: author.id, text, at: new Date().toISOString() };
    this.messages.push(message);
    this.emit({ type: "message", message });
    return message;
  }

  history(channel: Channel, limit = 200): Message[] {
    return this.messages.filter((m) => m.channelId === channel.id).slice(-limit);
  }
}
