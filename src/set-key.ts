#!/usr/bin/env node
// Save a personal access key for the MCP without it appearing in the chat, a command line or the
// shell history: the key is read from the terminal (hidden) or from stdin.
// Usage: npx -y -p constructor-research-mcp constructor-research-set-key <Constructor link>
import { configFromEnv, originOf } from "./config.js";
import { cleanKey } from "./api.js";
import { checkKey, saveKeyFile } from "./key.js";

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
  // Check the key with Constructor before saving it.
  const { result, status } = await checkKey(url, config.apiPath, key);
  if (result === "unreachable") {
    console.error(`Could not reach ${url} (VPN?); nothing saved.`);
    return 1;
  }
  if (result === "rejected") {
    console.error(`${url} rejected this key; nothing saved.`);
    return 1;
  }
  if (result !== "ok") {
    console.error(
      `${url} answered HTTP ${status}: it may not have the public API yet; nothing saved.`,
    );
    return 1;
  }
  await saveKeyFile(config.keyFile, url, key);
  console.log(
    `Key for ${url} saved to ${config.keyFile}. The MCP uses it from the next call; no restart needed.`,
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
