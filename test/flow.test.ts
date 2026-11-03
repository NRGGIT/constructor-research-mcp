import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, KEY, P, D, I } from "./platform.js";
import { saveKeyFile } from "../src/key.js";

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
  const client = new Client({ name: "flow", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("a missing or foreign key is caught locally with exact instructions; a key saved later works without a restart", async () => {
  const f = await platform();
  const client = await connect(f);
  try {
    await unlink(f.config.keyFile);
    const missing: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(missing.structuredContent.status, "needs_key");
    assert.match(
      missing.structuredContent.message,
      /constructor-research-set-key http:\/\/127\.0\.0\.1:\d+.*Never ask the user to paste the key into the chat/,
    );
    assert.equal(f.db.keys.length, 0, "nothing sent without a key");

    await saveKeyFile(f.config.keyFile, "https://other.constructor.app", KEY);
    const foreign: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(foreign.structuredContent.status, "needs_key");
    assert.match(
      foreign.structuredContent.message,
      /belongs to https:\/\/other/,
    );
    assert.ok(!JSON.stringify(foreign).includes(KEY));
    assert.equal(f.db.keys.length, 0, "a key is never sent to another host");

    await saveKeyFile(f.config.keyFile, f.config.baseUrl, KEY);
    const read: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(read.isError, undefined);
    const deploy: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "web",
        wait_seconds: 0,
        services: [
          {
            name: "web",
            image_id: I,
            ports: [{ number: 5000, expose_to_internet: true }],
          },
        ],
      },
    });
    assert.equal(deploy.isError, undefined);
    assert.equal(deploy.structuredContent.auth_warning, undefined);
  } finally {
    await client.close();
    await f.close();
  }
});

test("deploy_app uploads a local folder, builds from it, and asks once before replacing files", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  const app = join(f.dir, "calculator");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "Dockerfile"), "FROM nginx\nEXPOSE 8080\n");
  await writeFile(join(app, "index.html"), "<h1>v1</h1>");
  const client = await connect(f);
  const url = `${f.config.baseUrl}/research/projects/${P}/desks/${D}`;
  const deploy = (name: string, extra: any = {}) =>
    client.callTool({
      name: "deploy_app",
      arguments: {
        desk_url: url,
        application_name: name,
        wait_seconds: 0,
        services: [
          {
            name: "web",
            build: { local_path: app },
            ports: [{ number: 8080, expose_to_internet: true }],
          },
        ],
        ...extra,
      },
    }) as Promise<any>;
  try {
    const r = await deploy("calc");
    assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
    assert.equal(
      f.db.dav.get("calculator/index.html").toString(),
      "<h1>v1</h1>",
    );
    const deadline = Date.now() + 3000;
    while (
      !f.db.images.some((i: any) => i.dockerfile === "/calculator/Dockerfile")
    ) {
      if (Date.now() > deadline) assert.fail("build was not submitted");
      await new Promise((r) => setTimeout(r, 10));
    }

    while (
      !f.db.applications.some((a: any) =>
        a.services?.some((s: any) => s.status === "running"),
      )
    ) {
      if (Date.now() > deadline + 5000)
        assert.fail("first deployment did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 200));

    await writeFile(join(app, "index.html"), "<h1>v2</h1>");
    const images = f.db.images.length;
    const ask: any = await deploy("calc2");
    assert.equal(ask.structuredContent.status, "confirm_required");
    assert.deepEqual(ask.structuredContent.changed_files, [
      "calculator/index.html",
    ]);
    assert.match(
      ask.structuredContent.message,
      /Nothing was built yet.*confirm=true/,
    );
    assert.equal(
      f.db.dav.get("calculator/index.html").toString(),
      "<h1>v1</h1>",
    );
    assert.equal(f.db.images.length, images);

    const ok: any = await deploy("calc2", { confirm: true });
    assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent));
    assert.equal(
      f.db.dav.get("calculator/index.html").toString(),
      "<h1>v2</h1>",
    );
  } finally {
    await client.close();
    await f.close();
  }
});
