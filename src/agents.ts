// Coding agents the setup command knows: how each is detected, where its MCP settings live, and
// how the constructor-research entry is written. The entry never carries the access key: the MCP
// reads the key and its Constructor from the key file.
//
// Locations checked against each agent's docs or source (Nov 2026): Claude Code, Codex, OpenCode
// 1.x/2.x, jcode 0.99 (crates/jcode-base/src/mcp/protocol.rs), Cline 4.x / CLI 3.x
// (sdk/packages/shared/src/storage/paths.ts), Cursor, Gemini CLI.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";

export const SERVER = "constructor-research";
export const PACKAGE_SPEC = "constructor-research-mcp@latest";

export type Scope = "project" | "global";
export type Kind =
  "claude" | "codex" | "opencode" | "cline" | "jcode" | "mcpServers";
export interface Spec {
  command: string;
  args: string[];
}
type Env = NodeJS.ProcessEnv;

/** The command every agent runs. On Windows npx is a .cmd script, which agents start through cmd. */
export function mcpCommand(platform = process.platform): Spec {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_SPEC] }
    : { command: "npx", args: ["-y", PACKAGE_SPEC] };
}

export interface Agent {
  id: string;
  label: string;
  hint?: string;
  kind: Kind;
  /** The agent has no project-level MCP settings. */
  globalOnly?: boolean;
  /** Folders whose presence means the agent is installed (`also`: older locations). */
  dirs(home: string, cwd: string, env: Env): Dirs;
  file(scope: Scope, home: string, cwd: string, env: Env): string;
}
interface Dirs {
  global?: string;
  project?: string;
  also?: string[];
}

const set = (v: string | undefined) => v?.trim() || undefined;
const claudeDir = (home: string, env: Env) =>
  set(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
const codexDir = (home: string, env: Env) =>
  set(env.CODEX_HOME) ?? join(home, ".codex");
const opencodeDir = (home: string, env: Env) =>
  set(env.OPENCODE_CONFIG_DIR) ??
  join(set(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "opencode");
const jcodeDir = (home: string, env: Env) =>
  set(env.JCODE_HOME) ?? join(home, ".jcode");
// Cline 4.x (VS Code), JetBrains and the Cline CLI share one file under ~/.cline.
const clineDir = (home: string, env: Env) =>
  set(env.CLINE_DIR) ?? join(home, ".cline");
const clineFile = (home: string, env: Env) =>
  set(env.CLINE_MCP_SETTINGS_PATH) ??
  join(
    set(env.CLINE_DATA_DIR) ?? join(clineDir(home, env), "data"),
    "settings",
    "cline_mcp_settings.json",
  );
// Before 4.x Cline kept its settings in VS Code's extension storage; 4.x moves them to ~/.cline.
const clineLegacyDir = (home: string, env: Env) => {
  const storage = join(
    "Code",
    "User",
    "globalStorage",
    "saoudrizwan.claude-dev",
  );
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", storage);
  if (process.platform === "win32")
    return join(set(env.APPDATA) ?? join(home, "AppData", "Roaming"), storage);
  return join(home, ".config", storage);
};

export const AGENTS: Agent[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude",
    dirs: (home, cwd, env) => ({
      global: claudeDir(home, env),
      project: join(cwd, ".claude"),
    }),
    // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that folder.
    file: (scope, home, cwd, env) =>
      scope === "project"
        ? join(cwd, ".mcp.json")
        : set(env.CLAUDE_CONFIG_DIR)
          ? join(env.CLAUDE_CONFIG_DIR!.trim(), ".claude.json")
          : join(home, ".claude.json"),
  },
  {
    id: "codex",
    label: "Codex",
    kind: "codex",
    dirs: (home, cwd, env) => ({
      global: codexDir(home, env),
      project: join(cwd, ".codex"),
    }),
    file: (scope, home, cwd, env) =>
      scope === "project"
        ? join(cwd, ".codex", "config.toml")
        : join(codexDir(home, env), "config.toml"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "opencode",
    dirs: (home, cwd, env) => ({
      global: opencodeDir(home, env),
      project: join(cwd, ".opencode"),
    }),
    file: (scope, home, cwd, env) =>
      scope === "project"
        ? join(cwd, "opencode.json")
        : join(opencodeDir(home, env), "opencode.json"),
  },
  {
    id: "jcode",
    label: "jcode",
    kind: "jcode",
    dirs: (home, cwd, env) => ({
      global: jcodeDir(home, env),
      project: join(cwd, ".jcode"),
    }),
    file: (scope, home, cwd, env) =>
      scope === "project"
        ? join(cwd, ".jcode", "mcp.json")
        : join(jcodeDir(home, env), "mcp.json"),
  },
  {
    id: "cline",
    label: "Cline",
    hint: "VS Code, JetBrains, CLI",
    kind: "cline",
    globalOnly: true,
    dirs: (home, _cwd, env) => ({
      global: clineDir(home, env),
      also: [clineLegacyDir(home, env)],
    }),
    file: (_scope, home, _cwd, env) => clineFile(home, env),
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "mcpServers",
    dirs: (home, cwd) => ({
      global: join(home, ".cursor"),
      project: join(cwd, ".cursor"),
    }),
    file: (scope, home, cwd) =>
      join(scope === "project" ? cwd : home, ".cursor", "mcp.json"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    kind: "mcpServers",
    dirs: (home, cwd) => ({
      global: join(home, ".gemini"),
      project: join(cwd, ".gemini"),
    }),
    file: (scope, home, cwd) =>
      join(scope === "project" ? cwd : home, ".gemini", "settings.json"),
  },
];

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export interface Detection {
  agent: Agent;
  scope: Scope;
  path: string;
}

/** Every agent settings folder under the project or the home folder, project first. */
export function detect(
  home = homedir(),
  cwd = process.cwd(),
  env = process.env,
) {
  const found: Detection[] = [];
  for (const agent of AGENTS) {
    const d = agent.dirs(home, cwd, env);
    if (d.project && d.project !== d.global && isDir(d.project))
      found.push({ agent, scope: "project", path: d.project });
    const g = [d.global, ...(d.also ?? [])].find((p) => p && isDir(p));
    if (g) found.push({ agent, scope: "global", path: g });
  }
  return found;
}

export type Status = "added" | "updated" | "already" | "skipped" | "failed";
export interface Result {
  status: Status;
  note?: string;
}
export const succeeded = (r: Result) =>
  r.status === "added" || r.status === "updated" || r.status === "already";

/** The entry as each agent expects it. */
export function entryFor(kind: Kind, spec: Spec, opencodeV2 = false): object {
  const { command, args } = spec;
  switch (kind) {
    case "claude":
      return { type: "stdio", command, args, env: {} };
    case "opencode":
      return opencodeV2
        ? { type: "local", command: [command, ...args] }
        : { type: "local", command: [command, ...args], enabled: true };
    case "cline":
      return { type: "stdio", command, args, disabled: false };
    default:
      return { command, args };
  }
}

const tomlString = (s: string) => JSON.stringify(s);
/** Codex: the first npx start downloads the package and can exceed Codex's 10 s start limit. */
export const tomlBlock = ({ command, args }: Spec) =>
  `[mcp_servers.${SERVER}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(", ")}]\nstartup_timeout_sec = 60\n`;

/** What will be written, for --verbose. */
export function describe(kind: Kind, spec: Spec, opencodeV2 = false) {
  if (kind === "codex") return tomlBlock(spec).trimEnd().split("\n");
  const entry = { [SERVER]: entryFor(kind, spec, opencodeV2) };
  const body =
    kind === "opencode"
      ? { mcp: opencodeV2 ? { servers: entry } : entry }
      : { mcpServers: entry };
  return JSON.stringify(body, null, 2).split("\n");
}

/** A symlinked settings file (dotfiles) is written through, not replaced by a plain file. */
function target(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** Access keys as they appear in settings; a backup never keeps one. */
const KEY_PATTERN = /rk-[A-Za-z0-9_\-.~+/=]{8,}/g;

/**
 * The file as it was before this setup first changed it, kept once (later runs keep the
 * original), readable only by the user, with any access key in it replaced: older setups put
 * the key into the agent's settings, and a backup in a project folder could end up in git.
 */
function backupOnce(file: string) {
  if (!existsSync(file)) return undefined;
  const backup = `${file}.constructor-backup`;
  if (!existsSync(backup))
    writeFileSync(
      backup,
      readFileSync(file, "utf8").replace(KEY_PATTERN, "rk-REMOVED"),
      { mode: 0o600, flag: "wx" },
    );
  return basename(backup);
}

/** Replace the file in one step, keeping its permissions; new files: 600 global, 644 project. */
function writeAtomic(file: string, text: string, scope: Scope) {
  mkdirSync(dirname(file), { recursive: true });
  let mode = scope === "global" ? 0o600 : 0o644;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {}
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode, flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge the entry into a JSON settings file; files that are not plain JSON are left untouched. */
export function mergeJson(
  path: string,
  kind: Kind,
  spec: Spec,
  scope: Scope,
  opencodeMajor?: number,
): Result {
  const file = target(path);
  let data: Record<string, any> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      const text = readFileSync(file, "utf8");
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      return {
        status: "skipped",
        note: `${file} is not plain JSON (comments?); left untouched`,
      };
    }
    if (!isObject(parsed))
      return {
        status: "skipped",
        note: `${file} is not a JSON object; left untouched`,
      };
    data = parsed;
  }
  let holder: Record<string, any>;
  let v2 = false;
  if (kind === "opencode") {
    if (data.mcp !== undefined && !isObject(data.mcp))
      return {
        status: "skipped",
        note: `"mcp" in ${file} is not an object; left untouched`,
      };
    data.mcp ??= {};
    // OpenCode 2.x keeps servers one level deeper, under mcp.servers. A 1.x server that
    // happens to be called "servers" has a type or command of its own.
    const nested = data.mcp.servers;
    v2 =
      (isObject(nested) && !("type" in nested) && !("command" in nested)) ||
      (opencodeMajor ?? 1) >= 2;
    if (v2) data.mcp.servers ??= {};
    holder = v2 ? data.mcp.servers : data.mcp;
    if (!isObject(holder))
      return {
        status: "skipped",
        note: `"mcp.servers" in ${file} is not an object; left untouched`,
      };
  } else {
    // jcode reads "mcpServers" or its older "servers", never both: keep whichever is there.
    const key =
      kind === "jcode" &&
      data.servers !== undefined &&
      data.mcpServers === undefined
        ? "servers"
        : "mcpServers";
    if (data[key] !== undefined && !isObject(data[key]))
      return {
        status: "skipped",
        note: `"${key}" in ${file} is not an object; left untouched`,
      };
    holder = data[key] ??= {};
  }
  const next = entryFor(kind, spec, v2);
  if (JSON.stringify(holder[SERVER]) === JSON.stringify(next))
    return { status: "already" };
  const had = SERVER in holder;
  holder[SERVER] = next;
  if (kind === "opencode") data.$schema ??= "https://opencode.ai/config.json";
  const backup = backupOnce(file);
  writeAtomic(file, JSON.stringify(data, null, 2) + "\n", scope);
  return {
    status: had ? "updated" : "added",
    note: backup ? `backup ${backup}` : undefined,
  };
}

// A TOML table header line: [a.b] or [[a.b]], keys bare or quoted, optionally a comment after.
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TOML_HEADER = new RegExp(
  String.raw`^\s*\[\[?\s*${KEY}(?:\s*\.\s*${KEY})*\s*\]\]?\s*(?:#.*)?$`,
);
const OUR_HEADER = new RegExp(
  String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${SERVER}|"${SERVER}"|'${SERVER}')\s*[\].]`,
);

/** Plain objects (the parser's have no prototype), so values compare by content alone. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

/** The parsed settings without our entry, to compare everything else before and after. */
function withoutOurs(data: Record<string, any>) {
  data = plain(data);
  if (isObject(data.mcp_servers)) {
    delete data.mcp_servers[SERVER];
    if (!Object.keys(data.mcp_servers).length) delete data.mcp_servers;
  }
  return data;
}

/**
 * Codex: replace our [mcp_servers.constructor-research] table and its sub-tables (such as an
 * older .env table carrying the key) with the new entry; every other line stays as it was. The
 * result is parsed and compared with the original: unless only our entry changed, nothing is
 * written.
 */
export function writeToml(path: string, spec: Spec, scope: Scope): Result {
  const file = target(path);
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const untouched = (why: string): Result => ({
    status: "skipped",
    note: `${file} ${why}; left untouched`,
  });
  try {
    parseToml(old);
  } catch {
    return untouched("is not valid TOML");
  }
  const kept: string[] = [];
  const ours: string[] = [];
  let inOurs = false;
  for (const line of old.split("\n")) {
    if (TOML_HEADER.test(line)) inOurs = OUR_HEADER.test(line);
    (inOurs ? ours : kept).push(line);
  }
  const block = tomlBlock(spec);
  if (ours.join("\n").trim() === block.trim()) return { status: "already" };
  const body = kept.join("\n").replace(/\s+$/, "");
  const text = (body ? body + "\n\n" : "") + block;
  let after: Record<string, any>;
  try {
    after = parseToml(text);
  } catch {
    return untouched("could not be edited safely");
  }
  const entry = after.mcp_servers?.[SERVER];
  if (
    !isDeepStrictEqual(plain(entry), { ...spec, startup_timeout_sec: 60 }) ||
    !isDeepStrictEqual(withoutOurs(parseToml(old)), withoutOurs(after))
  )
    return untouched(`sets ${SERVER} in a form this setup does not edit`);
  const backup = backupOnce(file);
  writeAtomic(file, text, scope);
  return {
    status: ours.length ? "updated" : "added",
    note: backup ? `backup ${backup}` : undefined,
  };
}

/** Runs another tool's CLI without a shell, bounded in time. */
function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Env; timeout?: number } = {},
) {
  return spawnSync(bin, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeout ?? 15000,
    windowsHide: true,
  });
}
const available = (bin: string, env?: Env) =>
  run(bin, ["--version"], { env, timeout: 10000 }).status === 0;
/**
 * Whether Claude Code's CLI can add the entry. Without it the setup edits ~/.claude.json
 * directly, which a running Claude Code may overwrite: the user should quit it first.
 */
export const claudeCliWorks = (env: Env = process.env) =>
  available("claude", env);

/** Claude Code's own CLI, so a running Claude Code does not overwrite the change. */
function viaClaude(
  scope: Scope,
  spec: Spec,
  cwd: string,
  env: Env,
): Result | undefined {
  const s = scope === "global" ? "user" : "project";
  const add = run(
    "claude",
    [
      "mcp",
      "add-json",
      "--scope",
      s,
      SERVER,
      JSON.stringify(entryFor("claude", spec)),
    ],
    { cwd, env },
  );
  if (add.status !== 0) {
    // Only when it is already there: replace it (an older entry may carry the key in env).
    if (!/already exists/i.test(`${add.stdout}${add.stderr}`)) return undefined;
    run("claude", ["mcp", "remove", SERVER, "--scope", s], { cwd, env });
    const again = run(
      "claude",
      [
        "mcp",
        "add-json",
        "--scope",
        s,
        SERVER,
        JSON.stringify(entryFor("claude", spec)),
      ],
      { cwd, env },
    );
    if (again.status !== 0) return undefined;
  }
  const get = run("claude", ["mcp", "get", SERVER], { cwd, env });
  return get.status === 0 && get.stdout.includes(SERVER)
    ? { status: "added", note: "via claude mcp add-json" }
    : undefined;
}

/** OpenCode's major version, when its CLI answers. */
function opencodeMajor(env: Env) {
  const r = run("opencode", ["--version"], { env, timeout: 10000 });
  const m = r.status === 0 ? /(\d+)\.\d+/.exec(r.stdout) : null;
  return m ? Number(m[1]) : undefined;
}

/** jcode imports Codex's MCP servers once, and only while ~/.jcode/mcp.json does not exist. */
function jcodeImportNote(file: string, scope: Scope, home: string) {
  if (scope !== "global" || existsSync(file)) return undefined;
  try {
    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const others = [
      ...codex.matchAll(/^\s*\[mcp_servers\.["']?([^\].'"]+)["']?\]/gm),
    ].filter((m) => m[1] !== SERVER);
    return others.length
      ? "new file, so jcode no longer imports your other Codex MCP servers by itself"
      : undefined;
  } catch {
    return undefined;
  }
}

const withNote = (r: Result, note?: string): Result =>
  note ? { ...r, note: [r.note, note].filter(Boolean).join("; ") } : r;

export interface ApplyOptions {
  cwd: string;
  home: string;
  /** The environment for the settings locations and the agents' own CLIs. */
  env: Env;
  /** Let the agents' CLIs write or check the entry where they can. */
  useClis?: boolean;
}

/** Writes the entry for one agent; never throws. */
export function applyEntry(
  agent: Agent,
  scope: Scope,
  spec: Spec,
  o: ApplyOptions,
): Result {
  const file = agent.file(scope, o.home, o.cwd, o.env);
  const clis = o.useClis !== false;
  try {
    switch (agent.kind) {
      case "claude": {
        if (clis && available("claude", o.env)) {
          const r = viaClaude(scope, spec, o.cwd, o.env);
          if (r) return r;
        }
        return mergeJson(file, "claude", spec, scope);
      }
      case "codex": {
        const r = writeToml(file, spec, scope);
        if (
          !succeeded(r) ||
          scope !== "global" ||
          !clis ||
          !available("codex", o.env)
        )
          return r;
        const get = run("codex", ["mcp", "get", SERVER], { env: o.env });
        return withNote(
          r,
          get.status === 0 && get.stdout.includes(SERVER)
            ? "codex mcp get sees it"
            : "written, but codex mcp get does not list it",
        );
      }
      case "opencode":
        return mergeJson(
          file,
          "opencode",
          spec,
          scope,
          clis ? opencodeMajor(o.env) : undefined,
        );
      case "jcode": {
        const note = jcodeImportNote(file, scope, o.home);
        const r = mergeJson(file, "jcode", spec, scope);
        if (!succeeded(r) || !clis || !available("jcode", o.env))
          return withNote(r, note);
        const test = run("jcode", ["mcp", "test", SERVER], {
          cwd: o.cwd,
          env: o.env,
          timeout: 30000,
        });
        return withNote(
          withNote(
            r,
            test.status === 0
              ? "jcode mcp test connected"
              : "written, but jcode mcp test failed",
          ),
          note,
        );
      }
      default:
        return mergeJson(file, agent.kind, spec, scope);
    }
  } catch (err: any) {
    return { status: "failed", note: String(err?.message ?? err) };
  }
}
