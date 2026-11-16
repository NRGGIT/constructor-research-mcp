#!/usr/bin/env node
// Save a personal access key for the MCP without it appearing in the chat, a command line or the
// shell history: the key is read from the terminal (hidden) or from stdin.
// Usage: npx -y -p constructor-research-mcp constructor-research-set-key <Constructor link>
import { configFromEnv, originOf } from "./config.js";
import { cleanKey } from "./api.js";
import { routeKey, saveKeyFile, type KeyCheck } from "./key.js";

/** What an address answered about the key, for messages. */
const said = (r?: KeyCheck) =>
  r === "rejected"
    ? "rejected this key"
    : r === "unreachable"
      ? "could not be reached (VPN?)"
      : "answered without the public API";

const USAGE =
  "Usage: npx -y -p constructor-research-mcp constructor-research-set-key <Constructor link, e.g. https://acme.constructor.app>\nThen paste the access key (rk-…) when asked, or pipe it in on stdin.";

/** One line from the terminal without echoing it, or all of stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk;
    return text;
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let text = "";
    const done = (value?: string) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      value === undefined ? reject(new Error("cancelled")) : resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(text);
        if (ch === "\u0003" || ch === "\u0004") return done();
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else if (ch >= " ") text += ch;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error(USAGE);
    return 2;
  }
  let url: string;
  try {
    url = originOf(args[0]);
  } catch (e: any) {
    console.error(e.message);
    return 2;
  }
  const config = configFromEnv({ ...process.env, CONSTRUCTOR_BASE_URL: url });
  let raw: string;
  try {
    raw = await readSecret(`Access key for ${url} (hidden): `);
  } catch {
    console.error("Cancelled; nothing saved.");
    return 1;
  }
  const key = cleanKey(raw);
  if (!key) {
    console.error("That is not an access key; nothing saved.");
    return 1;
  }
  // Check the key with Constructor before saving it; inside a desk, with its server too.
  const server = config.localDesk?.server;
  const route = await routeKey(url, server, config.apiPath, key, {
    checkHome: true,
  });
  if (route.result !== "ok") {
    const also = route.server
      ? `; this desk's server ${server} ${said(route.server)}`
      : "";
    console.error(`${url} ${said(route.home)}${also}; nothing saved.`);
    return 1;
  }
  await saveKeyFile(config.keyFile, url, key);
  console.log(
    `Key for ${url} saved to ${config.keyFile}. The MCP uses it from the next call; no restart needed.`,
  );
  if (route.origin !== url)
    console.log(
      `This desk's server ${route.origin} accepts it${route.home === "ok" ? " too" : ` (${url} ${said(route.home)})`}: requests from this desk go there.`,
    );
  return 0;
}
main().then(
  (code) => (process.exitCode = code),
  () => {
    console.error("Saving the key failed.");
    process.exitCode = 1;
  },
);
