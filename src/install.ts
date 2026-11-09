// `constructor-research-mcp install`: find the coding agents on this machine, let the user pick
// them and project or global, get and check the access key, save it to the key file, and add the
// MCP to each agent. The key is never an argument and never part of an agent's settings.
import * as p from "@clack/prompts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { styleText } from "node:util";
import {
  AGENTS,
  PACKAGE_SPEC,
  SERVER,
  applyEntry,
  claudeCliWorks,
  describe,
  detect,
  mcpCommand,
  succeeded,
  type Agent,
  type Result,
  type Scope,
} from "./agents.js";
import { cleanKey } from "./api.js";
import { DEFAULT_BASE_URL, configFromEnv, originOf } from "./config.js";
import { checkKey, readKeyFile, saveKeyFile, type SavedKey } from "./key.js";

const bold = (s: string) => styleText("bold", s);
const dim = (s: string) => styleText("dim", s);
const accent = (s: string) => styleText("cyan", s);

const USAGE = `Constructor Research MCP setup

  npx -y ${PACKAGE_SPEC} install [options]

    -y, --yes               no questions: detected agents, the level they were found at
    --agents=a,b            ${AGENTS.map((a) => a.id).join(", ")}
    --scope=project|global  where the MCP entry goes
    --constructor=<link>    the Constructor you use (default ${DEFAULT_BASE_URL})
    --key-stdin             with -y: read the access key from stdin (or set CONSTRUCTOR_ACCESS_KEY)
    --dry-run               change nothing
    --verbose               show each agent's file and the exact entry
    --demo                  try it in a throw-away home folder with fake agents (no key check)

The access key is never accepted as an argument.`;

/** The access key as a short hint: rk-…abcd. */
export const mask = (key: string) => `${key.slice(0, 3)}…${key.slice(-4)}`;
/** Access keys start with rk-; printable ASCII only (cleanKey). */
const accessKey = (raw: string | undefined) => {
  const key = cleanKey(raw);
  return key?.startsWith("rk-") ? key : undefined;
};
/** Accepts acme.constructor.app as well as https://acme.constructor.app. */
const linkOrigin = (raw: string) =>
  originOf(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw : `https://${raw.trim()}`,
  );

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Clack draws checkboxes as squares; the agent list shows them as circles (○ / ●). */
const circles = new Proxy(process.stdout, {
  get(target, key) {
    if (key === "write")
      return (chunk: unknown, ...rest: any[]) =>
        (target.write as any)(
          typeof chunk === "string"
            ? chunk.replaceAll("◻", "○").replaceAll("◼", "●")
            : chunk,
          ...rest,
        );
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export async function runInstall(argv: string[]): Promise<number> {
  const flag = (n: string) => argv.includes(n);
  const value = (n: string) =>
    argv.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1);
  const known =
    /^(-y|--yes|--key-stdin|--dry-run|--verbose|--demo|-h|--help|--(agents|harnesses|scope|constructor)=.*)$/;
  const unknown = argv.filter((a) => !known.test(a));
  if (flag("-h") || flag("--help") || unknown.length) {
    if (unknown.length) console.error(`Unknown option: ${unknown.join(" ")}\n`);
    (unknown.length ? console.error : console.log)(USAGE);
    return unknown.length ? 2 : 0;
  }
  const yes = flag("-y") || flag("--yes");
  const dry = flag("--dry-run");
  const verbose = flag("--verbose");
  const demo = flag("--demo");
  if (flag("--key-stdin") && process.stdin.isTTY) {
    console.error(
      "--key-stdin reads a piped key, e.g. from a password manager.",
    );
    return 2;
  }
  if (flag("--key-stdin") && !yes) {
    console.error(
      "--key-stdin needs -y: the questions read from the same input.",
    );
    return 2;
  }
  if (!yes && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      "Run this in a terminal, or pass -y with --agents, --scope and the key on stdin.",
    );
    return 2;
  }

  // One environment for the settings locations, the key file and the agents' own CLIs.
  const env = { ...process.env };
  let home = homedir();
  let cwd = process.cwd();
  if (demo) {
    home = mkdtempSync(join(tmpdir(), "constructor-research-demo-"));
    cwd = join(home, "my-project");
    for (const d of [
      ".claude",
      ".codex",
      join(".config", "opencode"),
      ".jcode",
      ".cline",
      ".cursor",
      "my-project",
    ])
      mkdirSync(join(home, d), { recursive: true });
    // Nothing outside the demo folder: every location override points into it or is cleared.
    for (const v of [
      "OPENCODE_CONFIG_DIR",
      "CLINE_DIR",
      "CLINE_DATA_DIR",
      "CLINE_MCP_SETTINGS_PATH",
      "APPDATA",
    ])
      delete env[v];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      JCODE_HOME: join(home, ".jcode"),
      CONSTRUCTOR_KEY_FILE: join(
        home,
        ".config",
        "constructor-research",
        "access-key.json",
      ),
    });
  }
  const config = configFromEnv({ ...env, CONSTRUCTOR_BASE_URL: undefined });
  const show = (path: string) =>
    path === cwd || path.startsWith(cwd + sep)
      ? "." + path.slice(cwd.length)
      : path.startsWith(home + sep)
        ? "~" + path.slice(home.length)
        : path;
  const ask = async <T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> => {
    const answer = await prompt;
    if (p.isCancel(answer)) {
      p.cancel("Cancelled. Nothing more was changed.");
      process.exit(1);
    }
    return answer as Exclude<T, symbol>;
  };

  // ---- 1. which agents ---------------------------------------------------------------------
  console.log("");
  p.intro(
    `${bold(accent("Constructor Research MCP"))} ${dim("setup")}${demo ? dim(`  (demo in ${home})`) : ""}`,
  );
  const found = detect(home, cwd, env);
  if (found.length) {
    const width = Math.max(...found.map((d) => d.agent.label.length));
    p.note(
      found
        .map(
          (d) => `${bold(d.agent.label.padEnd(width))}  ${dim(show(d.path))}`,
        )
        .join("\n"),
      "Detected coding agents",
    );
  } else
    p.log.warn("No coding agents found in this folder or your home folder.");
  const detectedIds = [...new Set(found.map((d) => d.agent.id))];

  let chosen: string[];
  const listed = value("--agents") ?? value("--harnesses");
  if (listed) {
    chosen = [
      ...new Set(
        listed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const bad = chosen.filter((id) => !AGENTS.some((a) => a.id === id));
    if (bad.length) {
      p.log.error(
        `Unknown agent: ${bad.join(", ")}. Known: ${AGENTS.map((a) => a.id).join(", ")}`,
      );
      return 2;
    }
  } else if (yes) chosen = detectedIds;
  else {
    const mode = detectedIds.length
      ? await ask(
          p.select({
            message: "Install for detected agents only, or add more?",
            options: [
              {
                value: "detected",
                label: "Detected only",
                hint: detectedIds.join(", "),
              },
              { value: "custom", label: "Customize…" },
            ],
          }),
        )
      : "custom";
    chosen =
      mode === "detected"
        ? detectedIds
        : await ask(
            p.autocompleteMultiselect({
              message: "Select coding agents",
              options: AGENTS.map((a) => ({
                value: a.id,
                label: a.label,
                hint: a.hint,
              })),
              initialValues: detectedIds,
              required: true,
              maxItems: AGENTS.length,
              output: circles as any,
            }),
          );
  }
  if (!chosen.length) {
    p.log.error("No coding agent selected or found. Name them with --agents=…");
    return 1;
  }

  // ---- 2. project or global ------------------------------------------------------------------
  let scope = value("--scope") as Scope | undefined;
  if (scope && scope !== "project" && scope !== "global") {
    p.log.error("--scope is project or global");
    return 2;
  }
  if (!scope) {
    const fallback: Scope = found.some(
      (d) => chosen.includes(d.agent.id) && d.scope === "project",
    )
      ? "project"
      : "global";
    scope = yes
      ? fallback
      : await ask(
          p.select({
            message: "Install location",
            initialValue: fallback,
            options: [
              {
                value: "project" as Scope,
                label: "Project",
                hint: show(cwd) === "." ? cwd : show(cwd),
              },
              { value: "global" as Scope, label: "Global", hint: "~" },
            ],
          }),
        );
  }

  // ---- 3. which Constructor ------------------------------------------------------------------
  let saved: SavedKey | undefined;
  try {
    saved = await readKeyFile(config.keyFile);
  } catch {
    saved = undefined; // A broken key file is replaced by the new key.
  }
  let base: string;
  try {
    const given = value("--constructor");
    if (given) base = linkOrigin(given);
    else if (yes) base = saved?.url ?? DEFAULT_BASE_URL;
    else {
      const savedOrg = saved && saved.url !== DEFAULT_BASE_URL ? saved.url : "";
      const where = await ask(
        p.select({
          message: `Where do you have access to ${bold("Constructor Research")}?`,
          initialValue: savedOrg ? "org" : "public",
          options: [
            { value: "public", label: "constructor.app" },
            {
              value: "org",
              label: "My organisation's separate instance",
              hint: "e.g. acme.constructor.app",
            },
          ],
        }),
      );
      base =
        where === "public"
          ? DEFAULT_BASE_URL
          : linkOrigin(
              await ask(
                p.text({
                  message: "Your organisation's instance address",
                  placeholder: "acme.constructor.app",
                  initialValue: savedOrg.replace(/^https:\/\//, ""),
                  validate: (v) => {
                    if (!v?.trim())
                      return "Enter the address you open Constructor at";
                    try {
                      linkOrigin(v);
                    } catch {
                      return "Enter an address like acme.constructor.app";
                    }
                  },
                }),
              ),
            );
      // A typo in the address would send the new key to someone else's server.
      const host = new URL(base).hostname;
      if (
        host !== "constructor.app" &&
        !host.endsWith(".constructor.app") &&
        !(await ask(
          p.confirm({
            message: `${bold(host)} is not a constructor.app address. Send your key there to check it?`,
            initialValue: false,
          }),
        ))
      ) {
        p.cancel("Nothing was sent. Run this again with the right address.");
        return 1;
      }
    }
  } catch (err: any) {
    p.log.error(err?.message ?? String(err));
    return 2;
  }

  // ---- 4. the access key ---------------------------------------------------------------------
  let keySaved = false;
  let keyProblem = "";
  const check = async (key: string) => {
    if (demo) return "ok" as const;
    const s = p.spinner();
    s.start(`Checking the key with ${base.replace(/^https:\/\//, "")}`);
    const { result } = await checkKey(base, config.apiPath, key);
    if (result === "ok") s.stop("Key accepted");
    else if (result === "rejected") s.error(`${base} rejected this key`);
    else
      s.error(
        result === "unreachable"
          ? `Could not reach ${base} (VPN?)`
          : `${base} answered without the public API`,
      );
    return result;
  };
  let key: string | undefined;
  if (yes) {
    const raw = flag("--key-stdin")
      ? await readStdin()
      : env.CONSTRUCTOR_ACCESS_KEY;
    if (raw !== undefined) {
      key = accessKey(raw);
      if (!key) keyProblem = "that is not an access key (it starts with rk-)";
      else if ((await check(key)) !== "ok") {
        keyProblem = "the key was not accepted, so it was not saved";
        key = undefined;
      }
    } else if (!(saved && saved.url === base))
      keyProblem = "no key given (CONSTRUCTOR_ACCESS_KEY or --key-stdin)";
  } else {
    const keep =
      saved?.url === base &&
      !(await ask(
        p.confirm({
          message: `A key for ${base} is already saved (${mask(saved.key)}). Replace it?`,
          initialValue: false,
        }),
      ));
    if (!keep) {
      p.note(
        `1. Open  ${accent(`${base}/research/api-keys`)}\n2. Create an access key and copy it (${dim("rk-…")})\n3. Paste it below. It is not shown, and no agent's settings will contain it`,
        "Get your access key",
      );
      for (let attempt = 0; attempt < 3 && !key; attempt++) {
        const candidate = accessKey(
          await ask(
            p.password({
              message: "Paste the access key",
              mask: "•",
              validate: (v) =>
                accessKey(v)
                  ? undefined
                  : "That is not an access key (it starts with rk-)",
            }),
          ),
        )!;
        const result = await check(candidate);
        if (result === "ok") key = candidate;
        else if (result !== "rejected") {
          if (
            await ask(
              p.confirm({
                message: "Save the key without checking it?",
                initialValue: false,
              }),
            )
          )
            key = candidate;
          break;
        }
      }
      if (!key) keyProblem = "no accepted key, nothing saved";
    }
  }
  if (key) {
    if (dry) p.log.info(`Dry run: key ${mask(key)} not saved.`);
    else {
      await saveKeyFile(config.keyFile, base, key);
      keySaved = true;
      p.log.success(
        `Key saved to ${bold(show(config.keyFile))} ${dim("(readable only by you)")}`,
      );
    }
  } else if (keyProblem) p.log.warn(`Key: ${keyProblem}.`);

  // ---- 5. the MCP entry in each agent ----------------------------------------------------------
  const spec = mcpCommand();
  const targets = chosen.map((id) => {
    const agent = AGENTS.find((a) => a.id === id)!;
    const level: Scope = agent.globalOnly ? "global" : scope!;
    return { agent, level };
  });
  const names = (list: { agent: Agent; level: Scope }[]) =>
    list
      .map(
        (t) =>
          `${t.agent.label}${t.level !== scope ? dim(` (${t.level})`) : ""}`,
      )
      .join(", ");
  if (verbose) {
    const lines: string[] = [];
    for (const { agent, level } of targets) {
      lines.push(`${bold(agent.label)} ${dim(`· ${level}`)}`);
      lines.push(
        `  ${dim("file")}  ${show(agent.file(level, home, cwd, env))}`,
      );
      describe(agent.kind, spec).forEach((l, i) =>
        lines.push(`  ${dim(i ? "    " : "add ")}  ${l}`),
      );
      lines.push("");
    }
    lines.pop();
    p.note(
      lines.join("\n"),
      `MCP "${SERVER}": no key inside, it reads the saved key`,
    );
  }

  const results: { agent: Agent; r: Result }[] = [];
  // Without Claude Code's CLI its settings file is edited directly; an open Claude Code would
  // overwrite that edit when it next saves.
  if (!dry && !demo && chosen.includes("claude") && !claudeCliWorks(env))
    p.log.warn(
      `Quit ${bold("Claude Code")} before you continue: its settings file is edited directly.`,
    );
  if (dry) p.log.info(`Dry run: would add the MCP to ${names(targets)}.`);
  else if (
    yes ||
    (await ask(
      p.confirm({
        message: `Add the MCP to ${names(targets)}${dim(` · ${scope}`)}?`,
        initialValue: true,
      }),
    ))
  ) {
    const s = p.spinner();
    s.start("Adding");
    for (const { agent, level } of targets)
      results.push({
        agent,
        r: applyEntry(agent, level, spec, { cwd, home, env }),
      });
    const good = results.filter(({ r }) => succeeded(r));
    s.stop(
      good.length
        ? `Added to ${good.map(({ agent }) => agent.label).join(", ")}`
        : "Nothing added",
    );
    for (const { agent, r } of results) {
      if (!succeeded(r))
        p.log.warn(
          `${agent.label}: ${r.status}${r.note ? dim(` · ${r.note}`) : ""}`,
        );
      else if (verbose)
        p.log.info(
          `${agent.label}: ${r.status}${r.note ? dim(` · ${r.note}`) : ""}`,
        );
      else if (r.note?.includes("jcode no longer imports"))
        p.log.info(`${agent.label}: ${dim(r.note.split("; ").pop()!)}`);
    }
    if (!verbose && good.length)
      p.log.message(
        dim(
          "Changed files were backed up first. --verbose shows files and entries.",
        ),
      );
  } else p.log.info("Nothing written to the agents' settings.");

  const okNames = results
    .filter(({ r }) => succeeded(r))
    .map(({ agent }) => agent.label);
  const failed = results.some(({ r }) => !succeeded(r)) || !!keyProblem;
  p.outro(
    okNames.length
      ? `${bold("Done.")} Restart ${okNames.join(", ")} and ask about Constructor.`
      : keySaved
        ? `${bold("Key saved.")} Add the MCP to an agent, then restart it.`
        : `${bold("Nothing changed.")} Run this again when ready.`,
  );
  return failed ? 1 : 0;
}
