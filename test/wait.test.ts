import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, P, D } from "./platform.js";
import { DeploymentRuntime } from "../src/runtime.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitCommand, waitProgram } from "../src/config.js";
import { active, waitFor, summary, EXIT } from "../src/wait.js";

const run = promisify(execFile);
/** Builds already submitted keep their own status in the fake platform. */
function builds(db: any, status: string) {
  db.buildStatus = status;
  for (const image of db.images) image.build_status = status;
}
const deployment = {
  project_id: P,
  application_name: "stack",
  files_uploaded: true,
  wait_seconds: 0,
  services: [
    {
      name: "web",
      build: { desk_id: D, dockerfile: "/web/Dockerfile" },
      ports: [{ number: 3000, expose_to_internet: true }],
    },
  ],
};

test("wait returns once the MCP finishes the deployment and summarises it", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  try {
    const { deployment_id } = await mcp.deploy(deployment);
    assert.deepEqual(await active(f.store), [deployment_id]);
    setTimeout(() => builds(f.db, "done"), 100);
    const r = await waitFor(mcp, [deployment_id], {
      maxMs: 5000,
      pollMs: 20,
    });
    assert.equal(r.code, EXIT.done);
    assert.equal(r.results[0].status, "started");
    assert.match(summary(r), /: started\. .*Services: web running https:\/\//);
    assert.deepEqual(await active(f.store), []);
  } finally {
    await mcp.close();
    await f.close();
  }
});

test("wait continues a deployment nobody is advancing, and reports a time limit", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  const waiter = new DeploymentRuntime(f.engine, 20);
  try {
    const { deployment_id } = await mcp.deploy(deployment);
    await mcp.close(); // The MCP was closed mid-build.
    let r = await waitFor(waiter, [deployment_id], {
      maxMs: 300,
      staleMs: 50,
      pollMs: 20,
    });
    assert.equal(r.code, EXIT.running);
    assert.match(summary(r), /still in progress/);
    builds(f.db, "done");
    r = await waitFor(waiter, [deployment_id], {
      maxMs: 5000,
      staleMs: 50,
      pollMs: 20,
    });
    assert.equal(r.code, EXIT.done);
    assert.equal(f.db.applications[0].services[0].status, "running");
  } finally {
    await waiter.close();
    await f.close();
  }
});

test("a failed deployment needs the user", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  try {
    const { deployment_id } = await mcp.deploy(deployment);
    builds(f.db, "error");
    const r = await waitFor(mcp, [deployment_id], {
      maxMs: 5000,
      pollMs: 20,
    });
    assert.equal(r.code, EXIT.attention);
    assert.match(summary(r), /: failed\..*Next: /);
  } finally {
    await mcp.close();
    await f.close();
  }
});

test("the in-progress hint names a wait command with the MCP's own settings", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  try {
    const r = await mcp.deploy(deployment);
    assert.match(
      r.next_action,
      /wait with the shell command `.*wait\.(js|ts) /,
    );
    const command = waitCommand(f.config, [r.deployment_id]);
    assert.match(command, /^CONSTRUCTOR_BASE_URL=http:\/\/127\.0\.0\.1:\d+ /);
    assert.match(command, /CONSTRUCTOR_STATE_DIR=\S+ /);
    assert.ok(command.endsWith(` ${r.deployment_id}`));
  } finally {
    await mcp.close();
    await f.close();
  }
});

test("hooks: Codex continues the turn with the outcome, Claude Code is woken with exit 2", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  const env = {
    ...process.env,
    CONSTRUCTOR_BASE_URL: f.config.baseUrl,
    CONSTRUCTOR_COOKIE_FILE: f.config.cookieFile,
    CONSTRUCTOR_STATE_DIR: f.config.stateDir,
  };
  const cli = (args: string[], input = "{}") => {
    const child = run(
      process.execPath,
      ["dist/wait.js", "--max-minutes", "0.5", ...args],
      { env },
    );
    child.child.stdin!.end(input);
    return child.then(
      (r) => ({ code: 0, ...r }),
      (e: any) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
    );
  };
  try {
    // Nothing in progress: the agent may stop.
    let r = await cli(["--hook", "codex"]);
    assert.deepEqual([r.code, r.stdout], [0, ""]);
    assert.equal((await cli([])).code, EXIT.nothing);

    const { deployment_id } = await mcp.deploy(deployment);
    setTimeout(() => builds(f.db, "done"), 200);
    const [codex, claude] = await Promise.all([
      cli(["--hook", "codex"]),
      cli(
        ["--hook", "claude-code"],
        JSON.stringify({
          tool_name: "mcp__constructor-research__deploy_app",
          tool_response: `building (${deployment_id})`,
        }),
      ),
    ]);
    assert.equal(codex.code, 0);
    const out = JSON.parse(codex.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, new RegExp(`${deployment_id}: started`));
    assert.equal(claude.code, 2);
    assert.match(claude.stderr, new RegExp(`${deployment_id}: started`));

    // Already finished when the tool returned: no second wake-up.
    r = await cli(
      ["--hook", "claude-code"],
      JSON.stringify({ tool_response: `started (${deployment_id})` }),
    );
    assert.deepEqual([r.code, r.stderr], [0, ""]);
  } finally {
    await mcp.close();
    await f.close();
  }
});

test("run through npx, the hint names the package version instead of npx's cache folder", async () => {
  const dist = resolve(import.meta.dirname, "../dist/config.js");
  assert.match(waitProgram(dist), /^node .*dist\/wait\.js$/);
  const { version } = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  const cache = await mkdtemp(join(tmpdir(), "npx-"));
  const pkg = join(
    cache,
    "_npx",
    "46bdcc461a06330f",
    "node_modules",
    "constructor-research-mcp",
  );
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "constructor-research-mcp", version }),
  );
  assert.equal(
    waitProgram(join(pkg, "dist", "config.js")),
    `npx -y -p constructor-research-mcp@${version} constructor-research-wait`,
  );
  await rm(cache, { recursive: true, force: true });
});
