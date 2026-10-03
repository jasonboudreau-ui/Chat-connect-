import { demo } from "./demo.ts";
import { google } from "./google.ts";
import { hubspot } from "./hubspot.ts";
import { salesforce } from "./salesforce.ts";
import type { DirectoryConnector } from "./types.ts";

// Adding a directory is one file implementing DirectoryConnector plus one line here.
export const connectors: DirectoryConnector[] = [hubspot, salesforce, google, demo];

export function findConnector(id: string): DirectoryConnector | undefined {
  return connectors.find((c) => c.id === id);
}
