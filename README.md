# CRM Chat (proof of concept)

Team chat where nobody signs up and nothing about people is kept. Everyone logs in with the account their company
already gives them (Google, Microsoft, Salesforce, HubSpot or Werdna), and that company's own system checks the
password and says who they are. Each company gets its own chat, walled off from every other.

A standalone web app with no dependencies: Node's own HTTP server, plain HTML and JS, nothing to install.

## Run it

```sh
node src/main.ts            # Node 22.18+ (runs the TypeScript directly)
# open http://localhost:4310 and sign in as anyone from the demo company
```

With no provider set up, only the made-up ten-person demo company is offered, so it runs with no credentials. Open
two browser windows as two people to see messages, DMs and presence arrive live.

Tests: `node --test "test/*.test.ts"` (34 tests, no network, no database).

## Switching on "Log in with"

Each provider needs this app registered with it once, which gives a client id and secret. Set them in the
environment; a provider without its settings is simply not offered. Register the way back as
`<PUBLIC_URL>/auth/<provider>/callback`, for example `https://chat.example.com/auth/google/callback`.

| Log in with | Environment | Where to register |
|---|---|---|
| Google (Workspace) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console: an OAuth client of type "Web application" |
| Microsoft (Entra ID, Microsoft 365, Dynamics) | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra admin center: an app registration for accounts in any organizational directory |
| Salesforce | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, optional `SALESFORCE_LOGIN_URL` | Salesforce Setup: an external client app with the `openid`, `email` and `profile` scopes |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot developer account: a public app with the `oauth` scope |
| Werdna | `WERDNA_URL` | Nothing: see below |

Other settings:
- `PUBLIC_URL`: where people reach the app (default `http://localhost:<PORT>`).
- `SESSION_SECRET`: signs the login cookie. Set it anywhere but a laptop, or a restart signs everyone out.
- `PORT`: default 4310.
- `CRM_CHAT_DEMO=0`: hide the demo company.

Werdna has no "Log in with" for other apps yet; its OAuth server serves only its Claude connector. So Werdna users
type their Werdna email and password on the chat's page, the chat passes them straight to Werdna's own login, and
signs out of Werdna at once. Nothing is kept, but the password does pass through the chat's server; once Werdna
offers "Log in with Werdna", it moves to the same button as the others.

## Adding another CRM

One file implementing `RedirectProvider` (`src/signin/types.ts`) and one line in `src/signin/index.ts`. A provider
builds its sign-in link and, given the code its page sends back, answers "who is this and which company". Any
system that speaks OpenID Connect (Okta, Zoho, Auth0, Keycloak) follows `google.ts` with different addresses;
plain OAuth ones follow `hubspot.ts`.

## How sign-in works

- **The password is typed on the company's own page.** The chat gets back a one-time code, trades it for who the
  person is, and drops the provider's tokens.
- **The company is what the provider vouches for:** Google's workspace domain, Microsoft's tenant, the Salesforce
  org, the HubSpot account, the Werdna site. Personal Gmail and Microsoft accounts have no company and are turned
  away. A company reached through two providers is two chats: one provider never vouches for another's.
- **The session is a signed cookie, not a server table.** It carries who you are and your company and lasts a
  working day (12 hours). When it runs out you log in through your company again, and someone your company has
  removed cannot.
- **Login CSRF is blocked.** Each "Log in with" starts with a one-time state, nonce and PKCE secret in a short-lived
  cookie; a way back this browser did not start is refused.
- **People are listed once they have logged in.** The chat keeps no copy of a company's staff list.

## What this proof of concept does not do yet

- **Saving messages.** Messages live in memory and are gone on restart. The decided next step is a database with
  messages encrypted under a key per company.
- **Teams as channels for real companies.** The demo company still has them. For others it needs a company admin to
  approve read-only access to their directory once, rather than the chat holding an admin password.
- **A live check while someone is signed in.** Removal takes effect when the 12-hour session ends.
- Threads, reactions, files, search, notifications and unread counts across devices.
