import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { lintDockerfile } from "../src/files.js";
import { platform, P, D } from "./platform.js";

test("lint flags names, missing FROM/EXPOSE, port mismatch and localhost", () => {
  assert.deepEqual(
    lintDockerfile("app/Dockerfile", "FROM python:3.12\nEXPOSE 8000\n", [8000]),
    [],
  );
  assert.deepEqual(
    lintDockerfile("backend.dockerfile", "FROM x\nEXPOSE 80 443/tcp\n", [443]),
    [],
  );
  const bad = lintDockerfile(
    "Dockerfile.prod",
    "# FROM commented\nEXPOSE 3000\nENV API=http://localhost:8080\n",
    [8080],
  );
  assert.equal(bad.length, 4);
  assert.match(bad[0], /recognizes only/);
  assert.match(bad[1], /No FROM/);
  assert.match(bad[2], /8080 is not EXPOSEd/);
  assert.match(bad[3], /0\.0\.0\.0/);
  assert.match(lintDockerfile("Dockerfile", "FROM x\n", [])[0], /No EXPOSE/);
  assert.deepEqual(
    lintDockerfile(
      "Dockerfile",
      'FROM x \\\n  AS base\nEXPOSE 5000\nCMD ["gunicorn", "-b", "0.0.0.0:5000"]\n',
      [5000],
    ),
    [],
  );
});

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
  const client = new Client({ name: "preflight", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const service = {
  name: "web",
  build: { desk_id: D, dockerfile: "/web/Dockerfile" },
  ports: [{ number: 8080, expose_to_internet: true }],
};

test("a missing Dockerfile stops the build before anything is created", async () => {
  const f = await platform();
  const client = await connect(f);
  try {
    const r: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "stack",
        wait_seconds: 0,
        services: [service],
      },
    });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, "dockerfile_missing");
    assert.match(r.structuredContent.message, /web: web\/Dockerfile/);
    assert.equal(f.db.mutations.length, 0);
    const b: any = await client.callTool({
      name: "build_image",
      arguments: {
        project_id: P,
        desk_id: D,
        dockerfile: "/nope/Dockerfile",
        name: "x",
      },
    });
    assert.equal(b.structuredContent.status, "dockerfile_missing");
  } finally {
    await client.close();
    await f.close();
  }
});

test("verified Dockerfiles skip the upload pause and warnings reach the agent", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  f.db.dav.set("web", null);
  f.db.dav.set(
    "web/Dockerfile",
    Buffer.from(
      "FROM node:22\nEXPOSE 3000\nCMD node server.js --host 127.0.0.1\n",
    ),
  );
  f.db.dav.set("web/docker-compose.yml", Buffer.from("services: {}"));
  const client = await connect(f);
  try {
    const r: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "stack",
        wait_seconds: 0,
        services: [service],
      },
    });
    assert.equal(r.isError, undefined);
    assert.notEqual(r.structuredContent.status, "needs_upload");
    const w = r.structuredContent.dockerfile_warnings;
    assert.equal(w.length, 3);
    assert.ok(w.some((x: string) => /8080 is not EXPOSEd/.test(x)));
    assert.ok(w.some((x: string) => /0\.0\.0\.0/.test(x)));
    assert.ok(w.some((x: string) => /docker-compose is not supported/.test(x)));
    assert.match(r.content[0].text, /Dockerfile warnings/);
    const deadline = Date.now() + 3000;
    while (!f.db.images.some((i: any) => i.dockerfile === "/web/Dockerfile")) {
      if (Date.now() > deadline) assert.fail("build was not submitted");
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    await client.close();
    await f.close();
  }
});
