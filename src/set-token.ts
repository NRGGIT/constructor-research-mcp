#!/usr/bin/env node
// Save the session from a copied cURL (or a bare token) for the MCP without printing it.
// Usage: npx -y -p constructor-research-mcp constructor-research-set-token <file with a copied cURL, or a token> --for claude-code|codex|opencode
//        (or --to <session file>); the session belongs to the Constructor the cURL was sent to.
import { readFileSync } from "node:fs";
import { configFromEnv, HARNESSES, originOf, sessionArgs } from "./config.js";
import { claims, saveSession, sessionCookies } from "./session.js";

const { file: target, rest } = sessionArgs(
  process.argv.slice(2),
  configFromEnv(),
);
const source = rest[0];
if (!source || !target) {
  console.error(
    `Usage: npx -y -p constructor-research-mcp constructor-research-set-token <file with a copied cURL> --for ${HARNESSES.join("|")}   (or --to <session file>)`,
  );
  process.exit(2);
}
const text = readFileSync(source, "utf8");
const found = sessionCookies(text);
const token = found.get("ap_access_token");
if (!token) {
  console.error("No ap_access_token found in " + source + ".");
  process.exit(1);
}
const { exp, max_slt } = claims(token) ?? {};
if (exp && exp * 1000 <= Date.now() && !found.has("ap_refresh_token")) {
  console.error(
    "That token already expired at " +
      new Date(exp * 1000).toISOString() +
      "; copy a fresh one.",
  );
  process.exit(1);
}
// The Constructor the cURL was sent to; a bare token names its own issuer.
const sent = /\bcurl\s+(?:-\S+\s+)*['"]?(https?:\/\/[^\s'"]+)/.exec(text)?.[1];
let host: string | undefined;
try {
  host = sent ? originOf(sent) : undefined;
} catch {}
await saveSession(target, found, host);
const time = (s: number) =>
  new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
console.log(
  "Saved to " +
    target +
    (host ? ` (for ${host})` : "") +
    (found.has("ap_refresh_token")
      ? `, with the refresh token: the MCP renews the session itself${max_slt ? " until " + time(max_slt) : ""}. The browser this cURL came from holds the same session, and a refresh token works once: whichever renews first logs the other out. The sign_in tool (or constructor-research-login) gives the MCP a session of its own.`
      : exp
        ? "; expires " +
          time(exp) +
          " (in " +
          Math.round((exp * 1000 - Date.now()) / 60000) +
          " min). Copy the cURL with the ap_refresh_token cookie, or use the sign_in tool, and the MCP renews it itself."
        : "."),
);
