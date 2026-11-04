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

test("a service runs an external image named by its reference", async () => {
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

    const missing: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "ext",
        wait_seconds: 0,
        services: [{ name: "web", image: "redis:7" }],
      },
    });
    assert.equal(missing.structuredContent.status, "invalid_input");
    assert.match(
      missing.structuredContent.message,
      /docker\.io\/library\/nginx:1\.27 \(ext11111\)/,
    );

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
    assert.ok(!f.db.mutations.some((m: any) => /\/images$/.test(m.path ?? "")));
  } finally {
    await client.close();
    await f.close();
  }
});
