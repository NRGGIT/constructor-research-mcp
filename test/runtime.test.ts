import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { platform, P, D, I } from "./platform.js";
import { DeploymentRuntime } from "../src/runtime.js";

async function eventually(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      assert.fail("Background operation did not reach expected state");
    await delay(10);
  }
}

test("one whole-app request completes in the background and resolves public URLs without progress calls", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.buildStatus = "done";
    const result = await runtime.deploy({
      project_id: P,
      application_name: "stack",
      files_uploaded: true,
      wait_seconds: 0,
      services: [
        {
          name: "frontend",
          build: { desk_id: D, dockerfile: "/frontend/Dockerfile" },
          ports: [{ number: 3000, expose_to_internet: true }],
          environment_variables: {
            API_URL: { service: "backend", exposure: "public" },
          },
        },
        {
          name: "backend",
          build: { desk_id: D, dockerfile: "/backend/Dockerfile" },
          ports: [{ number: 8080, expose_to_internet: true }],
        },
      ],
    });
    assert.match(result.deployment_id, /^[0-9a-f-]{36}$/);
    await eventually(
      () =>
        f.db.applications[0]?.services.length === 2 &&
        f.db.applications[0].services.every((s: any) => s.status === "running"),
    );
    const app = f.db.applications[0];
    const backend = app.services.find((s: any) => s.name === "backend");
    const frontend = app.services.find((s: any) => s.name === "frontend");
    assert.equal(
      frontend.environment_variables[0].value,
      `https://${backend.id}.constructor.pro`,
    );
    const final = await runtime.get({
      deployment_id: result.deployment_id,
      wait_seconds: 1,
    });
    assert.equal(final.status, "started");
    assert.equal(f.db.images.length, 3);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("build failure names source and asks to check logs; image replacement resumes the same deployment", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    const input = {
      project_id: P,
      application_name: "stack",
      files_uploaded: true,
      wait_seconds: 0,
      services: [
        {
          name: "frontend",
          build: { desk_id: D, dockerfile: "/frontend/Dockerfile" },
          environment_variables: { KEEP: "keep-me", CHANGE: "old" },
        },
        {
          name: "backend",
          build: { desk_id: D, dockerfile: "/backend/Dockerfile" },
        },
      ],
    };
    let r = await runtime.deploy(input);
    await eventually(() => f.db.images.length === 3);
    f.db.buildStatus = "error";
    f.db.images.find(
      (x: any) => x.dockerfile === "/frontend/Dockerfile",
    ).build_status = "error";
    f.db.images.find(
      (x: any) => x.dockerfile === "/backend/Dockerfile",
    ).build_status = "done";
    r = await runtime.get({ deployment_id: r.deployment_id, wait_seconds: 2 });
    assert.equal(r.status, "failed");
    assert.equal(r.failure.service, "frontend");
    assert.equal(r.failure.dockerfile, "/frontend/Dockerfile");
    assert.match(
      r.message,
      /No build log was captured.*rebuild .*\/frontend\/Dockerfile from the UI/,
    );
    assert.match(r.failure.desk_link, /\/research\/projects\/.+\/desks\//);
    assert.ok(r.failure.first_image_name && r.failure.image_name);
    assert.notEqual(r.failure.first_image_name, r.failure.image_name);
    assert.equal(f.db.applications.length, 0);
    const id = r.deployment_id;
    r = await runtime.deploy({
      deployment_id: id,
      services: [
        {
          name: "frontend",
          image_id: I,
          environment_variables: { CHANGE: "new" },
        },
      ],
      wait_seconds: 3,
    });
    assert.equal(r.deployment_id, id);
    assert.equal(r.status, "started");
    assert.equal(f.db.images.length, 4);
    assert.equal(
      f.db.applications[0].services
        .find((s: any) => s.name === "frontend")
        .environment_variables.find((e: any) => e.name === "KEEP")?.value,
      "keep-me",
    );
    assert.equal(
      f.db.applications[0].services
        .find((s: any) => s.name === "frontend")
        .environment_variables.find((e: any) => e.name === "CHANGE")?.value,
      "new",
    );
    assert.equal(
      f.db.applications[0].services.find((s: any) => s.name === "backend")
        .image_id,
      f.db.images.find((x: any) => x.dockerfile === "/backend/Dockerfile").id,
    );
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("status waits until completion and resume=false never triggers remote mutations", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    const r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [{ name: "web", image_id: I }],
      wait_seconds: 3,
    });
    assert.equal(r.status, "started");
    const n = f.db.mutations.length;
    const view = await runtime.get({
      deployment_id: r.deployment_id,
      resume: false,
      wait_seconds: 0,
    });
    assert.equal(view.status, "started");
    assert.equal(f.db.mutations.length, n);
    const stopped = await runtime.lifecycle("stop", {
      project_id: P,
      application_id: r.application_id,
      wait_seconds: 3,
    });
    assert.equal(stopped.status, "stopped");
    assert.equal(f.db.applications[0].services[0].status, "stopped");
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("unfinished operation recovers on server startup and credentials can resume after replacement", async () => {
  const f = await platform();
  let runtime = new DeploymentRuntime(f.engine, 20);
  try {
    let r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      files_uploaded: true,
      services: [
        { name: "web", build: { desk_id: D, dockerfile: "/Dockerfile" } },
      ],
      wait_seconds: 0,
    });
    await eventually(() => f.db.images.length === 2);
    await runtime.close();
    f.db.images[1].build_status = "done";
    runtime = new DeploymentRuntime(f.engine, 20);
    await runtime.recover();
    r = await runtime.get({ deployment_id: r.deployment_id, wait_seconds: 3 });
    assert.equal(r.status, "started");
    assert.equal(f.db.images.length, 2);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("legacy terminal checkpoints hydrate service details without performing mutations", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    let r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [
        {
          name: "web",
          image_id: I,
          ports: [{ number: 5000, expose_to_internet: true }],
        },
      ],
      wait_seconds: 3,
    });
    await runtime.close();
    const op = (await f.store.load(r.deployment_id))!;
    delete op.result;
    await f.store.save(op);
    const observer = new DeploymentRuntime(f.engine, 20);
    try {
      const n = f.db.mutations.length;
      r = await observer.get({ deployment_id: r.deployment_id, resume: false });
      assert.equal(r.services[0].name, "web");
      assert.match(r.services[0].public_url, /constructor.pro/);
      assert.equal(f.db.mutations.length, n);
    } finally {
      await observer.close();
    }
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("service start failures report exact stage and service with check-logs instruction", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.errorPath = "/services/service1000/start";
    const r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [{ name: "web", image_id: I }],
      wait_seconds: 3,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.failure.stage, "start");
    assert.equal(r.failure.service, "web");
    assert.match(r.message, /check.*logs.*Constructor/i);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("checking a paused deployment after cookie replacement waits for the resumed execution", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.auth = false;
    let r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [{ name: "web", image_id: I }],
      wait_seconds: 0,
    });
    assert.equal(r.status, "needs_auth");
    f.db.auth = true;
    r = await runtime.get({ deployment_id: r.deployment_id, wait_seconds: 3 });
    assert.equal(r.status, "started");
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("optional descriptive retry keys work and internal IDs are generated automatically", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.buildStatus = "done";
    const input = {
      project_id: P,
      desk_id: D,
      name: "image",
      dockerfile: "/Dockerfile",
      request_id: "subfinder-new-backend",
      wait_seconds: 3,
    };
    const a = await runtime.buildImage(input);
    const b = await runtime.buildImage(input);
    assert.match(a.deployment_id, /^[0-9a-f-]{36}$/);
    assert.equal(a.deployment_id, b.deployment_id);
    assert.equal(f.db.images.length, 2);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("failure context identifies a later service, not the first service in the request", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.errorPath = "/services/service1001/start";
    const r = await runtime.deploy({
      project_id: P,
      application_name: "stack",
      services: [
        { name: "backend", image_id: I },
        { name: "frontend", image_id: I },
      ],
      wait_seconds: 3,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.failure.stage, "start");
    assert.equal(r.failure.service, "frontend");
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("observing a finished deployment refreshes native service status without changing resources", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    const r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [{ name: "web", image_id: I }],
      wait_seconds: 3,
    });
    f.db.applications[0].services[0].status = "stopped";
    const n = f.db.mutations.length;
    const latest = await runtime.get({
      deployment_id: r.deployment_id,
      resume: false,
    });
    assert.equal(latest.status, "started");
    assert.equal(latest.services[0].status, "stopped");
    assert.equal(f.db.mutations.length, n);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("get_deployment reports the readiness result of a finished deployment", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    let r = await runtime.deploy({
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
    });
    for (let n = 0; n < 10 && r.status !== "started"; n++)
      r = await runtime.get({
        deployment_id: r.deployment_id,
        wait_seconds: 2,
      });
    assert.equal(r.status, "started");
    assert.equal(r.readiness, "http_ok");
    assert.match(r.message, /public URL answers.*HTTP 200/);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("readiness comes from the checkpoint even when the cached result is older", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    let r = await runtime.deploy({
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
    });
    for (let n = 0; n < 10 && r.status !== "started"; n++)
      r = await runtime.get({
        deployment_id: r.deployment_id,
        wait_seconds: 2,
      });
    const op = (await f.store.load(r.deployment_id))!;
    op.result = { ...op.result, readiness: "unverified", message: undefined };
    await f.store.save(op);
    r = await runtime.get({
      deployment_id: r.deployment_id,
      resume: false,
      wait_seconds: 0,
    });
    assert.equal(r.readiness, "http_ok");
  } finally {
    await runtime.close();
    await f.close();
  }
});

test("get_deployment lists the status changes and container restarts the MCP saw", async () => {
  const f = await platform();
  const runtime = new DeploymentRuntime(f.engine, 20);
  try {
    const r = await runtime.deploy({
      project_id: P,
      application_name: "web",
      services: [{ name: "web", image_id: I }],
      wait_seconds: 3,
    });
    const service = f.db.applications[0].services[0];
    const look = async () =>
      (await runtime.get({ deployment_id: r.deployment_id, resume: false }))
        .services[0];
    let v = await look();
    assert.equal(v.status, "running");
    f.db.log(service.id, "2026-10-29T13:00:01.000000001Z Server started");
    service.status = "starting";
    await look();
    service.status = "running";
    v = await look();
    assert.deepEqual(v.status_changes.map((c: any) => c.status).slice(-3), [
      "running",
      "starting",
      "running",
    ]);

    // The service log was followed from the first look, so a new container is seen.
    f.db.restartContainer(
      service.id,
      "2026-10-29T13:00:09.000000001Z Server started",
    );
    await eventually(() => f.logs.restarts(service.id).length === 1);
    v = await look();
    assert.equal(v.restarts_seen, 1);
  } finally {
    await runtime.close();
    await f.close();
  }
});
