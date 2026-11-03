import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { PlatformApi, cleanKey } from "../src/api.js";
import { saveKeyFile } from "../src/key.js";
import { buildInput, deployInput } from "../src/schemas.js";
import { configFromEnv } from "../src/config.js";

test("build storage is omitted by default and overrides enforce 10–1000 GB", () => {
  const input = {
    project_id: "abcd1234",
    desk_id: "abcd5678",
    dockerfile: "/Dockerfile",
    name: "web",
  };
  assert.equal(buildInput.parse(input).ephemeral_build_disk_size_gb, undefined);
  for (const n of [0, 1, 9, 1001])
    assert.equal(
      buildInput.safeParse({ ...input, ephemeral_build_disk_size_gb: n })
        .success,
      false,
    );
  for (const n of [10, 50, 1000])
    assert.equal(
      buildInput.safeParse({ ...input, ephemeral_build_disk_size_gb: n })
        .success,
      true,
    );
});

test("ports reject invalid numbers and more than one public port", () => {
  const input = {
    application_name: "web",
    services: [
      {
        name: "web",
        image_id: "abcd1234",
        ports: [{ number: 5000, expose_to_internet: true }],
      },
    ],
  };
  assert.equal(deployInput.safeParse(input).success, true);
  for (const n of [0, 65536, 1.5])
    assert.equal(
      deployInput.safeParse({
        ...input,
        services: [
          {
            ...input.services[0],
            ports: [{ number: n, expose_to_internet: false }],
          },
        ],
      }).success,
      false,
    );
  assert.equal(
    deployInput.safeParse({
      ...input,
      services: [
        {
          ...input.services[0],
          ports: [
            input.services[0].ports[0],
            { number: 5001, expose_to_internet: true },
          ],
        },
      ],
    }).success,
    false,
  );
});

test("configuration defaults to constructor.app and the public API, and rejects insecure remote hosts", () => {
  assert.equal(configFromEnv({}).baseUrl, "https://constructor.app");
  assert.equal(configFromEnv({}).baseUrlFixed, false);
  assert.equal(
    configFromEnv({
      CONSTRUCTOR_BASE_URL: "https://acme.constructor.app",
    }).baseUrlFixed,
    true,
  );
  assert.equal(configFromEnv({}).apiPath, "/api/platform-account/v1");
  assert.equal(configFromEnv({}).accessKey, undefined);
  assert.equal(
    configFromEnv({ CONSTRUCTOR_ACCESS_KEY: " rk-abc12345 " }).accessKey,
    "rk-abc12345",
  );
  assert.match(
    configFromEnv({}).keyFile,
    /\.config\/constructor-research\/access-key\.json$/,
  );
  assert.throws(() =>
    configFromEnv({ CONSTRUCTOR_BASE_URL: "http://example.com" }),
  );
});

test("a key is accepted with or without Bearer, and nothing that could not travel in a header", () => {
  assert.equal(cleanKey("rk-abc12345"), "rk-abc12345");
  assert.equal(cleanKey("Bearer rk-abc12345\n"), "rk-abc12345");
  for (const bad of [
    undefined,
    "",
    "short",
    "rk-abc 12345",
    "rk-abc\r\nX: y",
    "rk-ключ12345",
  ])
    assert.equal(cleanKey(bad), undefined, String(bad));
});

const KEY = "rk-secret-key-123456";
test("API sends only the key, reads the key file per request, never follows redirects, hides error bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-api-"));
  const keyFile = join(dir, "access-key.json");
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/redirect")) {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    if (req.url?.endsWith("/error")) {
      res.writeHead(421, { "content-type": "application/json" });
      res.end(JSON.stringify({ details: { msg: "SECRET", error_code: 123 } }));
      return;
    }
    if (req.url?.endsWith("/auth")) {
      res.writeHead(401);
      res.end("SECRET");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        key: req.headers["x-research-accesskey"],
        cookie: req.headers.cookie,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const api = new PlatformApi({
    baseUrl,
    apiPath: "/api",
    keyFile,
    stateDir: dir,
    requestTimeoutMs: 1000,
  });
  const leaks = (e: any) =>
    !e.message.includes("SECRET") && !e.message.includes(KEY);
  try {
    await assert.rejects(
      api.request("GET", "/test"),
      (e: any) => e.code === "needs_key" && /set-key/.test(e.message),
    );
    await writeFile(keyFile, "not json " + KEY);
    await assert.rejects(
      api.request("GET", "/test"),
      (e: any) => e.code === "needs_key" && leaks(e),
    );
    // A key saved for another Constructor is never sent here.
    await saveKeyFile(keyFile, "https://other.constructor.app", KEY);
    await assert.rejects(
      api.request("GET", "/test"),
      (e: any) =>
        e.code === "needs_key" &&
        e.message.includes("other.constructor.app") &&
        leaks(e),
    );
    await saveKeyFile(keyFile, baseUrl, KEY);
    assert.deepEqual(await api.request("GET", "/test"), {
      key: `Bearer ${KEY}`,
    });
    await saveKeyFile(keyFile, baseUrl, "Bearer rk-second-key-0000");
    assert.deepEqual(await api.request("GET", "/test"), {
      key: "Bearer rk-second-key-0000",
    });
    await assert.rejects(
      api.request("GET", "/redirect"),
      (e: any) => e.code === "api_error" && e.status === 302,
    );
    await assert.rejects(
      api.request("GET", "/auth"),
      (e: any) => e.code === "needs_key" && e.status === 401 && leaks(e),
    );
    await assert.rejects(
      api.request("PATCH", "/error", {}),
      (e: any) => e.code === "api_error" && e.apiCode === 123 && leaks(e),
    );
    // CONSTRUCTOR_ACCESS_KEY wins over the file.
    const fromEnv = new PlatformApi({ ...api.config, accessKey: KEY });
    assert.deepEqual(await fromEnv.request("GET", "/test"), {
      key: `Bearer ${KEY}`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("without CONSTRUCTOR_BASE_URL the MCP works with the Constructor the saved key belongs to", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-refresh-"));
  const keyFile = join(dir, "access-key.json");
  const api = new PlatformApi({
    baseUrl: "https://constructor.app",
    apiPath: "/api",
    keyFile,
    stateDir: dir,
    requestTimeoutMs: 1000,
  });
  try {
    await api.refresh();
    assert.equal(api.config.baseUrl, "https://constructor.app");
    await saveKeyFile(keyFile, "https://acme.constructor.app/projects/x", KEY);
    await api.refresh();
    assert.equal(api.config.baseUrl, "https://acme.constructor.app");
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    const fixed = new PlatformApi({
      ...api.config,
      baseUrl: "https://test.example",
      baseUrlFixed: true,
    });
    await fixed.refresh();
    assert.equal(fixed.config.baseUrl, "https://test.example");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server error after a mutation is treated as uncertain, without exposing its body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-uncertain-"));
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"details":{"msg":"SECRET"}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = new PlatformApi({
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    apiPath: "/api",
    accessKey: KEY,
    keyFile: join(dir, "unused.json"),
    stateDir: dir,
    requestTimeoutMs: 1000,
  });
  try {
    await assert.rejects(
      api.request("POST", "/create", {}),
      (e: any) =>
        e.code === "uncertain_outcome" && !e.message.includes("SECRET"),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("call budget prevents a slow API from exceeding the MCP operation deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-budget-"));
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 300);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = new PlatformApi({
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    apiPath: "/api",
    accessKey: KEY,
    keyFile: join(dir, "unused.json"),
    stateDir: dir,
    requestTimeoutMs: 1000,
  });
  try {
    const start = Date.now();
    await assert.rejects(
      api.withBudget(30, () => api.request("GET", "/slow")),
      (e: any) => e.code === "connection_error",
    );
    assert.ok(Date.now() - start < 250);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
