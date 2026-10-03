import type { FetchLike } from "../connectors/types.ts";

// Signing in is the company's job, not ours. Each provider hands back who the person is and which company
// they belong to; nothing about them is stored here.

export interface Identity {
  /** The provider that vouched for this person. */
  provider: string;
  /** The company as the provider names it: Google's workspace domain, Microsoft's tenant, a Salesforce org. */
  companyId: string;
  /** What to show for the company. */
  companyName: string;
  /** Lowercased. */
  email: string;
  name: string;
  avatarUrl?: string;
}

export interface SignInContext {
  fetch: FetchLike;
  now?: () => number;
}

/** "Log in with X": the password is typed on X's own page, and X sends the person back with a code. */
export interface RedirectProvider {
  kind: "redirect";
  id: string;
  label: string;
  authorizeUrl(p: { state: string; nonce: string; challenge: string; redirectUri: string }): string;
  finish(p: { code: string; verifier: string; nonce: string; redirectUri: string }, ctx: SignInContext): Promise<Identity>;
}

/** A system that offers no "Log in with" yet: its password is passed straight to it, used once and dropped. */
export interface PasswordProvider {
  kind: "password";
  id: string;
  label: string;
  verify(email: string, password: string, ctx: SignInContext): Promise<Identity>;
}

export type SignInProvider = RedirectProvider | PasswordProvider;

/** A refusal the person should read: wrong password, a personal account, a company that is not allowed. */
export class SignInError extends Error {}
