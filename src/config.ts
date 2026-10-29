import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export interface Config {
  /** The Constructor the MCP works with: the signed-in one, unless CONSTRUCTOR_BASE_URL fixes it. */
  baseUrl: string;
  baseUrlFixed?: boolean;
  apiPath: string;
  storagePath?: string;
  /** Build-log service root; build logs stream only while a build runs. */
  keeperPath?: string;
  /** Session file; each harness gets its own unless CONSTRUCTOR_COOKIE_FILE fixes one. */
  cookieFile: string;
  cookieFileFixed?: boolean;
  stateDir: string;
  requestTimeoutMs: number;
  /** How long to wait for public URLs to answer after start; 0 disables the check. */
  readinessSeconds?: number;
  /** Pause between uploading to a disk and building from it; 0 disables. */
  uploadSettleSeconds?: number;
}
/** Where the MCP works until the user signs in somewhere else. */
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
  const apiPath = env.CONSTRUCTOR_API_PATH ?? "/api/platform-account";
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
    cookieFile: env.CONSTRUCTOR_COOKIE_FILE
      ? expand(env.CONSTRUCTOR_COOKIE_FILE)
      : sessionFile("default"),
    cookieFileFixed: !!env.CONSTRUCTOR_COOKIE_FILE,
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

/** Harnesses with their own session: one sign-in each, nothing shared between them. */
export const HARNESSES = ["claude-code", "codex", "opencode"] as const;
/** The harness behind an MCP client name (from the initialize handshake). */
export function harnessOf(client?: string) {
  const name = (client ?? "").toLowerCase();
  if (name.includes("claude")) return "claude-code";
  if (name.includes("codex")) return "codex";
  if (name.includes("opencode")) return "opencode";
  return name.replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "default";
}
/** Where a harness's Constructor session is kept (mode 600). */
export function sessionFile(harness: string) {
  return join(
    homedir(),
    ".config",
    "constructor-research",
    "sessions",
    `${harness}.txt`,
  );
}

/**
 * Session file named on a command line: --for <harness> or --to <file>; without either,
 * CONSTRUCTOR_COOKIE_FILE. Returns the remaining arguments too.
 */
export function sessionArgs(args: string[], config: Config) {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const to = value("--to"),
    harness = value("--for");
  const rest = args.filter(
    (_, n) =>
      !["--to", "--for"].includes(args[n]) &&
      !["--to", "--for"].includes(args[n - 1]),
  );
  if (to) return { file: resolve(to), rest };
  if (harness && (HARNESSES as readonly string[]).includes(harness))
    return { file: sessionFile(harness), rest };
  if (!harness && config.cookieFileFixed)
    return { file: config.cookieFile, rest };
  return { file: undefined, rest };
}

const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell command that waits for deployments, carrying the settings that differ from the defaults. */
export function waitCommand(config: Config, ids: string[]) {
  const defaults = configFromEnv({});
  const env = [
    // The wait command reads the host from the session, as the MCP does, unless it is fixed.
    [
      "CONSTRUCTOR_BASE_URL",
      config.baseUrlFixed ? config.baseUrl : undefined,
      undefined,
    ],
    ["CONSTRUCTOR_API_PATH", config.apiPath, defaults.apiPath],
    ["CONSTRUCTOR_STORAGE_PATH", config.storagePath, defaults.storagePath],
    ["CONSTRUCTOR_KEEPER_PATH", config.keeperPath, defaults.keeperPath],
    ["CONSTRUCTOR_COOKIE_FILE", config.cookieFile, defaults.cookieFile],
    ["CONSTRUCTOR_STATE_DIR", config.stateDir, defaults.stateDir],
  ]
    .filter(([, value, standard]) => value !== standard)
    .map(([name, value]) => `${name}=${quote(value!)} `)
    .join("");
  return `${env}${waitProgram()} ${ids.join(" ")}`;
}

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
