import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform, P, D } from "./platform.js";

/** How the MCP gets access to the fake Constructor. */
const ACCESS = (f: any) => ({ CONSTRUCTOR_KEY_FILE: f.config.keyFile });
import { configFromEnv, originOf } from "../src/config.js";
import { diskPath, localDeskFromEnv, localPath } from "../src/desk.js";
import { PlatformApi } from "../src/api.js";
import { routeKey, saveKeyFile } from "../src/key.js";
import { createServer } from "node:http";
import { KEY } from "./platform.js";

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
  // The desk's server is where the user works until a saved key names their Constructor.
  assert.equal(config.baseUrl, "https://constructor.app");
  assert.equal(config.baseUrlFixed, false);
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

/** A Constructor that refuses every key. */
async function refusing() {
  const server = createServer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("setup checks the key with the user's Constructor and the desk's server, and requests go to the server when it accepts the key", async () => {
  const f = await platform();
  const port = new URL(f.config.baseUrl).port;
  // Two origins, one Constructor: the user opens it as localhost, the desk names 127.0.0.1.
  const home = `http://localhost:${port}`;
  const server = f.config.baseUrl;
  const no = await refusing();
  try {
    const both = await routeKey(home, server, f.config.apiPath, KEY, {
      checkHome: true,
    });
    assert.deepEqual(both, {
      origin: server,
      result: "ok",
      home: "ok",
      server: "ok",
    });
    // Only the desk's server accepts the key: still accepted, and it is used.
    const onlyServer = await routeKey(no.url, server, f.config.apiPath, KEY, {
      checkHome: true,
    });
    assert.equal(onlyServer.result, "ok");
    assert.equal(onlyServer.origin, server);
    assert.equal(onlyServer.home, "rejected");
    // The desk's server refuses it: the user's Constructor is used.
    const onlyHome = await routeKey(home, no.url, f.config.apiPath, KEY, {
      checkHome: true,
    });
    assert.deepEqual(onlyHome, {
      origin: home,
      result: "ok",
      home: "ok",
      server: "rejected",
    });
    const neither = await routeKey(no.url, no.url, f.config.apiPath, KEY, {
      checkHome: true,
    });
    assert.equal(neither.result, "rejected");
    // Outside a desk nothing is asked.
    assert.deepEqual(await routeKey(home, undefined, f.config.apiPath, KEY), {
      origin: home,
      result: undefined,
      home: undefined,
      server: undefined,
    });
  } finally {
    await no.close();
    await f.close();
  }
});

test("inside a desk whose server differs from the key's Constructor, the MCP works through the server and keeps the user's address for links and key help", async () => {
  const f = await platform();
  const port = new URL(f.config.baseUrl).port;
  const home = `http://localhost:${port}`;
  const keyFile = join(f.dir, "home-key.json");
  await saveKeyFile(keyFile, home, KEY);
  const env = {
    ...ENV,
    HOME: f.dir,
    ROLOS_PROJECT_ID: P,
    ROLOS_DESK_ID: D,
    ROLOS_API_SERVER: f.config.baseUrl,
    CONSTRUCTOR_KEY_FILE: keyFile,
    CONSTRUCTOR_STATE_DIR: f.config.stateDir,
  };
  const api = new PlatformApi(configFromEnv(env));
  await api.refresh();
  assert.equal(api.config.baseUrl, home);
  f.db.hosts.length = 0;
  await api.request("GET", "/projects");
  // One check of the key with the desk's server, then the request, both there.
  assert.deepEqual(f.db.hosts, ["127.0.0.1", "127.0.0.1"]);
  await api.request("GET", "/projects");
  assert.equal(f.db.hosts.length, 3, "the answer is kept for the same key");
  assert.match(api.keyHelp(), new RegExp(`set-key ${home}`));

  // A desk server that refuses the key: requests go to the user's Constructor.
  const no = await refusing();
  try {
    const api2 = new PlatformApi(
      configFromEnv({ ...env, ROLOS_API_SERVER: no.url }),
    );
    await api2.refresh();
    f.db.hosts.length = 0;
    await api2.request("GET", "/projects");
    assert.deepEqual(f.db.hosts, ["localhost"]);
  } finally {
    await no.close();
  }

  // Through the MCP: desk links from either address work, and the desk is the default.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      ...env,
      CONSTRUCTOR_READINESS_SECONDS: "0",
      CONSTRUCTOR_UPLOAD_SETTLE_SECONDS: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "desk-server", version: "1.0.0" });
  try {
    await client.connect(transport);
    f.db.hosts.length = 0;
    const here: any = await client.callTool({
      name: "list_images",
      arguments: {},
    });
    assert.equal(
      here.isError,
      undefined,
      JSON.stringify(here.structuredContent),
    );
    assert.deepEqual([...new Set(f.db.hosts)], ["127.0.0.1"]);
    for (const origin of [home, f.config.baseUrl]) {
      const r: any = await client.callTool({
        name: "list_images",
        arguments: {
          desk_url: `${origin}/research/projects/${P}/desks/${D}/viewer/file`,
        },
      });
      assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent));
    }
    const foreign: any = await client.callTool({
      name: "list_images",
      arguments: {
        desk_url: `https://acme.constructor.app/research/projects/${P}/desks/${D}`,
      },
    });
    assert.equal(foreign.structuredContent.status, "wrong_environment");
  } finally {
    await client.close();
    await f.close();
  }
});

test("inside a desk, the key the desk provides is used without a key from the user and saved for the wait command", async () => {
  const f = await platform();
  const { readFile, stat } = await import("node:fs/promises");
  const keyFile = join(f.dir, "desk-key.json");
  const env = {
    ...ENV,
    HOME: f.dir,
    ROLOS_PROJECT_ID: P,
    ROLOS_DESK_ID: D,
    ROLOS_API_SERVER: f.config.baseUrl,
    CONSTRUCTOR_KEY_FILE: keyFile,
    CONSTRUCTOR_ACCESS_KEY: KEY,
  };
  const saved = async () => JSON.parse(await readFile(keyFile, "utf8"));
  try {
    // No key saved: the desk's key works and is saved, marked as the desk's, readable only by the user.
    const api = new PlatformApi(configFromEnv(env));
    await api.refresh();
    f.db.keys.length = 0;
    await api.request("GET", "/projects");
    assert.deepEqual(await saved(), {
      url: f.config.baseUrl,
      key: KEY,
      source: "desk",
    });
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    await api.request("GET", "/projects");
    assert.equal(f.db.keys.length, 3, "one check, then only the requests");

    // The wait command's shell may drop CONSTRUCTOR_ACCESS_KEY (Codex drops *KEY*): the copy works.
    const { CONSTRUCTOR_ACCESS_KEY: _, ...shell } = env;
    const wait = new PlatformApi(configFromEnv(shell));
    await wait.refresh();
    await wait.request("GET", "/projects");

    // The desk gets a new key: the desk's copy is replaced.
    f.db.key = "rk-renewed-desk-key-0001";
    const renewed = new PlatformApi(
      configFromEnv({ ...env, CONSTRUCTOR_ACCESS_KEY: f.db.key }),
    );
    await renewed.refresh();
    await renewed.request("GET", "/projects");
    assert.equal((await saved()).key, f.db.key);

    // A key the user saved is never replaced; the desk's key is used while Constructor accepts it…
    await saveKeyFile(keyFile, f.config.baseUrl, "rk-users-own-key-0002");
    const both = new PlatformApi(
      configFromEnv({ ...env, CONSTRUCTOR_ACCESS_KEY: f.db.key }),
    );
    await both.refresh();
    f.db.keys.length = 0;
    await both.request("GET", "/projects");
    assert.deepEqual(f.db.keys, [`Bearer ${f.db.key}`, `Bearer ${f.db.key}`]);
    assert.equal((await saved()).key, "rk-users-own-key-0002");
    assert.equal((await saved()).source, undefined);

    // …and the user's takes over when Constructor rejects the desk's.
    f.db.key = "rk-users-own-key-0002";
    const revoked = new PlatformApi(
      configFromEnv({
        ...env,
        CONSTRUCTOR_ACCESS_KEY: "rk-revoked-desk-key-03",
      }),
    );
    await revoked.refresh();
    await revoked.request("GET", "/projects");
    assert.equal(f.db.keys.at(-1), "Bearer rk-users-own-key-0002");

    // A rejected desk key and nothing saved: needs_key, with the way to save one.
    await rm(keyFile);
    await assert.rejects(
      () => revoked.request("GET", "/projects"),
      (e: any) =>
        e.code === "needs_key" &&
        /rejected the access key this desk provides/.test(e.message) &&
        /set-key/.test(e.message) &&
        !e.message.includes("rk-revoked"),
    );

    // Revoked mid-session: the next call checks again and uses the user's key.
    await saveKeyFile(keyFile, f.config.baseUrl, "rk-users-own-key-0002");
    f.db.key = "rk-desk-key-later-revoked";
    const later = new PlatformApi(
      configFromEnv({ ...env, CONSTRUCTOR_ACCESS_KEY: f.db.key }),
    );
    await later.refresh();
    await later.request("GET", "/projects");
    f.db.key = "rk-users-own-key-0002";
    await assert.rejects(
      () => later.request("GET", "/projects"),
      (e: any) => e.code === "needs_key",
    );
    await later.request("GET", "/projects");
    assert.equal(f.db.keys.at(-1), "Bearer rk-users-own-key-0002");

    // Outside a desk, CONSTRUCTOR_ACCESS_KEY is the user's setting: nothing is saved.
    await rm(keyFile);
    const outside = new PlatformApi(
      configFromEnv({
        HOME: f.dir,
        CONSTRUCTOR_BASE_URL: f.config.baseUrl,
        CONSTRUCTOR_KEY_FILE: keyFile,
        CONSTRUCTOR_ACCESS_KEY: f.db.key,
      }),
    );
    await outside.refresh();
    await outside.request("GET", "/projects");
    await assert.rejects(() => readFile(keyFile));
  } finally {
    await f.close();
  }
});
