import type { ConnectorContext, DirectoryConnector, DirectoryUser } from "../src/connectors/types.ts";

/** A fetch that answers from a function and records every request. */
export function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const ctx: ConnectorContext = {
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      const { status = 200, body } = handler(url, init);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  };
  return { ctx, calls };
}

export const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

/** A connector whose pages are whatever the test sets; a page can be an Error to throw. */
export function scripted(id = "test") {
  const state: { pages: (DirectoryUser[] | Error)[] } = { pages: [] };
  const connector: DirectoryConnector = {
    id,
    label: `Scripted ${id}`,
    description: "",
    setupHelp: "",
    fields: [],
    async listUsers(_config, _ctx, cursor) {
      const i = cursor ? Number(cursor) : 0;
      const page = state.pages[i];
      if (page instanceof Error) throw page;
      return { users: page ?? [], nextCursor: i + 1 < state.pages.length ? String(i + 1) : undefined };
    },
  };
  return { connector, state };
}

export const user = (externalId: string, email: string, teams: string[] = [], extra: Partial<DirectoryUser> = {}): DirectoryUser => ({
  externalId,
  email,
  name: email.split("@")[0],
  teams,
  active: true,
  ...extra,
});

export const noFetch: ConnectorContext = {
  fetch: async () => {
    throw new Error("no network in tests");
  },
};
