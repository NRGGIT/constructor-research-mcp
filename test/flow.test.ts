import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, P, D, I } from "./platform.js";

const jwt = (minutes: number) =>
  "ap_access_token=eyJhbGciOiJIUzI1NiJ9." +
  Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000 + minutes * 60) }),
  ).toString("base64url") +
  ".sig";

async function connect(f: any) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      CONSTRUCTOR_BASE_URL: f.config.baseUrl,
      CONSTRUCTOR_COOKIE_FILE: f.config.cookieFile,
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

test("an expired token is caught locally with exact instructions; a nearly expired one blocks long work and warns", async () => {
  const f = await platform();
  const client = await connect(f);
  try {
    await writeFile(f.config.cookieFile, jwt(-5) + "\nBASE_URL=x\n");
    const expired: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(expired.structuredContent.status, "needs_auth");
    assert.match(expired.structuredContent.message, /expired at/);
    assert.ok(expired.structuredContent.message.includes(f.config.cookieFile));
    assert.match(
      expired.structuredContent.message,
      /constructor-research-set-token/,
    );
    assert.equal(f.db.requests.length, 0, "nothing sent with an expired token");

    await writeFile(f.config.cookieFile, jwt(2));
    const blocked: any = await client.callTool({
      name: "create_folder",
      arguments: { project_id: P, desk_id: D, path: "x" },
    });
    assert.equal(blocked.structuredContent.status, "needs_auth");
    assert.match(blocked.structuredContent.message, /too soon/);
    const read: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(read.isError, undefined);
    assert.match(read.structuredContent.auth_warning, /expires in 1 min/);
    // Checking on a deployment is not blocked while the token still works.
    const check: any = await client.callTool({
      name: "get_deployment",
      arguments: { project_id: P },
    });
    assert.notEqual(check.structuredContent.status, "needs_auth");

    // Half an hour left: fine for a listing, too little for a build.
    await writeFile(f.config.cookieFile, jwt(30));
    const listed: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(listed.structuredContent.auth_warning, undefined);
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
    assert.match(
      deploy.structuredContent.auth_warning,
      /expires in 29 min; builds often take 10–30 min.*needs_auth/,
    );

    // A renewable session warns a day before it ends, not when the hour-long token runs low.
    await writeFile(
      f.config.cookieFile,
      `${jwt(30)}; ap_refresh_token=refresh-0`.replace(
        /\.([^.]+)\.sig/,
        (_, p) =>
          "." +
          Buffer.from(
            JSON.stringify({
              ...JSON.parse(Buffer.from(p, "base64url").toString()),
              max_slt: Math.floor(Date.now() / 1000) + 5 * 3600 + 60,
            }),
          ).toString("base64url") +
          ".sig",
      ),
    );
    const renewable: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.match(
      renewable.structuredContent.auth_warning,
      /login session ends in 5 h.*call the sign_in tool/,
    );

    await writeFile(f.config.cookieFile, jwt(60));
    const fine: any = await client.callTool({
      name: "list_files",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(fine.structuredContent.auth_warning, undefined);
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
