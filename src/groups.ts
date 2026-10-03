import { randomUUID } from "node:crypto";

// Groups: channels that span companies and CRMs. A company's own chat stays walled off; a group is the one
// place people from different companies meet, and only the people in it see it.
//
// Someone is their email, as the system they logged in with vouches for it. So an invite is an email address,
// and whoever next logs in with that email, through any provider, finds the group waiting.

export interface Member {
  email: string;
  name: string;
  company: string;
  avatarUrl?: string;
}

export interface GroupMessage {
  id: string;
  channelId: string;
  /** The author's email: group members come from many companies, so there is no shared person id. */
  authorId: string;
  author: Member;
  text: string;
  at: string;
}

export interface Group {
  id: string;
  title: string;
  createdBy: string;
  members: Map<string, Member>;
  /** Emails invited who have not logged in since. */
  invites: Set<string>;
  messages: GroupMessage[];
}

export type GroupEvent =
  | { type: "group"; group: Group }
  | { type: "message"; group: Group; message: GroupMessage };

export const GROUP_PREFIX = "g:";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_HISTORY = 500;

export const normalEmail = (email: string) => email.trim().toLowerCase();

export class Groups {
  groups = new Map<string, Group>();
  private listeners: ((e: GroupEvent) => void)[] = [];

  on(listener: (e: GroupEvent) => void) {
    this.listeners.push(listener);
  }

  private emit(e: GroupEvent) {
    for (const l of this.listeners) l(e);
  }

  create(title: string, creator: Member): Group {
    const clean = title.trim().slice(0, 80);
    if (!clean) throw new Error("Give the group a name");
    const group: Group = { id: `${GROUP_PREFIX}${randomUUID()}`, title: clean, createdBy: creator.email, members: new Map(), invites: new Set(), messages: [] };
    group.members.set(creator.email, creator);
    this.groups.set(group.id, group);
    this.emit({ type: "group", group });
    return group;
  }

  isMember(group: Group, email: string) {
    return group.members.has(normalEmail(email));
  }

  /** The groups someone is in, after taking up any invites waiting for their email. */
  forMember(me: Member): Group[] {
    const email = normalEmail(me.email);
    const mine: Group[] = [];
    for (const g of this.groups.values()) {
      if (g.invites.delete(email)) {
        g.members.set(email, { ...me, email });
        this.emit({ type: "group", group: g });
      } else if (g.members.has(email)) {
        // Keep the name and picture as the person's own system last gave them.
        g.members.set(email, { ...me, email });
      }
      if (g.members.has(email)) mine.push(g);
    }
    return mine;
  }

  /** Invite by email. Someone already known joins at once; anyone else joins when they next log in. */
  invite(group: Group, emails: string[], known: (email: string) => Member | undefined) {
    const added: string[] = [];
    for (const raw of emails) {
      const email = normalEmail(raw);
      if (!EMAIL.test(email)) throw new Error(`"${raw}" is not an email address`);
      if (group.members.has(email) || group.invites.has(email)) continue;
      const member = known(email);
      if (member) group.members.set(email, { ...member, email });
      else group.invites.add(email);
      added.push(email);
    }
    if (added.length) this.emit({ type: "group", group });
    return added;
  }

  leave(group: Group, email: string) {
    group.members.delete(normalEmail(email));
    this.emit({ type: "group", group });
  }

  post(group: Group, author: Member, text: string): GroupMessage {
    const message: GroupMessage = { id: randomUUID(), channelId: group.id, authorId: normalEmail(author.email), author, text, at: new Date().toISOString() };
    group.messages.push(message);
    if (group.messages.length > MAX_HISTORY) group.messages.splice(0, group.messages.length - MAX_HISTORY);
    this.emit({ type: "message", group, message });
    return message;
  }
}
