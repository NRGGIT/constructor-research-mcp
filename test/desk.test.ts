import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform, P, D } from "./platform.js";

/** How the MCP gets access to the fake Constructor. */
const ACCESS = (f: any) => ({ CONSTRUCTOR_COOKIE_FILE: f.config.cookieFile });
import { configFromEnv, originOf } from "../src/config.js";
import { diskPath, localDeskFromEnv, localPath } from "../src/desk.js";

const ENV = {
  HOME: "/home/coder",
  ROLOS_PROJECT_ID: "c98d546de8104a2d9968aba721fe90f2",
  ROLOS_DESK_ID: "fef21248839c46188eb75dad0b5a375e",
  ROLOS_API_SERVER: "https://constructor.app",
};

test("the desk is read from the environment Constructor sets in VS Code", () => {
  const desk = localDeskFromEnv(ENV, originOf)!;
  assert.deepEqual(desk, {
    projectId: ENV.ROLOS_PROJECT_ID,
    deskId: ENV.ROLOS_DESK_ID,
    root: "/home/coder/project",
    server: "https://constructor.app",
  });
  // RESEARCH_* names work too.
  assert.equal(
    localDeskFromEnv(
      {
        HOME: "/h",
        RESEARCH_PROJECT_ID: "pppp1111",
        RESEARCH_DESK_ID: "dddd2222",
      },
      originOf,
    )?.deskId,
    "dddd2222",
  );
  assert.equal(
    localDeskFromEnv({ ...ENV, CONSTRUCTOR_LOCAL_DESK: "0" }, originOf),
    undefined,
  );
  assert.equal(
    localDeskFromEnv({ ...ENV, ROLOS_DESK_ID: "../x" }, originOf),
    undefined,
  );
  assert.equal(localDeskFromEnv({ HOME: "/h" }, originOf), undefined);
  const config = configFromEnv(ENV);
  assert.equal(config.baseUrl, "https://constructor.app");
  assert.equal(config.baseUrlFixed, true);
  assert.equal(config.localDesk?.deskId, ENV.ROLOS_DESK_ID);
  // An explicit CONSTRUCTOR_BASE_URL still wins.
  assert.equal(
    configFromEnv({
      ...ENV,
      CONSTRUCTOR_BASE_URL: "https://acme.constructor.app",
    }).baseUrl,
    "https://acme.constructor.app",
  );
  assert.equal(configFromEnv({}).localDesk, undefined);
});

test("local paths map onto the desk's disk and never escape it", () => {
  const desk = localDeskFromEnv(ENV, originOf)!;
  assert.equal(diskPath(desk, "/home/coder/project/backend"), "/backend");
  assert.equal(diskPath(desk, "/home/coder/project"), "/");
  assert.equal(diskPath(desk, "/home/coder/other"), undefined);
  assert.equal(
    localPath(desk, "/backend/Dockerfile"),
    "/home/coder/project/backend/Dockerfile",
  );
  assert.throws(() => localPath(desk, "/../etc/passwd"));
});

test("inside a desk, tools default to it, never use WebDAV for it, and read Dockerfiles locally", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  const root = await mkdtemp(join(tmpdir(), "constructor-desk-"));
  await writeFile(join(root, "Dockerfile"), "FROM nginx\nEXPOSE 8080\n");
  await mkdir(join(root, "api"));
  await writeFile(
    join(root, "api", "Dockerfile"),
    "FROM node:22\nEXPOSE 3000\n",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      ...ACCESS(f),
      CONSTRUCTOR_STATE_DIR: f.config.stateDir,
      CONSTRUCTOR_READINESS_SECONDS: "0",
      CONSTRUCTOR_UPLOAD_SETTLE_SECONDS: "0",
      ROLOS_PROJECT_ID: P,
      ROLOS_DESK_ID: D,
      ROLOS_API_SERVER: f.config.baseUrl,
      CONSTRUCTOR_DESK_ROOT: root,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "desk-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.match(
      client.getInstructions() ?? "",
      /runs inside Constructor desk dddd1111/,
    );
    assert.doesNotMatch(
      client.getInstructions() ?? "",
      /ask the user for the Constructor desk link/,
    );

    const sync: any = await client.callTool({
      name: "sync_files",
      arguments: { local_path: root },
    });
    assert.equal(sync.structuredContent.status, "local_desk");
    assert.ok(sync.structuredContent.message.includes(root));

    const missing: any = await client.callTool({
      name: "build_image",
      arguments: { name: "web", dockerfile: "/nope/Dockerfile" },
    });
    assert.equal(missing.structuredContent.status, "dockerfile_missing");

    const built: any = await client.callTool({
      name: "build_image",
      arguments: { name: "web", dockerfile: "/Dockerfile", wait_seconds: 0 },
    });
    assert.equal(
      built.isError,
      undefined,
      JSON.stringify(built.structuredContent),
    );
    const build = f.db.mutations.find(
      (m: any) => m.path === `/desks/${D}/images`,
    );
    assert.equal(build?.body.dockerfile, "/Dockerfile");

    // local_path inside the desk folder: no upload, the Dockerfile path is derived from it.
    const deploy: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        application_name: "stack",
        wait_seconds: 0,
        services: [
          {
            name: "api",
            build: { local_path: join(root, "api") },
            ports: [{ number: 3000, expose_to_internet: true }],
          },
        ],
      },
    });
    assert.equal(
      deploy.isError,
      undefined,
      JSON.stringify(deploy.structuredContent),
    );
    assert.notEqual(deploy.structuredContent.status, "needs_upload");
    const deadline = Date.now() + 3000;
    while (
      !f.db.mutations.some(
        (m: any) =>
          m.path === `/desks/${D}/images` &&
          m.body.dockerfile === "/api/Dockerfile",
      )
    ) {
      if (Date.now() > deadline)
        assert.fail("the api image was not built from /api/Dockerfile");
      await new Promise((r) => setTimeout(r, 10));
    }

    const outside: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        application_name: "other",
        services: [{ name: "x", build: { local_path: tmpdir() } }],
      },
    });
    assert.equal(outside.structuredContent.status, "invalid_input");
    assert.match(
      outside.structuredContent.message,
      /outside this desk's project folder/,
    );

    assert.equal(
      f.db.davRequests.length,
      0,
      "no WebDAV for the desk the MCP runs in",
    );
  } finally {
    await client.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
