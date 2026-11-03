import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export interface Config {
  /** The Constructor the MCP works with: CONSTRUCTOR_BASE_URL, else the one the saved key belongs to. */
  baseUrl: string;
  baseUrlFixed?: boolean;
  apiPath: string;
  storagePath?: string;
  /** Build-log service root; build logs stream only while a build runs. */
  keeperPath?: string;
  /** Personal access key (rk-…) from CONSTRUCTOR_ACCESS_KEY; without it the key file is read. */
  accessKey?: string;
  /** Saved key and the Constructor it belongs to (JSON, mode 600); CONSTRUCTOR_KEY_FILE moves it. */
  keyFile: string;
  stateDir: string;
  requestTimeoutMs: number;
  /** How long to wait for public URLs to answer after start; 0 disables the check. */
  readinessSeconds?: number;
  /** Pause between uploading to a disk and building from it; 0 disables. */
  uploadSettleSeconds?: number;
}
/** Where the MCP works unless CONSTRUCTOR_BASE_URL or the saved key names another Constructor. */
export const DEFAULT_BASE_URL = "https://constructor.app";
/** The origin of a Constructor link; HTTPS except on localhost. */
export function originOf(link: string) {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error(`${link} is not a valid link.`);
  }
  if (url.username || url.password)
    throw new Error("The link must not carry credentials.");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("HTTPS is required except on localhost.");
  return url.origin;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const fixed = env.CONSTRUCTOR_BASE_URL;
  if (fixed) {
    const url = new URL(fixed);
    if (url.search || url.hash || url.pathname !== "/")
      throw new Error(
        "CONSTRUCTOR_BASE_URL must be an origin without a path or credentials.",
      );
  }
  const baseUrl = originOf(fixed ?? DEFAULT_BASE_URL);
  const apiPath = env.CONSTRUCTOR_API_PATH ?? "/api/platform-account/v1";
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(apiPath) || apiPath.includes("//"))
    throw new Error("Invalid CONSTRUCTOR_API_PATH.");
  const storagePath = env.CONSTRUCTOR_STORAGE_PATH ?? "/api/platform-storage";
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(storagePath) || storagePath.includes("//"))
    throw new Error("Invalid CONSTRUCTOR_STORAGE_PATH.");
  const keeperPath = env.CONSTRUCTOR_KEEPER_PATH ?? "/api/platform-keeper";
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(keeperPath) || keeperPath.includes("//"))
    throw new Error("Invalid CONSTRUCTOR_KEEPER_PATH.");
  const expand = (s: string) =>
    resolve(s.startsWith("~/") ? homedir() + s.slice(1) : s);
  return {
    baseUrl,
    baseUrlFixed: !!fixed,
    apiPath: apiPath.replace(/\/$/, ""),
    storagePath: storagePath.replace(/\/$/, ""),
    keeperPath: keeperPath.replace(/\/$/, ""),
    accessKey: env.CONSTRUCTOR_ACCESS_KEY?.trim() || undefined,
    keyFile: expand(env.CONSTRUCTOR_KEY_FILE ?? DEFAULT_KEY_FILE),
    stateDir: expand(
      env.CONSTRUCTOR_STATE_DIR ?? "~/.local/state/constructor-research-mcp",
    ),
    requestTimeoutMs: 15000,
    uploadSettleSeconds: Math.max(
      0,
      Math.min(300, Number(env.CONSTRUCTOR_UPLOAD_SETTLE_SECONDS ?? 30) || 0),
    ),
    readinessSeconds: Math.max(
      0,
      Math.min(300, Number(env.CONSTRUCTOR_READINESS_SECONDS ?? 60) || 0),
    ),
  };
}

/** Where constructor-research-set-key saves the key; the MCP and the wait command read it. */
export const DEFAULT_KEY_FILE =
  "~/.config/constructor-research/access-key.json";

const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell command that waits for deployments, carrying the settings that differ from the defaults. */
export function waitCommand(config: Config, ids: string[]) {
  const defaults = configFromEnv({});
  const env = [
    // The wait command reads the host from the key file, as the MCP does, unless it is fixed.
    // The key itself never goes into a command line: CONSTRUCTOR_ACCESS_KEY stays in the environment.
    [
      "CONSTRUCTOR_BASE_URL",
      config.baseUrlFixed ? config.baseUrl : undefined,
      undefined,
    ],
    ["CONSTRUCTOR_API_PATH", config.apiPath, defaults.apiPath],
    ["CONSTRUCTOR_STORAGE_PATH", config.storagePath, defaults.storagePath],
    ["CONSTRUCTOR_KEEPER_PATH", config.keeperPath, defaults.keeperPath],
    ["CONSTRUCTOR_KEY_FILE", config.keyFile, defaults.keyFile],
    ["CONSTRUCTOR_STATE_DIR", config.stateDir, defaults.stateDir],
  ]
    .filter(([, value, standard]) => value !== standard)
    .map(([name, value]) => `${name}=${quote(value!)} `)
    .join("");
  return `${env}${waitProgram()} ${ids.join(" ")}`;
}

/** This package's version, as published; the server reports it on connect. */
export const VERSION: string = JSON.parse(
  readFileSync(
    join(fileURLToPath(import.meta.url), "..", "..", "package.json"),
    "utf8",
  ),
).version;

/**
 * How to run the wait CLI of this very version. Run through npx, the MCP lives in npx's
 * cache, whose folder npm may replace at any time, so the hint names the package instead.
 */
export function waitProgram(script = fileURLToPath(import.meta.url)) {
  const wait = join(script, "..", "wait.js");
  if (!script.includes(`${sep}_npx${sep}`)) return `node ${quote(wait)}`;
  const { name, version } = JSON.parse(
    readFileSync(join(script, "..", "..", "package.json"), "utf8"),
  );
  return `npx -y -p ${name}@${version} constructor-research-wait`;
}
