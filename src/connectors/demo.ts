import type { DirectoryConnector, DirectoryUser } from "./types.ts";

// A made-up company so the app runs with no credentials at all. Two pages, so paging is exercised too.

const PEOPLE: [string, string, string[]][] = [
  ["Avery Cole", "VP of Sales", ["Sales", "Leadership"]],
  ["Jordan Reyes", "Account Executive", ["Sales"]],
  ["Sam Patel", "Account Executive", ["Sales"]],
  ["Riley Chen", "Sales Development Rep", ["Sales"]],
  ["Morgan Diaz", "Customer Success Manager", ["Customer Success"]],
  ["Casey Brooks", "Onboarding Specialist", ["Customer Success"]],
  ["Taylor Nguyen", "Support Lead", ["Support", "Customer Success"]],
  ["Jamie Okafor", "Marketing Manager", ["Marketing"]],
  ["Drew Larsen", "Content Lead", ["Marketing"]],
  ["Quinn Murphy", "CEO", ["Leadership"]],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, ".");
}

export const demoUsers: DirectoryUser[] = PEOPLE.map(([name, title, teams], i) => ({
  externalId: `demo-${i + 1}`,
  email: `${slug(name)}@demo.example`,
  name,
  title,
  teams,
  active: true,
}));

const PAGE = 6;

export const demo: DirectoryConnector = {
  id: "demo",
  label: "Demo company",
  description: "Ten made-up people across Sales, Success, Support and Marketing. No credentials needed.",
  setupHelp: "Nothing to set up. Use this to try the app, then connect your real CRM.",
  fields: [],
  async listUsers(_config, _ctx, cursor) {
    const start = cursor ? Number(cursor) : 0;
    const users = demoUsers.slice(start, start + PAGE);
    const next = start + PAGE;
    return { users, nextCursor: next < demoUsers.length ? String(next) : undefined };
  },
};
