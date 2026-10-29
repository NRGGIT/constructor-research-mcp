import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { platform, P, D } from "./platform.js";
import { DeploymentRuntime } from "../src/runtime.js";
import { LogFollower, KEEP } from "../src/logs.js";

const two = (n: number) => String(n).padStart(2, "0");
const line = (n: number) =>
  `2026-10-28T17:${two(Math.floor(n / 60))}:${two(n % 60)}.123456789Z step ${n}`;
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("condition not reached");
    await delay(10);
  }
}

test("a build log keeps only its last lines, survives a dropped stream without duplicates, and stays readable after the build", async () => {
  const f = await platform();
  try {
    const id = "build0001";
    f.db.log(id, ...Array.from({ length: 120 }, (_, n) => line(n)));
    let r = await f.logs.tail(id, "build", 20);
    assert.equal(r.state, "live");
    assert.equal(r.lines.length, 20);
    assert.match(r.lines.at(-1)!, /step 119$/);

    f.db.cutLogs(id); // A proxy drops the connection; the build goes on.
    await eventually(() => f.db.logRequests >= 2);
    f.db.log(id, line(120));
    await eventually(
      async () =>
        (await f.logs.peek(id, "build", 50))?.lines
          .at(-1)
          ?.endsWith("step 120") ?? false,
    );
    r = (await f.logs.peek(id, "build", 50))!;
    assert.equal(r.lines.length, KEEP);
    assert.equal(new Set(r.lines).size, KEEP, "replayed lines are skipped");

    f.db.endLog(id);
    await eventually(
      async () => (await f.logs.tail(id, "build", 10)).state === "finished",
    );
    const requests = f.db.logRequests;
    r = await f.logs.tail(id, "build", 10);
    assert.deepEqual([r.state, r.lines.length], ["finished", 10]);
    assert.match(r.lines.at(-1)!, /step 120$/);
    assert.equal(
      f.db.logRequests,
      requests,
      "a finished build is not reopened",
    );

    // Another process (or a restarted MCP) reads the kept lines from disk.
    const other = new LogFollower(f.api);
    r = await other.tail(id, "build", 10);
    assert.deepEqual([r.state, r.lines.length], ["finished", 10]);
    await other.close();
  } finally {
    await f.close();
  }
});

test("a build that is not running and was never followed has no log", async () => {
  const f = await platform();
  try {
    const r = await f.logs.tail("gone0001", "build", 20);
    assert.equal(r.state, "unavailable");
    assert.deepEqual(r.lines, []);
    assert.match(r.message!, /only during the build/);
  } finally {
    await f.close();
  }
});

test("a service log shows what its current container prints", async () => {
  const f = await platform();
  try {
    const id = "svc00001";
    f.db.serviceLogs.add(id);
    f.db.log(id, "printed before anyone listened");
    let r = await f.logs.tail(id, "service", 20, 200);
    assert.equal(r.state, "live");
    assert.deepEqual(r.lines, []);
    f.db.log(id, "listening on 0.0.0.0:3000");
    await eventually(
      async () => (await f.logs.tail(id, "service", 20)).lines.length === 1,
    );
    r = await f.logs.tail(id, "service", 20);
    assert.deepEqual(r.lines, ["listening on 0.0.0.0:3000"]);
    assert.match(r.message!, /current container/);
  } finally {
    await f.close();
  }
});

test("a failed build reports the last log lines in failure.log_tail", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    const r = await runtime.deploy({
      project_id: P,
      application_name: "stack",
      files_uploaded: true,
      wait_seconds: 0,
      services: [
        { name: "web", build: { desk_id: D, dockerfile: "/web/Dockerfile" } },
      ],
    });
    await eventually(() => f.db.images.length === 2);
    let image = f.db.images.at(-1);
    f.db.log(
      image.id,
      line(1),
      `${line(2).slice(0, 31)}error: cannot find crate`,
    );
    await eventually(() => f.db.logRequests > 0);
    await delay(50);
    // The first failure is rebuilt once; the second one fails the deployment.
    image.build_status = "error";
    f.db.endLog(image.id);
    await eventually(() => f.db.images.length === 3);
    image = f.db.images.at(-1);
    f.db.log(image.id, line(3), `${line(4).slice(0, 31)}error: still broken`);
    await eventually(() => f.db.logRequests > 2);
    await delay(50);
    image.build_status = "error";
    f.db.endLog(image.id);
    const done = await runtime.get({
      deployment_id: r.deployment_id,
      wait_seconds: 5,
    });
    assert.equal(done.status, "failed");
    assert.match(done.failure.log_tail.at(-1), /error: still broken/);
    assert.match(done.message, /failure\.log_tail/);
  } finally {
    await runtime.close();
    await f.close();
  }
});

const at = (n: number, text = "") =>
  `2026-10-29T13:${two(Math.floor(n / 60))}:${two(n % 60)}.000000001Z${text ? " " + text : ""}`;

test("lines that are only a timestamp are dropped, and a reconnect does not repeat them", async () => {
  const f = await platform();
  try {
    const id = "build0002";
    f.db.log(id, at(1), at(2), at(3, "npm ci"), at(4));
    await f.logs.tail(id, "build", 20);
    f.db.cutLogs(id); // the replay sends the bare timestamps again
    await eventually(() => f.db.logRequests >= 2);
    f.db.log(id, at(5, "vite build"));
    await eventually(
      async () =>
        (await f.logs.peek(id, "build", 20))?.lines
          .at(-1)
          ?.endsWith("vite build") ?? false,
    );
    const r = (await f.logs.peek(id, "build", 20))!;
    assert.deepEqual(r.lines, [at(3, "npm ci"), at(5, "vite build")]);
  } finally {
    await f.close();
  }
});

test("a restarted container is marked, counted and keeps the lines of the one before", async () => {
  const f = await platform();
  try {
    const id = "svc00002";
    f.db.log(
      id,
      "Container is waiting to start...",
      "Container is waiting to start...",
      "Container is waiting to start...",
      at(10, "Server started on port 8080"),
    );
    let r = await f.logs.tail(id, "service", 20);
    assert.deepEqual(r.lines, [
      "Container is waiting to start... (×3)",
      at(10, "Server started on port 8080"),
    ]);

    // A proxy drops the stream of the same container: nothing restarted.
    f.db.cutLogs(id);
    await eventually(() => f.db.logRequests >= 2);
    f.db.log(id, at(11, "loading room"));
    await eventually(
      async () =>
        (await f.logs.peek(id, "service", 20))?.lines
          .at(-1)
          ?.endsWith("loading room") ?? false,
    );
    r = (await f.logs.peek(id, "service", 20))!;
    assert.equal(r.restarts_seen, undefined);
    assert.equal(r.lines.length, 3);

    // The container crashes; a new one starts and the stream reopens on it.
    f.db.log(id, at(12, "Error: SQLITE_CANTOPEN"));
    await eventually(
      async () =>
        (await f.logs.peek(id, "service", 20))?.lines
          .at(-1)
          ?.includes("SQLITE") ?? false,
    );
    f.db.restartContainer(
      id,
      "Container is waiting to start...",
      at(20, "Server started on port 8080"),
    );
    await eventually(
      async () => (await f.logs.peek(id, "service", 20))?.restarts_seen === 1,
    );
    await eventually(
      async () =>
        (await f.logs.peek(id, "service", 20))?.lines
          .at(-1)
          ?.includes("Server started") ?? false,
    );
    r = (await f.logs.tail(id, "service", 20))!;
    assert.deepEqual(r.lines.slice(-4), [
      at(12, "Error: SQLITE_CANTOPEN"),
      "--- new container (restart 1) ---",
      "Container is waiting to start...",
      at(20, "Server started on port 8080"),
    ]);
    assert.deepEqual(r.restarted_at, [at(20).trim()]);
    assert.match(r.message!, /restarted 1 time while the MCP followed it/);

    // A restart on the open stream: the platform's waiting line follows the container's lines.
    f.db.log(
      id,
      "Container is waiting to start...",
      at(30, "Server started on port 8080"),
    );
    await eventually(
      async () => (await f.logs.peek(id, "service", 20))?.restarts_seen === 2,
    );
  } finally {
    await f.close();
  }
});
