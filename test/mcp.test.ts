import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { platform, P, D } from "./platform.js";

test("stdio exposes fourteen tools and executes discovery, validation and image listing without stdout noise", async () => {
  const f = await platform();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      CONSTRUCTOR_BASE_URL: f.config.baseUrl,
      CONSTRUCTOR_API_PATH: f.config.apiPath,
      CONSTRUCTOR_COOKIE_FILE: f.config.cookieFile,
      CONSTRUCTOR_STATE_DIR: f.config.stateDir,
      CONSTRUCTOR_READINESS_SECONDS: "0",
      CONSTRUCTOR_UPLOAD_SETTLE_SECONDS: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (x) => (stderr += x));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "build_image",
      "create_folder",
      "delete_path",
      "deploy_app",
      "get_deployment",
      "get_logs",
      "list_files",
      "list_images",
      "move_path",
      "sign_in",
      "start_app",
      "stop_app",
      "sync_files",
      "update_app",
    ]);
    const result: any = await client.callTool({
      name: "list_images",
      arguments: { project_id: P, desk_id: D },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.results[0].build_status, "done");
    const invalid: any = await client.callTool({
      name: "build_image",
      arguments: {
        project_id: P,
        desk_id: D,
        dockerfile: "/Dockerfile",
        name: "web",
        ephemeral_build_disk_size_gb: 1,
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(f.db.mutations.length, 0);
    const discovery: any = await client.callTool({
      name: "get_deployment",
      arguments: {},
    });
    assert.equal(discovery.structuredContent.projects[0].project_id, P);
    f.db.auth = false;
    const auth: any = await client.callTool({
      name: "list_images",
      arguments: { project_id: P },
    });
    assert.equal(auth.structuredContent.status, "needs_auth");
    assert.ok(!JSON.stringify(auth).includes("test-cookie"));
    assert.ok(!JSON.stringify(auth).includes("SECRET"));
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await f.close();
  }
});

test("stdio deployment executes the whole application after the submit response, without status calls", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  for (const [k, v] of [
    ["backend", null],
    ["frontend", null],
    ["backend/Dockerfile", "FROM node:22\nEXPOSE 8080\n"],
    ["frontend/Dockerfile", "FROM node:22\nEXPOSE 3000\n"],
  ] as const)
    f.db.dav.set(k, v === null ? null : Buffer.from(v));
  const client = new Client({
    name: "background-integration",
    version: "1.0.0",
  });
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
  try {
    await client.connect(transport);
    const r: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        project_id: P,
        application_name: "stack",
        files_uploaded: true,
        wait_seconds: 0,
        services: [
          {
            name: "backend",
            build: { desk_id: D, dockerfile: "/backend/Dockerfile" },
            ports: [{ number: 8080, expose_to_internet: true }],
          },
          {
            name: "frontend",
            build: { desk_id: D, dockerfile: "/frontend/Dockerfile" },
            ports: [{ number: 3000, expose_to_internet: true }],
            environment_variables: {
              API_URL: { service: "backend", exposure: "public" },
            },
          },
        ],
      },
    });
    assert.equal(r.isError, undefined);
    assert.ok(
      r.content[0].text.length < JSON.stringify(r.structuredContent).length,
    );
    const deadline = Date.now() + 3000;
    while (
      !f.db.applications[0]?.services.every(
        (s: any) => s.status === "running",
      ) ||
      f.db.applications[0]?.services.length !== 2
    ) {
      if (Date.now() > deadline)
        assert.fail(
          "stdio server did not execute the application in the background",
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const backend = f.db.applications[0].services.find(
      (s: any) => s.name === "backend",
    );
    const frontend = f.db.applications[0].services.find(
      (s: any) => s.name === "frontend",
    );
    assert.equal(
      frontend.environment_variables[0].value,
      `https://${backend.id}.constructor.pro`,
    );
  } finally {
    await client.close();
    await f.close();
  }
});
