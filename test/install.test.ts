import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENTS,
  applyEntry,
  detect,
  mcpCommand,
  mergeJson,
  writeToml,
} from "../src/agents.js";

const spec = mcpCommand("darwin");
const temp = () => mkdtempSync(join(tmpdir(), "cr-install-test-"));
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const agent = (id: string) => AGENTS.find((a) => a.id === id)!;
const server = resolve(import.meta.dirname, "..", "dist", "server.js");

test("the entry runs the published package; on Windows through cmd", () => {
  assert.deepEqual(spec, {
    command: "npx",
    args: ["-y", "constructor-research-mcp@latest"],
  });
  assert.deepEqual(mcpCommand("win32").args.slice(0, 2), ["/c", "npx"]);
});

test("JSON: adds next to other servers, backs up once, replaces an older entry", () => {
  const dir = temp();
  const file = join(dir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      other: 1,
      mcpServers: {
        x: { command: "x" },
        "constructor-research": {
          command: "npx",
          env: { CONSTRUCTOR_ACCESS_KEY: "rk-old" },
        },
      },
    }),
    { mode: 0o640 },
  );
  const r = mergeJson(file, "mcpServers", spec, "global");
  assert.equal(r.status, "updated");
  const data = json(file);
  assert.equal(data.other, 1);
  assert.deepEqual(data.mcpServers.x, { command: "x" });
  assert.deepEqual(data.mcpServers["constructor-research"], spec);
  assert.ok(!readFileSync(file, "utf8").includes("rk-old"));
  assert.equal(statSync(file).mode & 0o777, 0o640, "keeps the file's mode");
  assert.ok(
    readFileSync(`${file}.constructor-backup`, "utf8").includes("rk-old"),
  );
  assert.equal(mergeJson(file, "mcpServers", spec, "global").status, "already");
  // The backup keeps the original, not the state after the first change.
  assert.ok(
    readFileSync(`${file}.constructor-backup`, "utf8").includes("rk-old"),
  );
});

test("JSON: new global files are readable only by the user", () => {
  const file = join(temp(), "a", "b.json");
  assert.equal(mergeJson(file, "mcpServers", spec, "global").status, "added");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${file}.constructor-backup`));
});

test("JSON: files with comments, or not an object, are left untouched", () => {
  const dir = temp();
  for (const text of ['{ // comment\n "a": 1 }', "[1]", '{"mcpServers": 3}']) {
    const file = join(dir, `f${text.length}.json`);
    writeFileSync(file, text);
    assert.equal(
      mergeJson(file, "mcpServers", spec, "global").status,
      "skipped",
    );
    assert.equal(readFileSync(file, "utf8"), text);
    assert.ok(!existsSync(`${file}.constructor-backup`));
  }
});

test("JSON: a symlinked settings file is written through the link", () => {
  const dir = temp();
  const real = join(dir, "dotfiles.json");
  const link = join(dir, "settings.json");
  writeFileSync(real, "{}");
  symlinkSync(real, link);
  assert.equal(mergeJson(link, "mcpServers", spec, "global").status, "added");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(json(real).mcpServers["constructor-research"]);
});

test("jcode keeps its older 'servers' key; Cline gets a stdio entry", () => {
  const dir = temp();
  const file = join(dir, "mcp.json");
  writeFileSync(file, JSON.stringify({ servers: { a: { command: "a" } } }));
  mergeJson(file, "jcode", spec, "global");
  const data = json(file);
  assert.equal(data.mcpServers, undefined);
  assert.deepEqual(Object.keys(data.servers), ["a", "constructor-research"]);
  const cline = join(dir, "cline.json");
  mergeJson(cline, "cline", spec, "global");
  assert.deepEqual(json(cline).mcpServers["constructor-research"], {
    type: "stdio",
    ...spec,
    disabled: false,
  });
});

test("OpenCode: 1.x layout, or 2.x under mcp.servers", () => {
  const dir = temp();
  const v1 = join(dir, "v1.json");
  mergeJson(v1, "opencode", spec, "global");
  assert.deepEqual(json(v1).mcp["constructor-research"], {
    type: "local",
    command: ["npx", "-y", "constructor-research-mcp@latest"],
    enabled: true,
  });
  assert.equal(json(v1).$schema, "https://opencode.ai/config.json");
  const v2 = join(dir, "v2.json");
  writeFileSync(v2, JSON.stringify({ mcp: { servers: {} } }));
  mergeJson(v2, "opencode", spec, "global");
  assert.ok(json(v2).mcp.servers["constructor-research"]);
  assert.equal(json(v2).mcp["constructor-research"], undefined);
  const told = join(dir, "told.json");
  mergeJson(told, "opencode", spec, "global", 2);
  assert.ok(json(told).mcp.servers["constructor-research"]);
});

const OLD_CODEX = `model = "gpt-5"

[mcp_servers.other]
command = "other"

[mcp_servers.constructor-research]
command = "npx"
args = ["-y", "constructor-research-mcp@latest"]

[mcp_servers.constructor-research.env]
CONSTRUCTOR_ACCESS_KEY = "rk-old"

[mcp_servers.constructor-research.tools.get_deployment]
approval_mode = "approve"

[profiles.fast]
model = "gpt-5-mini"
`;

test("Codex: replaces the old table and its sub-tables, keeps everything else", () => {
  const file = join(temp(), "config.toml");
  writeFileSync(file, OLD_CODEX);
  assert.equal(writeToml(file, spec, "global").status, "updated");
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("rk-old"));
  assert.ok(!text.includes("approval_mode"));
  assert.ok(
    text.startsWith(
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n',
    ),
  );
  assert.ok(text.includes('[profiles.fast]\nmodel = "gpt-5-mini"'));
  assert.ok(
    text.endsWith(
      '[mcp_servers.constructor-research]\ncommand = "npx"\nargs = ["-y", "constructor-research-mcp@latest"]\nstartup_timeout_sec = 60\n',
    ),
  );
  assert.equal(writeToml(file, spec, "global").status, "already");
  assert.equal(readFileSync(`${file}.constructor-backup`, "utf8"), OLD_CODEX);
});

test("Codex: adds to a file without a final newline; leaves other forms alone", () => {
  const dir = temp();
  const file = join(dir, "config.toml");
  writeFileSync(file, 'model = "x"');
  assert.equal(writeToml(file, spec, "global").status, "added");
  assert.ok(
    readFileSync(file, "utf8").startsWith(
      'model = "x"\n\n[mcp_servers.constructor-research]',
    ),
  );
  const quoted = join(dir, "quoted.toml");
  writeFileSync(
    quoted,
    '[mcp_servers."constructor-research"]\ncommand = "old"\n',
  );
  assert.equal(writeToml(quoted, spec, "global").status, "updated");
  assert.ok(!readFileSync(quoted, "utf8").includes("old"));
  const inline = join(dir, "inline.toml");
  const text = '[mcp_servers]\nconstructor-research = { command = "npx" }\n';
  writeFileSync(inline, text);
  assert.equal(writeToml(inline, spec, "global").status, "skipped");
  assert.equal(readFileSync(inline, "utf8"), text);
  const similar = join(dir, "similar.toml");
  writeFileSync(
    similar,
    '[mcp_servers.constructor-research-dev]\ncommand = "dev"\n',
  );
  assert.equal(writeToml(similar, spec, "global").status, "added");
  assert.ok(readFileSync(similar, "utf8").includes('command = "dev"'));
});

test("detect: project folders first, Cline's older VS Code folder counts", () => {
  const home = temp();
  const cwd = join(home, "proj");
  mkdirSync(join(cwd, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".codex"));
  const legacy =
    process.platform === "darwin"
      ? join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
        )
      : join(
          home,
          ".config",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
        );
  mkdirSync(legacy, { recursive: true });
  const found = detect(home, cwd, {}).map((d) => `${d.agent.id}:${d.scope}`);
  assert.deepEqual(found, ["codex:global", "cline:global", "cursor:project"]);
});

test("every agent's entry lands in its documented file", () => {
  const home = temp();
  const cwd = join(home, "proj");
  const env = {};
  const o = { cwd, home, env, useClis: false };
  for (const a of AGENTS)
    assert.ok(
      ["added"].includes(applyEntry(a, "global", spec, o).status),
      a.id,
    );
  assert.ok(
    json(join(home, ".claude.json")).mcpServers["constructor-research"],
  );
  assert.ok(
    readFileSync(join(home, ".codex", "config.toml"), "utf8").includes(
      "[mcp_servers.constructor-research]",
    ),
  );
  assert.ok(
    json(join(home, ".config", "opencode", "opencode.json")).mcp[
      "constructor-research"
    ],
  );
  assert.ok(
    json(join(home, ".jcode", "mcp.json")).mcpServers["constructor-research"],
  );
  assert.ok(
    json(join(home, ".cline", "data", "settings", "cline_mcp_settings.json"))
      .mcpServers["constructor-research"],
  );
  assert.ok(
    json(join(home, ".cursor", "mcp.json")).mcpServers["constructor-research"],
  );
  assert.ok(
    json(join(home, ".gemini", "settings.json")).mcpServers[
      "constructor-research"
    ],
  );
  applyEntry(agent("claude"), "project", spec, o);
  assert.ok(json(join(cwd, ".mcp.json")).mcpServers["constructor-research"]);
  assert.equal(statSync(join(cwd, ".mcp.json")).mode & 0o777, 0o644);
  // Overrides the agents honour.
  const claudeDir = join(home, "cc");
  const codexHome = join(home, "cx");
  assert.equal(
    agent("claude").file("global", home, cwd, { CLAUDE_CONFIG_DIR: claudeDir }),
    join(claudeDir, ".claude.json"),
  );
  assert.equal(
    agent("codex").file("global", home, cwd, { CODEX_HOME: codexHome }),
    join(codexHome, "config.toml"),
  );
  assert.equal(
    agent("cline").file("global", home, cwd, {
      CLINE_DATA_DIR: join(home, "d"),
    }),
    join(home, "d", "settings", "cline_mcp_settings.json"),
  );
});

function setup(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<{ code: number; out: string }>((done) => {
    const child = execFile(
      process.execPath,
      [server, "install", ...args],
      { env: { PATH: "/usr/bin:/bin", ...env }, timeout: 30000 },
      (err, stdout, stderr) =>
        done({ code: (err as any)?.code ?? 0, out: stdout + stderr }),
    );
    child.stdin!.end(input ?? "");
  });
}

test("install: -y writes the entries and saves the key read from stdin, never echoing it", async () => {
  const home = temp();
  mkdirSync(join(home, ".codex"));
  const keyFile = join(home, "key.json");
  // A local Constructor that accepts exactly this key.
  const { createServer } = await import("node:http");
  const key = "rk-test-0123456789abcdef";
  const http = createServer((req, res) => {
    res.statusCode =
      req.headers["x-research-accesskey"] === `Bearer ${key}` ? 200 : 401;
    res.end("{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as any).port;
  try {
    const run = await setup(
      [
        "-y",
        "--agents=codex,cline",
        "--scope=global",
        `--constructor=http://localhost:${port}`,
        "--key-stdin",
      ],
      { HOME: home, CONSTRUCTOR_KEY_FILE: keyFile },
      key + "\n",
    );
    assert.equal(run.code, 0, run.out);
    assert.ok(!run.out.includes(key));
    assert.deepEqual(json(keyFile), { url: `http://localhost:${port}`, key });
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(
      readFileSync(join(home, ".codex", "config.toml"), "utf8").includes(
        "constructor-research-mcp@latest",
      ),
    );
    assert.ok(
      json(join(home, ".cline", "data", "settings", "cline_mcp_settings.json"))
        .mcpServers["constructor-research"],
    );
    // A rejected key is not saved and the run reports it.
    const bad = await setup(
      [
        "-y",
        "--agents=codex",
        "--scope=global",
        `--constructor=http://localhost:${port}`,
        "--key-stdin",
      ],
      { HOME: home, CONSTRUCTOR_KEY_FILE: join(home, "other.json") },
      "rk-wrong-0123456789\n",
    );
    assert.equal(bad.code, 1, bad.out);
    assert.ok(!existsSync(join(home, "other.json")));
  } finally {
    http.close();
  }
});

test("install: refuses keys as arguments, unknown options and a missing terminal", async () => {
  const home = temp();
  assert.equal((await setup(["rk-abcdefgh12345"], { HOME: home })).code, 2);
  assert.equal(
    (await setup(["--key=rk-abcdefgh12345"], { HOME: home })).code,
    2,
  );
  assert.equal((await setup(["--key-stdin"], { HOME: home })).code, 2);
  assert.equal((await setup([], { HOME: home })).code, 2);
  const help = await setup(["--help"], { HOME: home });
  assert.equal(help.code, 0);
  assert.ok(help.out.includes("never accepted as an argument"));
});

test("backups never keep an access key and are readable only by the user", () => {
  const dir = temp();
  const file = join(dir, ".mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        "constructor-research": {
          command: "npx",
          env: { CONSTRUCTOR_ACCESS_KEY: "rk-oldsecret_0123456789" },
        },
      },
    }),
    { mode: 0o644 },
  );
  mergeJson(file, "claude", spec, "project");
  const backup = `${file}.constructor-backup`;
  assert.ok(!readFileSync(backup, "utf8").includes("oldsecret"));
  assert.ok(readFileSync(backup, "utf8").includes("rk-REMOVED"));
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const toml = join(dir, "config.toml");
  writeFileSync(toml, OLD_CODEX.replace("rk-old", "rk-codexsecret_0123456789"));
  writeToml(toml, spec, "project");
  const codexBackup = readFileSync(`${toml}.constructor-backup`, "utf8");
  assert.ok(!codexBackup.includes("codexsecret"));
  assert.ok(codexBackup.includes("rk-REMOVED"));
});

test("Codex: tables after ours survive, whatever their keys contain", () => {
  const file = join(temp(), "config.toml");
  const trust = '[projects."/Users/me/app [old]"]\ntrust_level = "trusted"\n';
  writeFileSync(
    file,
    `[mcp_servers.constructor-research]\ncommand = "old"\n\n${trust}`,
  );
  assert.equal(writeToml(file, spec, "global").status, "updated");
  assert.ok(readFileSync(file, "utf8").includes(trust));
  // An array of arrays inside our table: the edit would break the file, so nothing is written.
  const nested = join(temp(), "config.toml");
  const text =
    '[mcp_servers.constructor-research]\ncommand = "old"\nx = [\n  ["a", "b"]\n]\n\n[other]\na = 1\n';
  writeFileSync(nested, text);
  const r = writeToml(nested, spec, "global");
  assert.ok(r.status === "updated" || r.status === "skipped");
  if (r.status === "updated")
    assert.ok(readFileSync(nested, "utf8").includes("[other]\na = 1"));
  else assert.equal(readFileSync(nested, "utf8"), text);
  // Not valid TOML: untouched.
  const broken = join(temp(), "config.toml");
  writeFileSync(broken, "model = \n");
  assert.equal(writeToml(broken, spec, "global").status, "skipped");
});

test("OpenCode 1.x: a server named 'servers' is not mistaken for the 2.x layout", () => {
  const file = join(temp(), "opencode.json");
  writeFileSync(
    file,
    JSON.stringify({ mcp: { servers: { type: "local", command: ["s"] } } }),
  );
  mergeJson(file, "opencode", spec, "global");
  const data = json(file);
  assert.deepEqual(data.mcp.servers, { type: "local", command: ["s"] });
  assert.ok(data.mcp["constructor-research"]);
});

test("install --demo stays inside its own folder, whatever the environment points at", async () => {
  const real = temp();
  const env = {
    HOME: real,
    OPENCODE_CONFIG_DIR: join(real, "oc"),
    CLINE_DIR: join(real, "cline"),
    CLINE_MCP_SETTINGS_PATH: join(real, "cline.json"),
    JCODE_HOME: join(real, "jc"),
    CODEX_HOME: join(real, "cx"),
    CLAUDE_CONFIG_DIR: join(real, "cc"),
    CONSTRUCTOR_KEY_FILE: join(real, "key.json"),
    CONSTRUCTOR_ACCESS_KEY: "rk-demo-0123456789abcdef",
  };
  const run = await setup(
    [
      "--demo",
      "-y",
      "--agents=claude,codex,opencode,jcode,cline,cursor,gemini",
      "--scope=global",
    ],
    env,
  );
  assert.equal(run.code, 0, run.out);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(
    readdirSync(real),
    [],
    "nothing written outside the demo folder",
  );
});
