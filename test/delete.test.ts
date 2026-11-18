import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { platform, P, A, D, I } from "./platform.js";

const B = "bbbb2222bbbb2222bbbb2222bbbb2222";
/** Two applications: A (web on image I with a volume, api on image I2) and B (worker on I). */
async function setup() {
  const f = await platform();
  f.db.images.push({
    id: "iiii2222",
    name: "api",
    desk_id: D,
    project_id: P,
    build_status: "done",
  });
  f.db.images.push({
    id: "iiii3333",
    name: "unused",
    desk_id: null,
    project_id: P,
    source: "external",
    reference: "nginx:1.27",
    build_status: "done",
  });
  f.db.applications.push(
    {
      id: A,
      name: "shop",
      project_id: P,
      services: [
        {
          id: "svcweb01",
          name: "web",
          image_id: I,
          status: "running",
          link: "https://svcweb01.constructor.pro",
          ports: [{ number: 80, expose_to_internet: true }],
          volumes: [{ mount_point: "/data", size_gb: 10 }],
          environment_variables: [],
        },
        {
          id: "svcapi01",
          name: "api",
          image_id: "iiii2222",
          status: "running",
          ports: [{ number: 3000, expose_to_internet: false }],
          volumes: [],
          environment_variables: [],
        },
      ],
    },
    {
      id: B,
      name: "jobs",
      project_id: P,
      services: [
        {
          id: "svcwrk01",
          name: "worker",
          image_id: I,
          status: "running",
          ports: [],
          volumes: [],
          environment_variables: [],
        },
      ],
    },
  );
  return f;
}
const deletes = (f: any) =>
  f.db.mutations
    .filter((m: any) => m.method === "DELETE")
    .map((m: any) => m.path);

test("delete_resources: lists everything first, deletes only with confirm, services before applications before images", async () => {
  const f = await setup();
  try {
    const ask = {
      project_id: P,
      application_ids: [A],
      service_ids: ["svcwrk01", "svcweb01"], // web goes with its application anyway
      image_ids: [I, "iiii2222", "iiii3333", "nope0000"],
    };
    const plan = await f.engine.deleteResources(ask);
    assert.equal(plan.status, "confirm_required");
    assert.deepEqual(deletes(f), [], "nothing deleted without confirm");
    assert.deepEqual(
      plan.delete.applications.map((a: any) => a.name),
      ["shop"],
    );
    assert.deepEqual(
      plan.delete.services.map((s: any) => s.name),
      ["worker"],
    );
    // Every service of the application and of the request is gone, so all three images go.
    assert.deepEqual(
      plan.delete.images.map((i: any) => i.image_id).sort(),
      [I, "iiii2222", "iiii3333"].sort(),
    );
    assert.match(plan.message, /shop\/web: \/data \(10 GB\)/);
    assert.match(plan.message, /ask the user once/);
    assert.deepEqual(plan.not_found, ["image nope0000"]);

    const done = await f.engine.deleteResources({ ...ask, confirm: true });
    assert.equal(done.status, "deleted", JSON.stringify(done));
    assert.deepEqual(deletes(f), [
      "/services/svcwrk01",
      `/applications/${A}`,
      `/images/${I}`,
      "/images/iiii2222",
      "/images/iiii3333",
    ]);
    assert.deepEqual(
      f.db.applications.map((a: any) => [a.id, a.services.length]),
      [[B, 0]],
    );
  } finally {
    await f.close();
  }
});

test("delete_resources: an image a remaining service uses is kept; gone and failing items are reported", async () => {
  const f = await setup();
  try {
    // Deleting only web: image I is still used by jobs/worker.
    const r = await f.engine.deleteResources({
      project_id: P,
      service_ids: ["svcweb01"],
      image_ids: [I],
      confirm: true,
    });
    assert.deepEqual(deletes(f), ["/services/svcweb01"]);
    assert.deepEqual(r.kept_in_use, [
      { image_id: I, name: "image", used_by: ["jobs/worker"] },
    ]);
    assert.match(
      r.message,
      /Kept, still used by a service that stays: image \(jobs\/worker\)/,
    );

    // Only kept images: nothing to delete.
    const none = await f.engine.deleteResources({
      project_id: P,
      image_ids: [I],
    });
    assert.equal(none.status, "nothing_to_delete");

    // Already deleted by someone else, and a refusal.
    f.db.applications[1].services = [];
    f.db.failDelete = "iiii3333";
    const plan = await f.engine.deleteResources({
      project_id: P,
      application_ids: [B],
      image_ids: ["iiii2222", "iiii3333"],
    });
    assert.equal(plan.status, "confirm_required");
    f.db.images = f.db.images.filter((i: any) => i.id !== "iiii2222");
    const partial = await f.engine.deleteResources({
      project_id: P,
      application_ids: [B],
      image_ids: ["iiii2222", "iiii3333"],
      confirm: true,
    });
    // iiii2222 vanished between the plan and the confirm: it is no longer in the project.
    assert.deepEqual(partial.not_found, ["image iiii2222"]);
    assert.equal(partial.status, "partial");
    assert.deepEqual(
      partial.results.map((x: any) => [x.kind, x.result.split(":")[0]]),
      [
        ["application", "deleted"],
        ["image", "failed"],
      ],
    );
    await assert.rejects(
      () => f.engine.deleteResources({ project_id: P }),
      /at least one/,
    );
  } finally {
    await f.close();
  }
});

test("delete_resources: unfinished deployments of the application are ended first", async () => {
  const f = await setup();
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    await f.store.save({
      id,
      kind: "update",
      endpoint: f.store.endpoint,
      input: { project_id: P, application_id: A, services: [] },
      status: "building",
      project_id: P,
      application_id: A,
      desks: {},
      images: {},
      services: {},
      applied: [],
      stopped: [],
      started: [],
      created_at: now,
      updated_at: now,
    });
    const r = await f.engine.deleteResources({
      project_id: P,
      service_ids: ["svcapi01"],
      confirm: true,
    });
    assert.deepEqual(r.ended_deployments, [id]);
    const op = await f.store.load(id);
    assert.equal(op!.status, "superseded");
    assert.match(op!.message!, /deleted/);
  } finally {
    await f.close();
  }
});

test("delete_resources is one MCP tool and takes a desk link", async () => {
  const f = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      CONSTRUCTOR_BASE_URL: f.config.baseUrl,
      CONSTRUCTOR_KEY_FILE: f.config.keyFile,
      CONSTRUCTOR_STATE_DIR: f.config.stateDir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "delete", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("delete_resources"));
    assert.match(
      client.getInstructions() ?? "",
      /Never read the key file or call Constructor's API yourself/,
    );
    const r: any = await client.callTool({
      name: "delete_resources",
      arguments: {
        desk_url: `${f.config.baseUrl}/research/projects/${P}/desks/${D}`,
        application_ids: [B],
      },
    });
    assert.equal(r.structuredContent.status, "confirm_required");
    assert.equal(r.structuredContent.delete.applications[0].name, "jobs");
  } finally {
    await client.close();
    await f.close();
  }
});
