import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { platform, finish, P, A, D, H, I } from "./platform.js";
import { DeploymentEngine } from "../src/deployment.js";
import { StateStore } from "../src/store.js";
const imageService = {
  name: "web",
  image_id: I,
  ports: [{ number: 5000, expose_to_internet: true }],
};

test("deploy reuses images, selects default hardware, starts and checks the public URL", async () => {
  const f = await platform();
  try {
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    assert.equal(r.status, "started");
    assert.equal(r.readiness, "http_ok");
    assert.equal(f.db.images.length, 1);
    const sv = f.db.applications[0].services[0];
    assert.equal(sv.hardware_configuration_id, H);
    assert.equal(sv.status, "running");
    assert.equal(r.services[0].public_url, `https://${sv.id}.constructor.pro`);
    assert.equal(
      r.services[0].internal_addresses[0].address,
      "svc-web.app-c98ddaf7.svc.cluster.local:5000",
    );
  } finally {
    await f.close();
  }
});

test("new project creates disk and pauses for upload; checkpoint resumes in a new engine without duplicates", async () => {
  const f = await platform();
  try {
    f.db.projects = [];
    f.db.desks = [];
    let r = await finish(
      f.engine,
      await f.engine.deploy({
        application_name: "new-app",
        services: [
          {
            name: "web",
            build: { dockerfile: "/Dockerfile" },
            ports: imageService.ports,
          },
        ],
      }),
    );
    assert.equal(r.status, "needs_upload");
    assert.equal(r.project_id, P);
    assert.equal(r.upload_targets[0].desk_id, D);
    assert.equal(f.db.images.length, 1);
    const saved = await stat(
      join(f.config.stateDir, `${r.deployment_id}.json`),
    );
    assert.equal(saved.mode & 0o777, 0o600);
    const engine = new DeploymentEngine(f.api, new StateStore(f.config));
    r = await engine.get({
      deployment_id: r.deployment_id,
      files_uploaded: true,
    });
    for (let i = 0; i < 5 && !f.db.images.some((x: any) => x.id !== I); i++)
      r = await engine.get({ deployment_id: r.deployment_id });
    const build = f.db.mutations.find(
      (x: any) => x.path === `/desks/${D}/images`,
    );
    assert.equal("ephemeral_build_disk_size_gb" in build.body, false);
    assert.equal(f.db.images.length, 2);
    f.db.images[1].build_status = "done";
    r = await finish(engine, r);
    assert.equal(r.status, "started");
    assert.equal(f.db.projects.length, 1);
    assert.equal(f.db.desks.length, 1);
  } finally {
    await f.close();
  }
});

test("failed build leaves existing app untouched and no new services are created", async () => {
  const f = await platform();
  try {
    f.db.applications = [{ id: A, name: "app", services: [] }];
    let r = await f.engine.update({
      project_id: P,
      application_id: A,
      services: [
        { name: "web", build: { desk_id: D, dockerfile: "/Dockerfile" } },
      ],
      files_uploaded: true,
    });
    for (let i = 0; i < 8 && f.db.images.length < 2; i++)
      r = await f.engine.get({ deployment_id: r.deployment_id });
    f.db.images[1].build_status = "error";
    f.db.buildStatus = "error";
    r = await finish(f.engine, r);
    assert.equal(r.status, "failed");
    assert.equal(f.db.images.length, 3, "one automatic rebuild");
    assert.match(r.message, /failed twice/);
    assert.equal(f.db.applications[0].services.length, 0);
  } finally {
    await f.close();
  }
});

test("update merges environment values and preserves unrelated settings and volume/port IDs", async () => {
  const f = await platform();
  try {
    f.db.applications = [
      {
        id: A,
        name: "app",
        services: [
          {
            id: "service1111",
            name: "web",
            image_id: I,
            hardware_configuration_id: H,
            status: "running",
            link: null,
            volumes: [
              {
                id: "volume1111",
                name: "db",
                mount_point: "/data",
                size_gb: 10,
              },
            ],
            ports: [{ id: "port1111", number: 5000, expose_to_internet: true }],
            environment_variables: [
              { id: "env1111", name: "KEEP", value: "secret-keep" },
              { id: "env2222", name: "CHANGE", value: "old" },
            ],
          },
        ],
      },
    ];
    const r = await finish(
      f.engine,
      await f.engine.update({
        project_id: P,
        application_id: A,
        services: [
          { name: "web", environment_variables: { CHANGE: "secret-new" } },
        ],
      }),
    );
    assert.equal(r.status, "started");
    const sv = f.db.applications[0].services[0];
    assert.equal(sv.volumes[0].id, "volume1111");
    assert.equal(sv.ports[0].id, "port1111");
    assert.equal(
      sv.environment_variables.find((e: any) => e.name === "KEEP").value,
      "secret-keep",
    );
    assert.equal(
      sv.environment_variables.find((e: any) => e.name === "CHANGE").id,
      "env2222",
    );
    assert.equal(
      sv.environment_variables.find((e: any) => e.name === "CHANGE").value,
      "secret-new",
    );
    assert.ok(!JSON.stringify(r).includes("secret-"));
    assert.equal(
      f.db.mutations.filter((x: any) => x.path === `/services/service1111/stop`)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("dependencies and environment references resolve internal addresses in order", async () => {
  const f = await platform();
  try {
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "stack",
        services: [
          {
            ...imageService,
            environment_variables: {
              API: { service: "api", port: 3000, scheme: "http" },
              TEMPORAL: { service: "api", port: 3000 },
            },
          },
          {
            name: "api",
            image_id: I,
            ports: [{ number: 3000, expose_to_internet: false }],
          },
        ],
      }),
    );
    assert.equal(r.status, "started");
    assert.deepEqual(
      f.db.applications[0].services.map((s: any) => s.name),
      ["api", "web"],
    );
    assert.equal(
      f.db.applications[0].services[1].environment_variables[0].value,
      "http://svc-api.app-c98ddaf7.svc.cluster.local:3000",
    );
    assert.equal(
      f.db.applications[0].services[1].environment_variables[1].value,
      "svc-api.app-c98ddaf7.svc.cluster.local:3000",
      "no scheme gives a bare host:port",
    );
  } finally {
    await f.close();
  }
});

test("invalid dependency or unknown image fails before any mutation", async () => {
  const f = await platform();
  try {
    await assert.rejects(
      f.engine.deploy({
        project_id: P,
        application_name: "bad",
        services: [{ ...imageService, depends_on: ["absent"] }],
      }),
    );
    assert.equal(f.db.mutations.length, 0);
    await assert.rejects(
      f.engine.deploy({
        project_id: P,
        application_name: "bad",
        services: [{ ...imageService, image_id: "unknown1" }],
      }),
    );
    assert.equal(f.db.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test("missing cookie pauses operation, replacement resumes; repeated request_id does not duplicate", async () => {
  const f = await platform();
  try {
    await unlink(f.config.cookieFile);
    const input = {
      project_id: P,
      application_name: "web",
      services: [imageService],
      request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    let r = await f.engine.deploy(input);
    assert.equal(r.status, "needs_auth");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(f.config.cookieFile, "ap_access_token=renewed");
    r = await finish(f.engine, await f.engine.deploy(input));
    assert.equal(r.status, "started");
    await f.engine.deploy(input);
    assert.equal(f.db.applications.length, 1);
    assert.ok(
      !(
        await readFile(
          join(f.config.stateDir, `${r.deployment_id}.json`),
          "utf8",
        )
      ).includes("renewed"),
    );
  } finally {
    await f.close();
  }
});

test("standalone image build is idempotent by request_id and listing returns native statuses", async () => {
  const f = await platform();
  try {
    const input = {
      project_id: P,
      desk_id: D,
      name: "new-image",
      dockerfile: "/Dockerfile",
      request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const r = await f.engine.buildImage(input);
    assert.equal(r.status, "building");
    await f.engine.buildImage(input);
    assert.equal(f.db.images.length, 2);
    const list = await f.engine.listImages({ project_id: P, desk_id: D });
    assert.equal(list.results[1].build_status, "in_progress");
    f.db.images[1].build_status = "done";
    assert.equal(
      (await f.engine.get({ deployment_id: r.deployment_id })).status,
      "built",
    );
  } finally {
    await f.close();
  }
});

test("start/stop selected services and reject names outside the app before mutation", async () => {
  const f = await platform();
  try {
    await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    const stopped = await finish(
      f.engine,
      await f.engine.lifecycle("stop", {
        project_id: P,
        application_id: A,
        service_names: ["web"],
      }),
    );
    assert.equal(stopped.status, "stopped");
    const n = f.db.mutations.length;
    await assert.rejects(
      f.engine.lifecycle("start", {
        project_id: P,
        application_id: A,
        service_names: ["missing"],
      }),
    );
    assert.equal(f.db.mutations.length, n);
    const started = await finish(
      f.engine,
      await f.engine.lifecycle("start", { project_id: P, application_id: A }),
    );
    assert.equal(started.status, "started");
  } finally {
    await f.close();
  }
});

test("uncertain mutation checkpoint never repeats a create after restart", async () => {
  const f = await platform();
  try {
    let r = await f.engine.deploy({
      project_id: P,
      application_name: "web",
      services: [imageService],
    });
    const op = (await f.store.load(r.deployment_id))!;
    op.pending = { method: "POST", path: `/applications/${A}/services` };
    await f.store.save(op);
    const n = f.db.mutations.length;
    r = await f.engine.get({ deployment_id: op.id });
    assert.equal(r.status, "needs_reconciliation");
    await f.engine.get({ deployment_id: op.id });
    assert.equal(f.db.mutations.length, n);
  } finally {
    await f.close();
  }
});

test("checkpoint endpoint binding and lock prevent cross-host resume or overlapping mutations", async () => {
  const f = await platform();
  try {
    const r = await f.engine.deploy({
      project_id: P,
      application_name: "web",
      services: [imageService],
    });
    await assert.rejects(
      new StateStore({
        ...f.config,
        baseUrl: "https://other.constructor.app",
      }).load(r.deployment_id),
      (e: any) => e.code === "endpoint_mismatch",
    );
    await f.store.exclusive(async () => {
      await assert.rejects(
        f.store.exclusive(async () => undefined),
        (e: any) => e.code === "busy",
      );
    });
  } finally {
    await f.close();
  }
});

test("resume=false observes without mutation; dependency cycles fail before project creation", async () => {
  const f = await platform();
  try {
    const r = await f.engine.deploy({
      project_id: P,
      application_name: "web",
      services: [imageService],
    });
    const n = f.db.mutations.length;
    await f.engine.get({ deployment_id: r.deployment_id, resume: false });
    assert.equal(f.db.mutations.length, n);
    await assert.rejects(
      f.engine.deploy({
        application_name: "cycle",
        services: [
          {
            name: "one",
            build: { dockerfile: "/Dockerfile" },
            depends_on: ["two"],
          },
          {
            name: "two",
            build: { dockerfile: "/Dockerfile" },
            depends_on: ["one"],
          },
        ],
      }),
    );
    assert.equal(f.db.mutations.length, n);
  } finally {
    await f.close();
  }
});

test("removing or changing a volume asks once before wiping its data", async () => {
  const f = await platform();
  try {
    f.db.applications = [
      {
        id: A,
        name: "app",
        services: [
          {
            id: "service1111",
            name: "web",
            image_id: I,
            hardware_configuration_id: H,
            status: "running",
            link: null,
            ports: [{ id: "port1111", number: 5000, expose_to_internet: true }],
            volumes: [
              {
                id: "volume1111",
                name: "db",
                mount_point: "/data",
                size_gb: 10,
              },
              {
                id: "volume2222",
                name: "cache",
                mount_point: "/cache",
                size_gb: 10,
              },
            ],
            environment_variables: [],
          },
        ],
      },
    ];
    const n = f.db.mutations.length;
    const change = {
      project_id: P,
      application_id: A,
      services: [
        {
          name: "web",
          volumes: [{ name: "db", mount_point: "/data", size_gb: 20 }],
        },
      ],
    };
    const ask = await f.engine.update(change);
    assert.equal(ask.status, "confirm_required");
    assert.deepEqual(ask.volumes_to_wipe, [
      "web: db (/data) changed",
      "web: cache (/cache) removed",
    ]);
    assert.equal(f.db.mutations.length, n, "nothing changed before approval");

    const keep = await finish(
      f.engine,
      await f.engine.update({
        project_id: P,
        application_id: A,
        services: [{ name: "web", environment_variables: { A: "1" } }],
      }),
    );
    assert.equal(keep.status, "started", "omitting volumes keeps them");

    const ok = await finish(
      f.engine,
      await f.engine.update({ ...change, confirm_volume_wipe: true }),
    );
    assert.equal(ok.status, "started");
    assert.equal(f.db.applications[0].services[0].volumes.length, 1);
  } finally {
    await f.close();
  }
});

test("a volume cannot be shared between services", async () => {
  const f = await platform();
  try {
    const n = f.db.mutations.length;
    const data = { name: "data", mount_point: "/data", size_gb: 10 };
    await assert.rejects(
      f.engine.deploy({
        project_id: P,
        application_name: "shared",
        services: [
          { ...imageService, volumes: [data] },
          { name: "worker", image_id: I, volumes: [data] },
        ],
      }),
      /already mounted on web; a volume belongs to one service/,
    );
    assert.equal(f.db.mutations.length, n);
  } finally {
    await f.close();
  }
});

test("application inspection returns native failed status without claiming readiness", async () => {
  const f = await platform();
  try {
    await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    const sv = f.db.applications[0].services[0];
    sv.status = "failed";
    const r = await f.engine.get({ project_id: P, application_id: A });
    assert.equal(r.services[0].status, "failed");
    assert.equal(r.readiness, "unverified");
  } finally {
    await f.close();
  }
});

test("multiple requested names cannot target the same existing service ID", async () => {
  const f = await platform();
  try {
    f.db.applications = [
      {
        id: A,
        name: "app",
        services: [
          {
            id: "service1111",
            name: "one",
            image_id: I,
            hardware_configuration_id: H,
            status: "stopped",
            ports: [],
            volumes: [],
            environment_variables: [],
          },
        ],
      },
    ];
    await assert.rejects(
      f.engine.update({
        project_id: P,
        application_id: A,
        services: [
          { name: "one", service_id: "service1111" },
          { name: "two", service_id: "service1111" },
        ],
      }),
    );
    assert.equal(f.db.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test("DNS-valid constructor service name is not mistaken for an inherited checkpoint", async () => {
  const f = await platform();
  try {
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [{ ...imageService, name: "constructor" }],
      }),
    );
    assert.equal(r.status, "started");
    assert.equal(f.db.applications[0].services[0].image_id, I);
  } finally {
    await f.close();
  }
});

test("default hardware excludes configurations marked not_available", async () => {
  const f = await platform();
  try {
    f.db.hardware = [
      {
        id: "nohw1111",
        cpu_count: 0.5,
        ram_gb: 1,
        gpu: null,
        removed: false,
        availability: { status: "not_available" },
      },
      {
        id: H,
        cpu_count: 1,
        ram_gb: 4,
        gpu: null,
        removed: false,
        availability: { status: "high" },
      },
    ];
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    assert.equal(r.status, "started");
    assert.equal(f.db.applications[0].services[0].hardware_configuration_id, H);
  } finally {
    await f.close();
  }
});

test("an upload resume does not invalidate the original request_id", async () => {
  const f = await platform();
  try {
    const input = {
      project_id: P,
      application_name: "web",
      services: [
        { name: "web", build: { desk_id: D, dockerfile: "/Dockerfile" } },
      ],
      request_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    let r = await finish(f.engine, await f.engine.deploy(input));
    assert.equal(r.status, "needs_upload");
    await f.engine.get({
      deployment_id: r.deployment_id,
      files_uploaded: true,
    });
    r = await f.engine.deploy(input);
    assert.notEqual(r.status, "needs_upload");
  } finally {
    await f.close();
  }
});

test("observation mode cannot change upload confirmation", async () => {
  const f = await platform();
  try {
    const r = await f.engine.deploy({
      project_id: P,
      application_name: "web",
      services: [imageService],
    });
    await assert.rejects(
      f.engine.get({
        deployment_id: r.deployment_id,
        resume: false,
        files_uploaded: true,
      }),
    );
  } finally {
    await f.close();
  }
});

test("start waits for a stopping service before sending another start request", async () => {
  const f = await platform();
  try {
    await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    const sv = f.db.applications[0].services[0];
    sv.status = "stopping";
    const n = f.db.mutations.length;
    let r = await f.engine.lifecycle("start", {
      project_id: P,
      application_id: A,
    });
    assert.equal(r.status, "waiting");
    assert.equal(f.db.mutations.length, n);
    sv.status = "stopped";
    r = await finish(f.engine, r);
    assert.equal(r.status, "started");
  } finally {
    await f.close();
  }
});

test("stale lock is not automatically stolen by competing harnesses", async () => {
  const f = await platform();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(f.config.stateDir, { recursive: true });
    await writeFile(join(f.config.stateDir, ".lock"), "999999999");
    await assert.rejects(
      f.store.exclusive(async () => undefined),
      (e: any) => e.code === "busy",
    );
    assert.equal(
      await readFile(join(f.config.stateDir, ".lock"), "utf8"),
      "999999999",
    );
  } finally {
    await f.close();
  }
});

test("malformed successful create response requires reconciliation rather than duplicate creation", async () => {
  const f = await platform();
  try {
    f.db.badCreateReply = true;
    let r = await f.engine.buildImage({
      project_id: P,
      desk_id: D,
      name: "new-image",
      dockerfile: "/Dockerfile",
    });
    assert.equal(r.status, "needs_reconciliation");
    assert.equal(f.db.images.length, 2);
    r = await f.engine.get({ deployment_id: r.deployment_id });
    assert.equal(r.status, "needs_reconciliation");
    assert.equal(f.db.images.length, 2);
  } finally {
    await f.close();
  }
});

test("mixed explicit-ID and name targets cannot resolve to the same service", async () => {
  const f = await platform();
  try {
    f.db.applications = [
      {
        id: A,
        name: "app",
        services: [
          {
            id: "service1111",
            name: "web",
            image_id: I,
            hardware_configuration_id: H,
            status: "running",
            ports: [],
            volumes: [],
            environment_variables: [],
          },
        ],
      },
    ];
    await assert.rejects(
      f.engine.update({
        project_id: P,
        application_id: A,
        services: [
          { name: "renamed", service_id: "service1111" },
          { name: "web" },
        ],
      }),
    );
    assert.equal(f.db.mutations.length, 0);
    assert.equal(f.db.applications[0].services[0].status, "running");
  } finally {
    await f.close();
  }
});

test("hardware: default without asking, minimums pick the smallest fit, options hide names and IDs", async () => {
  const f = await platform();
  try {
    const hw = (
      id: string,
      cpu: number,
      ram: number,
      gpu: any = null,
      status = "high",
    ) => ({
      id,
      name: `secret-name-${id}`,
      cpu_count: cpu,
      ram_gb: ram,
      gpu,
      removed: false,
      availability: { status },
    });
    f.db.hardware = [
      hw("big11111", 16, 64),
      hw(H, 1, 4),
      hw("mid11111", 2, 16),
      hw("gpu11111", 4, 50, { name: "Nvidia A40" }),
      hw("gone1111", 2, 8, null, "not_available"),
    ];
    const view: any = await f.engine.get({ project_id: P });
    assert.deepEqual(view.hardware_options, [
      { cpu: 1, ram_gb: 4, gpu: null },
      { cpu: 2, ram_gb: 16, gpu: null },
      { cpu: 16, ram_gb: 64, gpu: null },
      { cpu: 4, ram_gb: 50, gpu: "Nvidia A40" },
    ]);
    assert.ok(!/secret-name|11111/.test(JSON.stringify(view.hardware_options)));
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [
          { ...imageService, name: "plain" },
          { ...imageService, name: "model", hardware: { ram_gb: 10 } },
          { ...imageService, name: "train", hardware: { gpu: true } },
        ],
      }),
    );
    assert.equal(r.status, "started");
    const byName = (n: string) =>
      f.db.applications[0].services.find((s: any) => s.name === n)
        .hardware_configuration_id;
    assert.equal(byName("plain"), H);
    assert.equal(byName("model"), "mid11111");
    assert.equal(byName("train"), "gpu11111");
    await assert.rejects(
      f.engine.deploy({
        project_id: P,
        application_name: "web2",
        services: [
          { ...imageService, name: "huge", hardware: { ram_gb: 500 } },
        ],
      }),
      /No available hardware meets.*Options/,
    );
  } finally {
    await f.close();
  }
});

test("every build gets its own UI-style image name", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
  try {
    f.db.images.push({
      id: "old11111",
      name: "web-v3",
      desk_id: D,
      project_id: P,
      build_status: "done",
    });
    f.db.images.push({
      id: "old22222",
      name: "calc",
      desk_id: D,
      project_id: P,
      build_status: "done",
    });
    await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "app",
        files_uploaded: true,
        services: [
          { name: "web", build: { desk_id: D, dockerfile: "/Dockerfile" } },
          { name: "api", build: { desk_id: D, dockerfile: "/api/Dockerfile" } },
        ],
      }),
    );
    const names = f.db.images.map((i: any) => i.name);
    assert.ok(names.includes("web-v4"), names.join());
    assert.ok(names.includes("api-v1"), names.join());
    const built = async (name: string) => {
      const r = await f.engine.buildImage({
        project_id: P,
        desk_id: D,
        dockerfile: "/Dockerfile",
        name,
      });
      await finish(f.engine, r);
      return f.db.images.at(-1).name;
    };
    assert.equal(await built("calc"), "calc-v1");
    assert.equal(await built("calc"), "calc-v2");
    assert.equal(await built("fresh"), "fresh");
    assert.equal(
      new Set(f.db.images.map((i: any) => i.name)).size,
      f.db.images.length,
    );
  } finally {
    await f.close();
  }
});

test("a build error is confirmed on a second look, rebuilt once under a new name, and can recover", async () => {
  const f = await platform();
  try {
    const deploy = await f.engine.deploy({
      project_id: P,
      application_name: "app",
      files_uploaded: true,
      services: [
        { name: "web", build: { desk_id: D, dockerfile: "/Dockerfile" } },
      ],
    });
    let r: any = deploy;
    for (
      let i = 0;
      i < 8 && !f.db.images.some((x: any) => x.name === "web-v1");
      i++
    )
      r = await f.engine.get({ deployment_id: deploy.deployment_id });
    const first = f.db.images.find((x: any) => x.name === "web-v1");
    first.build_status = "error";
    r = await f.engine.get({ deployment_id: deploy.deployment_id });
    assert.equal(r.status, "building", "one error sighting is not a failure");
    first.build_status = "in_progress";
    r = await f.engine.get({ deployment_id: deploy.deployment_id });
    first.build_status = "error";
    r = await f.engine.get({ deployment_id: deploy.deployment_id });
    assert.equal(
      r.status,
      "building",
      "a flip back to in_progress resets the count",
    );
    r = await f.engine.get({ deployment_id: deploy.deployment_id });
    assert.equal(r.build_retried.web, "web-v1");
    f.db.buildStatus = "done";
    r = await finish(f.engine, r);
    assert.equal(r.status, "started");
    assert.ok(
      f.db.images.some(
        (x: any) => x.name === "web-v2" && x.build_status === "done",
      ),
    );
  } finally {
    await f.close();
  }
});

test("readiness reports not_responding when the public URL does not answer in time", async () => {
  const f = await platform();
  try {
    f.db.probeStatus = 502;
    f.config.readinessSeconds = 0.001;
    const r = await finish(
      f.engine,
      await f.engine.deploy({
        project_id: P,
        application_name: "web",
        services: [imageService],
      }),
    );
    assert.equal(r.status, "started");
    assert.equal(r.readiness, "not_responding");
    assert.match(
      r.message,
      /did not answer.*web printed nothing.*127\.0\.0\.1/,
    );
    assert.equal(r.readiness_checks.web.status, 502);
  } finally {
    await f.close();
  }
});
