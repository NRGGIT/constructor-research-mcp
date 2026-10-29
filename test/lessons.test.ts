import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, finish, P, A, D, I } from "./platform.js";
import { FileManager, lintDockerfile } from "../src/files.js";
import { DeploymentRuntime } from "../src/runtime.js";

// Lessons from the constructor-grants rollout (28 Oct 2026): entrypoints that lost their
// exec bit, compose-style fallbacks, a stale lock, and a redeploy racing an older one.

const exec = (dockerfile: string) =>
  lintDockerfile("Dockerfile", dockerfile, [8080]).filter((w) =>
    /never made executable/.test(w),
  );

test("lint: an entrypoint script copied from the context needs a chmod", () => {
  const base = "FROM nginx\nEXPOSE 8080\n";
  assert.match(
    exec(
      base +
        'COPY docker-entrypoint.sh /docker-entrypoint-grants.sh\nENTRYPOINT ["/docker-entrypoint-grants.sh"]\n',
    )[0],
    /\/docker-entrypoint-grants\.sh is run.*RUN chmod 0755/,
  );
  // Copied into a folder, or with the whole context.
  assert.equal(
    exec(
      base +
        "COPY start.sh /usr/local/bin/\nENTRYPOINT /usr/local/bin/start.sh\n",
    ).length,
    1,
  );
  assert.equal(
    exec(base + 'COPY . /app\nCMD ["/app/run.sh", "serve"]\n').length,
    1,
  );
  // A broad chmod of other folders does not count (the grants frontend had one).
  assert.equal(
    exec(
      base +
        'COPY e.sh /e.sh\nRUN chmod -R g+w /etc/nginx/conf.d\nENTRYPOINT ["/e.sh"]\n',
    ).length,
    1,
  );
  // Fixed, run through a shell, or from the base image: nothing to say.
  for (const ok of [
    'COPY e.sh /e.sh\nRUN chmod 0755 /e.sh\nENTRYPOINT ["/e.sh"]\n',
    'COPY --chmod=0755 e.sh /e.sh\nENTRYPOINT ["/e.sh"]\n',
    'COPY e.sh /e.sh\nENTRYPOINT ["sh", "/e.sh"]\n',
    'COPY bin/ /bin/\nRUN chmod +x /bin/*.sh\nENTRYPOINT ["/bin/e.sh"]\n',
    'ENTRYPOINT ["/docker-entrypoint.sh"]\n',
    'COPY --from=build /out/e.sh /e.sh\nENTRYPOINT ["/e.sh"]\n',
  ])
    assert.deepEqual(exec(base + ok), [], ok);
});

test("lint: compose-style default hosts in ENV are flagged, real addresses are not", () => {
  const w = lintDockerfile(
    "Dockerfile",
    "FROM rust\nEXPOSE 8087\nENV DATA_DIR=/data \\\n    BIND_ADDR=0.0.0.0:8087 \\\n    CERBOS_URL=http://cerbos:3592 \\\n    TEMPORAL_ADDRESS=temporal:7233\n",
    [8087],
  );
  assert.equal(w.length, 1);
  assert.match(w[0], /cerbos:3592, temporal:7233 works only in docker-compose/);
  for (const ok of [
    "ENV T=svc-temporal.app-a36f63a8.svc.cluster.local:7233\n",
    "ARG BASE=node:22-alpine\n",
    "ENV NODE_VERSION=22 PORT=8087\n",
    "ENV DB=postgres://db.example.com:5432/app\n",
  ])
    assert.deepEqual(
      lintDockerfile("Dockerfile", "FROM x\nEXPOSE 8087\n" + ok, [8087]),
      [],
      ok,
    );
});

test("preflight reads copied nginx configs and flags listen [::]", async () => {
  const f = await platform();
  try {
    f.db.dav.set("web", null);
    f.db.dav.set(
      "web/Dockerfile",
      Buffer.from(
        "FROM nginx\nEXPOSE 8080\nCOPY nginx.conf.template /etc/nginx/templates/default.conf.template\nCOPY other.conf /etc/nginx/conf.d/\n",
      ),
    );
    f.db.dav.set(
      "web/nginx.conf.template",
      Buffer.from("server {\n  listen 8080;\n  listen [::]:8080;\n}\n"),
    );
    f.db.dav.set("web/other.conf", Buffer.from("server { listen 8081; }\n"));
    const r = await new FileManager(f.api, f.engine).preflight(P, [
      {
        service: "web",
        desk_id: D,
        dockerfile: "/web/Dockerfile",
        ports: [8080],
      },
    ]);
    assert.deepEqual(r.missing, []);
    assert.equal(r.warnings.length, 1);
    assert.match(
      r.warnings[0],
      /web: nginx\.conf\.template has "listen \[::\]"/,
    );
  } finally {
    await f.close();
  }
});

test("a lock left by a dead process is broken; a live holder still blocks", async () => {
  const f = await platform();
  try {
    const lock = join(f.config.stateDir, ".lock");
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    await f.store.exclusive(async () => {}); // creates the state folder
    await writeFile(lock, JSON.stringify({ pid: dead, token: "x" }));
    assert.equal(await f.store.exclusive(async () => "ran"), "ran");
    await assert.rejects(readFile(lock), /ENOENT/);

    await writeFile(lock, JSON.stringify({ pid: process.ppid, token: "x" }));
    await assert.rejects(
      f.store.exclusive(async () => {}),
      (e: any) => e.code === "busy" && !/manually/.test(e.message),
    );
    // Not written by this server: left alone.
    await writeFile(lock, "garbage");
    await assert.rejects(
      f.store.exclusive(async () => {}),
      /busy|holds/,
    );
  } finally {
    await f.close();
  }
});

test("a public URL that does not answer names the services that printed nothing and what to check", async () => {
  const f = await platform();
  try {
    f.db.probeStatus = 503;
    f.config.readinessSeconds = 0.3;
    let r = await f.engine.deploy({
      project_id: P,
      application_name: "web",
      services: [
        imageService("web", true),
        imageService("api", false),
        imageService("db", false),
      ],
    });
    // db prints its startup; web and api never get that far.
    const logged = new Set<string>();
    for (let i = 0; i < 40 && r.status !== "started"; i++) {
      const db = f.db.applications[0]?.services.find(
        (s: any) => s.name === "db",
      );
      if (db && !logged.has(db.id)) {
        f.db.log(
          db.id,
          "2026-10-28T15:32:38.873482581Z listening on 0.0.0.0:7233",
        );
        logged.add(db.id);
      }
      await new Promise((r) => setTimeout(r, 25));
      r = await f.engine.get({ deployment_id: r.deployment_id, resume: true });
    }
    assert.equal(r.status, "started");
    assert.equal(r.readiness, "not_responding");
    assert.match(r.message, /web, api printed nothing since starting/);
    assert.match(
      r.message,
      /\(1\) the ENTRYPOINT\/CMD script is not executable/,
    );
    assert.doesNotMatch(r.message, /db printed/);
  } finally {
    await f.close();
  }
});

test("a new update ends the unfinished deployment of the same application", async () => {
  const f = await platform();
  const mcp = new DeploymentRuntime(f.engine, 20);
  try {
    f.db.applications = [{ id: A, name: "app", services: [] }];
    const build = (name: string) => ({
      name,
      build: { desk_id: D, dockerfile: `/${name}/Dockerfile` },
    });
    const first = await mcp.update({
      project_id: P,
      application_id: A,
      files_uploaded: true,
      wait_seconds: 0,
      services: [build("web"), build("api")],
    });
    assert.equal(first.status, "building");
    const second = await mcp.update({
      project_id: P,
      application_id: A,
      files_uploaded: true,
      wait_seconds: 0,
      services: [build("web")],
    });
    assert.deepEqual(second.replaced, [
      { deployment_id: first.deployment_id, services_not_included: ["api"] },
    ]);
    assert.match(second.message, /its changes to api are not applied/);
    const old = await mcp.get({ deployment_id: first.deployment_id });
    assert.equal(old.status, "superseded");
    assert.match(
      old.message,
      new RegExp(`Replaced by deployment ${second.deployment_id}`),
    );

    f.db.buildStatus = "done";
    for (const image of f.db.images) image.build_status = "done";
    const done = await mcp.get({
      deployment_id: second.deployment_id,
      wait_seconds: 5,
    });
    assert.equal(done.status, "started");
    // Only the newer deployment configured services.
    assert.deepEqual(
      f.db.applications[0].services.map((s: any) => s.name),
      ["web"],
    );
    // A different application is not touched.
    assert.equal((await f.store.load(second.deployment_id))!.status, "started");
  } finally {
    await mcp.close();
    await f.close();
  }
});

function imageService(name: string, open: boolean) {
  return {
    name,
    image_id: I,
    ports: [{ number: 5000, expose_to_internet: open }],
  };
}
