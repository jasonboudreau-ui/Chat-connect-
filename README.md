# CRM Chat (proof of concept)

Team chat where nobody signs up. People come from the directory a company already keeps: HubSpot, Salesforce,
Google Workspace, or any other source behind the same small interface. Connect a directory and everyone in it can
sign in; their teams, departments and roles become channels that stay in sync; someone removed from the CRM loses
access on their next request while their messages stay.

A standalone web app with no dependencies: Node's own HTTP server, plain HTML and JS, nothing to install.

## Run it

```sh
node src/main.ts            # Node 22.18+ (runs the TypeScript directly)
# open http://localhost:4310 and sign in as anyone from the demo company
```

With no directory configured it connects a made-up ten-person company, so it runs with no credentials. Open two
browser windows as two people to see messages, DMs and presence arrive live.

Tests: `node --test "test/*.test.ts"` (22 tests, no network, no database).

## Connecting a real directory

From the gear icon in the app (on the machine running it, or with `ADMIN_TOKEN` set and entered), pick a directory,
paste its credentials, and it reads every person before saving. Behind a proxy (Replit included) every request looks
local, so set `ADMIN_TOKEN` anywhere but your own machine. A connection that cannot read its directory is not
kept, and the error says why. Or set them in the environment and it comes up connected:

| Directory | Environment | What to create |
|---|---|---|
| HubSpot | `HUBSPOT_ACCESS_TOKEN` | A private app with `crm.objects.owners.read` |
| Salesforce | `SALESFORCE_INSTANCE_URL`, `SALESFORCE_ACCESS_TOKEN` | A connected app token with the `api` scope |
| Google Workspace | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_ADMIN_EMAIL`, optional `GOOGLE_DOMAIN` | A service account with domain-wide delegation for `admin.directory.user.readonly` |

Other settings: `PORT` (4310), `SYNC_MINUTES` (15; 0 turns re-sync off), `ADMIN_TOKEN`, `CRM_CHAT_DEMO=0` to skip the
demo company.

## Adding another CRM

One file implementing `DirectoryConnector` (`src/connectors/types.ts`) and one line in `src/connectors/index.ts`.
A connector only answers "who are the people, one page at a time": id, email, name, title, teams, active. Its
`fields` describe the connect form, so the UI needs no change. Pipedrive, Zoho, Dynamics, Okta or this CRM's own
users table are each a page of code.

## How identity works

- **The email is the join.** The same person in HubSpot and Google is one chat user with two sources.
- **A sync applies all or nothing.** Every page is read first; a failure on any page changes nobody.
- **Absent means deactivated, never deleted.** Someone gone from a directory keeps their messages. If they are still
  in another connected directory they stay active.
- **An empty answer is not believed.** A directory that had people and now returns none is reported, not applied;
  a scope change is far likelier than everyone leaving.
- **Credentials never go back to the browser.**

## What this proof of concept does not do yet

- **Real sign-in.** Sign-in trusts the email typed, which is fine on a laptop and not for anything shared. The next
  step is "Sign in with Google / HubSpot / Salesforce" via OAuth, matching the verified email the same way.
- **Persistence.** Everything is in memory and gone on restart. The shapes in `src/store.ts` map directly onto
  tables (people, person_sources, connections, channels, messages) in Postgres.
- **Credential storage.** Connected credentials live in process memory only; a real version encrypts them at rest.
- Threads, reactions, files, search, notifications and unread counts across devices.
