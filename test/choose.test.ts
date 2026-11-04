import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, P, D } from "./platform.js";

async function connect(f: any) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      CONSTRUCTOR_BASE_URL: f.config.baseUrl,
      CONSTRUCTOR_KEY_FILE: f.config.keyFile,
      CONSTRUCTOR_STATE_DIR: f.config.stateDir,
      CONSTRUCTOR_READINESS_SECONDS: "0",
      CONSTRUCTOR_UPLOAD_SETTLE_SECONDS: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "choose", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const until = async (ok: () => boolean, what: string) => {
  const deadline = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("project_id alone: the only desk is used; with several desks the user chooses", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  const app = join(f.dir, "simple-html");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "Dockerfile"), "FROM nginx\nEXPOSE 8080\n");
  await writeFile(join(app, "index.html"), "<h1>hi</h1>");
  const client = await connect(f);
  const deploy = () =>
    client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "simple-html",
        wait_seconds: 0,
        services: [
          {
            name: "web",
            build: { local_path: app },
            ports: [{ number: 8080, expose_to_internet: true }],
          },
        ],
      },
    }) as Promise<any>;
  try {
    const files: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P },
    });
    assert.equal(files.isError, undefined, JSON.stringify(files));

    const r = await deploy();
    assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
    assert.equal(
      f.db.dav.get("simple-html/index.html").toString(),
      "<h1>hi</h1>",
    );
    await until(
      () =>
        f.db.images.some(
          (i: any) => i.dockerfile === "/simple-html/Dockerfile",
        ),
      "build was not submitted",
    );

    f.db.desks.push({
      id: "eeee2222",
      name: "second",
      project_id: P,
      state: "ready",
    });
    const before = f.db.mutations.length;
    const ask: any = await deploy();
    assert.equal(ask.structuredContent.status, "desk_choice_required");
    assert.deepEqual(
      ask.structuredContent.desks.map((d: any) => d.name),
      ["source", "second"],
    );
    assert.match(
      ask.structuredContent.desks[0].desk_url,
      new RegExp(`/projects/${P}/desks/${D}`),
    );
    const list: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P },
    });
    assert.equal(list.structuredContent.status, "desk_choice_required");
    assert.equal(f.db.mutations.length, before);
  } finally {
    await client.close();
    await f.close();
  }
});

test("image: an external image in the project is used as is; any other registry image is built from FROM", async () => {
  const f = await platform();
  f.db.images.push({
    id: "ext11111",
    name: "nginx",
    desk_id: null,
    desk_name: null,
    project_id: P,
    source: "external",
    reference: "docker.io/library/nginx:1.27",
    build_status: "not_started",
  });
  const client = await connect(f);
  try {
    const images: any = await client.callTool({
      name: "list_images",
      arguments: { project_id: P },
    });
    const ext = images.structuredContent.results.find(
      (x: any) => x.id === "ext11111",
    );
    assert.equal(ext.source, "external");
    assert.equal(ext.reference, "docker.io/library/nginx:1.27");

    f.db.buildStatus = "done";
    const pulled: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "drawio",
        wait_seconds: 0,
        services: [
          {
            name: "drawio",
            image: "jgraph/drawio:latest",
            ports: [{ number: 8080, expose_to_internet: true }],
          },
        ],
      },
    });
    assert.equal(
      pulled.isError,
      undefined,
      JSON.stringify(pulled.structuredContent),
    );
    // Not in the project: built on the desk from a one-line Dockerfile the MCP wrote.
    assert.equal(
      f.db.dav
        .get(".constructor/images/jgraph-drawio-latest/Dockerfile")
        ?.toString(),
      "FROM jgraph/drawio:latest\n",
    );
    await until(
      () =>
        f.db.images.some(
          (i: any) =>
            i.dockerfile ===
            "/.constructor/images/jgraph-drawio-latest/Dockerfile",
        ),
      "registry image was not built",
    );
    await until(
      () => f.db.applications.some((a: any) => a.services?.length),
      "drawio service was not created",
    );
    f.db.applications.length = 0;
    const builds = f.db.images.length;

    const r: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "ext",
        wait_seconds: 0,
        services: [
          {
            name: "web",
            image: "docker.io/library/nginx:1.27",
            ports: [{ number: 80, expose_to_internet: true }],
          },
        ],
      },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
    await until(
      () =>
        f.db.applications.some((a: any) =>
          a.services?.some((s: any) => s.image_id === "ext11111"),
        ),
      "service with the external image was not created",
    );
    // The external image is used as is: nothing is built for it.
    assert.equal(f.db.images.length, builds);
  } finally {
    await client.close();
    await f.close();
  }
});

test("the wait hook is added once, keeping other settings", async () => {
  const { installHook } = await import("../src/wait.js");
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "hooks-"));
  const file = join(dir, "hooks.json");
  await writeFile(
    file,
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] },
    }),
  );
  assert.equal((await installHook("codex", file)).added, true);
  assert.equal((await installHook("codex", file)).added, false);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.hooks.Stop.length, 2);
  assert.match(
    saved.hooks.Stop[1].hooks[0].command,
    /constructor-research-wait --hook codex/,
  );
  const claude = join(dir, "settings.json");
  await writeFile(claude, JSON.stringify({ model: "x" }));
  await installHook("claude-code", claude);
  const c = JSON.parse(await readFile(claude, "utf8"));
  assert.equal(c.model, "x");
  assert.equal(c.hooks.PostToolUse[0].hooks[0].asyncRewake, true);
});
