#!/usr/bin/env node
/**
 * Blocks until deployments finish, for agents that have nothing else to do and for
 * client hooks that wake an agent. It watches the checkpoints the MCP writes; if no
 * process has advanced a deployment for a minute (the MCP was closed), it continues
 * the deployment itself.
 */
import { setTimeout as delay } from "node:timers/promises";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configFromEnv } from "./config.js";
import { PlatformApi } from "./api.js";
import { StateStore } from "./store.js";
import { DeploymentEngine, terminal } from "./deployment.js";
import { DeploymentRuntime, paused } from "./runtime.js";
import { FileManager } from "./files.js";
import { LogFollower } from "./logs.js";

const ok = new Set(["started", "stopped", "built"]);
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const EXIT = {
  done: 0,
  error: 1,
  attention: 2,
  running: 3,
  nothing: 4,
} as const;
const final = (status: string) => terminal.has(status) || paused.has(status);

export interface WaitOptions {
  maxMs: number;
  /** A deployment nobody advanced for this long is continued here; Infinity only watches. */
  staleMs?: number;
  pollMs?: number;
}
export interface WaitResult {
  results: any[];
  running: string[];
  code: number;
}

/** Deployments still in progress that were touched in the last two hours. */
export async function active(store: StateStore) {
  const since = Date.now() - 2 * 60 * 60 * 1000;
  const ids: string[] = [];
  for (const id of await store.ids()) {
    try {
      const op = await store.load(id);
      if (
        op &&
        !final(op.status) &&
        Math.max(Date.parse(op.updated_at), await store.lastBeat(id)) > since
      )
        ids.push(id);
    } catch {
      /* Foreign or corrupt checkpoints are not ours to wait for. */
    }
  }
  return ids;
}

export async function waitFor(
  runtime: DeploymentRuntime,
  ids: string[],
  { maxMs, staleMs = 60000, pollMs = 5000 }: WaitOptions,
): Promise<WaitResult> {
  const store = runtime.engine.store;
  const deadline = Date.now() + maxMs;
  const pending = new Set(ids);
  const results: any[] = [];
  for (;;) {
    for (const id of [...pending]) {
      const op = await store.load(id);
      if (!op) {
        results.push({
          deployment_id: id,
          status: "not_found",
          message: "No such deployment in the local state.",
        });
        pending.delete(id);
      } else if (final(op.status)) {
        results.push(await runtime.get({ deployment_id: id }));
        pending.delete(id);
      } else if (
        Date.now() -
          Math.max(Date.parse(op.updated_at), await store.lastBeat(id)) >
        staleMs
      )
        await runtime.get({ deployment_id: id, resume: true, wait_seconds: 0 });
    }
    if (!pending.size || Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  const running = [...pending];
  return {
    results,
    running,
    code: results.some((r) => !ok.has(r.status))
      ? EXIT.attention
      : running.length
        ? EXIT.running
        : EXIT.done,
  };
}

/** One line per deployment, for an agent to read. */
export function summary({ results, running }: WaitResult) {
  const lines = results.map((r) => {
    const services = (r.services ?? [])
      .map((s: any) =>
        `${s.name} ${s.status ?? ""}${s.public_url ? ` ${s.public_url}` : ""}`.trim(),
      )
      .join(", ");
    return [
      `Deployment ${r.deployment_id}: ${r.status}.`,
      r.message,
      services && `Services: ${services}.`,
      r.next_action && `Next: ${r.next_action}`,
    ]
      .filter(Boolean)
      .join(" ");
  });
  for (const id of running)
    lines.push(
      `Deployment ${id}: still in progress. Run the wait command again to keep waiting.`,
    );
  return lines.join("\n");
}

async function stdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Only one hook waiter per deployment, so the agent is woken once. */
async function claim(dir: string, id: string) {
  const file = join(dir, `${id}.waiter`);
  try {
    await writeFile(file, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    try {
      process.kill(Number(await readFile(file, "utf8")), 0);
      return undefined;
    } catch {
      await writeFile(file, String(process.pid), { mode: 0o600 });
    }
  }
  return () => unlink(file).catch(() => {});
}

/** The hook entry each client needs, as in examples/ (claude-hooks.json, codex-hooks.json). */
const HOOK =
  "npx -y -p constructor-research-mcp@latest constructor-research-wait";
const HOOKS = {
  codex: {
    file: () =>
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json"),
    event: "Stop",
    entry: {
      hooks: [
        {
          type: "command",
          command: `${HOOK} --hook codex`,
          timeout: 600,
          statusMessage: "Waiting for Constructor deployments",
        },
      ],
    },
    next: "Restart Codex and trust the new hook in /hooks.",
  },
  "claude-code": {
    file: () =>
      join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "settings.json",
      ),
    event: "PostToolUse",
    entry: {
      matcher:
        "mcp__constructor-research__(deploy_app|update_app|build_image|start_app|stop_app|get_deployment)",
      hooks: [
        {
          type: "command",
          command: `${HOOK} --hook claude-code`,
          asyncRewake: true,
        },
      ],
    },
    next: "Restart Claude Code.",
  },
} as const;

/** Add the wait hook to the client's settings once; other settings and hooks stay as they are. */
export async function installHook(client: keyof typeof HOOKS, file?: string) {
  const h = HOOKS[client];
  const path = file ?? h.file();
  let settings: any = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT")
      throw new Error(`${path} is not valid JSON; nothing was changed.`);
  }
  settings.hooks ??= {};
  const list: any[] = (settings.hooks[h.event] ??= []);
  if (JSON.stringify(list).includes("constructor-research-wait"))
    return { path, added: false, next: h.next };
  list.push(h.entry);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
  return { path, added: true, next: h.next };
}

const USAGE = `Usage: constructor-research-wait [deployment_id ...] [--max-minutes N] [--hook claude-code|codex|opencode]
       constructor-research-wait --install codex|claude-code

Waits until the deployments finish (all in-progress ones when no ID is given) and prints one line each.
Exit codes: 0 finished, 2 needs the user (failed, key, upload, confirmation), 3 still running at the
time limit, 4 nothing to wait for, 1 usage error.

--hook claude-code  PostToolUse hook with asyncRewake: waits for the deployment in the tool result and
                    wakes Claude with the outcome (exit 2). opencode: the same, for the plugin.
--hook codex        Stop hook: waits for in-progress deployments, then continues the turn with the outcome.
--install CLIENT    Add that hook to ~/.codex/hooks.json or ~/.claude/settings.json (once; nothing else changes).`;

async function main(argv: string[]) {
  const ids: string[] = [];
  let hook: string | undefined;
  let minutes: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") {
      const client = argv[++i];
      if (client !== "codex" && client !== "claude-code") {
        console.error(USAGE);
        return EXIT.error;
      }
      try {
        const r = await installHook(client);
        console.log(
          `${r.added ? "Added the wait hook to" : "The wait hook is already in"} ${r.path}. ${r.next} The hook reads the access key from the key file (constructor-research-set-key), not from the MCP settings.`,
        );
        return EXIT.done;
      } catch (err: any) {
        console.error(err?.message ?? String(err));
        return EXIT.error;
      }
    }
    if (a === "--hook") hook = argv[++i];
    else if (a === "--max-minutes") minutes = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return EXIT.done;
    } else if (/^[0-9a-f-]{36}$/i.test(a)) ids.push(a);
    else {
      console.error(USAGE);
      return EXIT.error;
    }
  }
  if (
    (hook && !["claude-code", "codex", "opencode"].includes(hook)) ||
    (minutes !== undefined && !(minutes > 0))
  ) {
    console.error(USAGE);
    return EXIT.error;
  }
  const config = configFromEnv();
  const api = new PlatformApi(config);
  await api.refresh();
  const store = new StateStore(config);
  const engine = new DeploymentEngine(api, store);
  engine.files = new FileManager(api, engine);
  engine.logs = new LogFollower(api);
  const runtime = new DeploymentRuntime(engine);
  const release: (() => Promise<void>)[] = [];
  try {
    const toolHook = hook === "claude-code" || hook === "opencode";
    if (toolHook) {
      // Only deployments still running when the tool returned; a finished one was already reported.
      for (const id of new Set((await stdin()).match(ID) ?? [])) {
        const op = await store.load(id).catch(() => undefined);
        const free =
          op && !final(op.status) && (await claim(config.stateDir, id));
        if (free) {
          ids.push(id);
          release.push(free);
        }
      }
      if (!ids.length) return EXIT.done;
    } else if (hook === "codex") await stdin();
    // Deployments found by scanning may belong to other sessions: watch them, never drive them.
    const named = ids.length > 0;
    if (!named) ids.push(...(await active(store)));
    if (!ids.length) {
      if (!hook) console.log("No deployment is in progress.");
      return hook ? EXIT.done : EXIT.nothing;
    }
    // Codex stops a hook after its timeout (600 s by default); stay under it.
    const maxMs = (minutes ?? (hook === "codex" ? 9 : 60)) * 60000;
    const result = await waitFor(runtime, ids, {
      maxMs,
      staleMs: named ? undefined : Infinity,
    });
    const text = summary(result);
    if (toolHook) {
      console.error(text);
      return EXIT.attention;
    }
    if (hook === "codex") {
      console.log(JSON.stringify({ decision: "block", reason: text }));
      return EXIT.done;
    }
    console.log(text);
    return result.code;
  } finally {
    await runtime.close();
    await engine.logs.close();
    await Promise.all(release.map((f) => f()));
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT.error);
    },
  );
