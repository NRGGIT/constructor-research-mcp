import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { PlatformApi } from "../src/api.js";
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

test("configuration defaults to constructor.app and rejects insecure remote hosts", () => {
  assert.equal(configFromEnv({}).baseUrl, "https://constructor.app");
  assert.equal(configFromEnv({}).baseUrlFixed, false);
  assert.equal(
    configFromEnv({
      CONSTRUCTOR_BASE_URL: "https://learn.constructor.university",
    }).baseUrlFixed,
    true,
  );
  assert.equal(configFromEnv({}).apiPath, "/api/platform-account");
  assert.throws(() =>
    configFromEnv({ CONSTRUCTOR_BASE_URL: "http://example.com" }),
  );
});

test("API reloads cookie file per request; never follows redirects; hides error bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-api-"));
  const cookieFile = join(dir, "cookie");
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
    res.end(JSON.stringify({ cookie: req.headers.cookie }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const api = new PlatformApi({
    baseUrl: `http://127.0.0.1:${port}`,
    apiPath: "/api",
    cookieFile,
    stateDir: dir,
    requestTimeoutMs: 1000,
  });
  try {
    await assert.rejects(
      api.request("GET", "/test"),
      (e: any) => e.code === "needs_auth",
    );
    await writeFile(
      cookieFile,
      "ap_access_token=one\n\nBASE_URL=https://unused",
    );
    assert.deepEqual(await api.request("GET", "/test"), {
      cookie: "ap_access_token=one",
    });
    await writeFile(cookieFile, "Cookie: ap_access_token=two");
    assert.deepEqual(await api.request("GET", "/test"), {
      cookie: "ap_access_token=two",
    });
    await assert.rejects(
      api.request("GET", "/redirect"),
      (e: any) => e.code === "api_error" && e.status === 302,
    );
    await assert.rejects(
      api.request("GET", "/auth"),
      (e: any) => e.code === "needs_auth" && !e.message.includes("SECRET"),
    );
    await assert.rejects(
      api.request("PATCH", "/error", {}),
      (e: any) =>
        e.code === "api_error" &&
        e.apiCode === 123 &&
        !e.message.includes("SECRET"),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server error after a mutation is treated as uncertain, without exposing its body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-uncertain-"));
  const cookieFile = join(dir, "cookie");
  await writeFile(cookieFile, "ap_access_token=test");
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"details":{"msg":"SECRET"}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = new PlatformApi({
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    apiPath: "/api",
    cookieFile,
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
  const cookieFile = join(dir, "cookie");
  await writeFile(cookieFile, "ap_access_token=test");
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
    cookieFile,
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
