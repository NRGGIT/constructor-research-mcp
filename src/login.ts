#!/usr/bin/env node
// Sign in from a terminal; the MCP's sign_in tool does the same from an agent session.
// Usage: npx -y -p constructor-research-mcp constructor-research-login [--url <any link to your Constructor>] --for claude-code|codex|opencode   (or --to <session file>)
import { configFromEnv, HARNESSES, originOf, sessionArgs } from "./config.js";
import { signIn } from "./signin.js";

const config = configFromEnv();
const args = process.argv.slice(2);
const at = args.indexOf("--url");
const url = at >= 0 ? args.splice(at, 2)[1] : undefined;
const { file } = sessionArgs(args, config);
if (!file || (at >= 0 && !url)) {
  console.error(
    `Usage: npx -y -p constructor-research-mcp constructor-research-login [--url <any link to your Constructor>] --for ${HARNESSES.join("|")}   (or --to <session file>)`,
  );
  process.exit(2);
}
if (url) {
  const host = originOf(url);
  if (config.baseUrlFixed && host !== config.baseUrl) {
    console.error(`CONSTRUCTOR_BASE_URL fixes the MCP to ${config.baseUrl}.`);
    process.exit(2);
  }
  config.baseUrl = host;
}
const result = await signIn(config, file, () =>
  console.log(
    `A Chrome window opened at ${config.baseUrl}. Sign in there; it closes by itself afterwards.`,
  ),
);
(result.status === "signed_in" ? console.log : console.error)(result.message);
process.exit(result.status === "signed_in" ? 0 : 1);
