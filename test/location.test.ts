import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { parseDeskUrl, resolveDeskUrl } from "../src/location.js";
import { platform, P, D } from "./platform.js";

const base = "https://learn.constructor.university";
const link = `${base}/research/projects/c98d546de8104a2d9968aba721fe90f2/desks/fef21248839c46188eb75dad0b5a375e/viewer/file`;

test("desk links yield project and desk IDs whatever follows the desk", () => {
  const ids = {
    project_id: "c98d546de8104a2d9968aba721fe90f2",
    desk_id: "fef21248839c46188eb75dad0b5a375e",
  };
  assert.deepEqual(parseDeskUrl(link, base), ids);
  assert.deepEqual(
    parseDeskUrl(link + "?filename=/Dockerfile&tree=desk", base),
    ids,
  );
  assert.deepEqual(
    parseDeskUrl(
      `${base}/research/projects/${ids.project_id}/desks/${ids.desk_id}`,
      base,
    ),
    ids,
  );
  assert.deepEqual(
    parseDeskUrl(
      `  ${base}/research/projects/${ids.project_id}/desks/${ids.desk_id}/vscode  `,
      base,
    ),
    ids,
  );
});

test("links from another Constructor or without a desk are rejected", () => {
  const other = link.replace(base, "https://constructor.app");
  assert.throws(
    () => parseDeskUrl(other, base),
    (e: any) =>
      e.code === "wrong_environment" &&
      /signed in to https:\/\/learn\.constructor\.university.*call sign_in with url set to this link/.test(
        e.message,
      ),
  );
  assert.throws(
    () => parseDeskUrl(other, base, true),
    (e: any) =>
      e.code === "wrong_environment" &&
      /fixed to .* by CONSTRUCTOR_BASE_URL/.test(e.message),
  );
  assert.throws(
    () =>
      parseDeskUrl(
        `${base}/research/projects/c98d546de8104a2d9968aba721fe90f2`,
        base,
      ),
    /must contain/,
  );
  assert.throws(() => parseDeskUrl("not a link", base), /not a valid link/);
});

test("explicit IDs must agree with the link; builds inherit the desk", () => {
  assert.throws(
    () =>
      resolveDeskUrl({ desk_url: link, project_id: "other1234" }, base, "desk"),
    /does not match/,
  );
  const deploy = resolveDeskUrl(
    {
      desk_url: link,
      services: [
        { name: "a", build: { dockerfile: "/Dockerfile" } },
        { name: "b", build: { desk_id: "keep1234", dockerfile: "/D" } },
        { name: "c", image_id: "image1234" },
      ],
    },
    base,
    "deploy",
  );
  assert.equal(deploy.desk_url, undefined);
  assert.equal(deploy.project_id, "c98d546de8104a2d9968aba721fe90f2");
  assert.equal(
    deploy.services[0].build.desk_id,
    "fef21248839c46188eb75dad0b5a375e",
  );
  assert.equal(deploy.services[1].build.desk_id, "keep1234");
  assert.equal(deploy.services[2].build, undefined);
  const project = resolveDeskUrl({ desk_url: link }, base, "project");
  assert.equal(project.desk_id, undefined);
});

test("stdio tools accept desk_url in place of IDs", async () => {
  const f = await platform();
  f.db.buildStatus = "done";
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
  const client = new Client({ name: "desk-url", version: "1.0.0" });
  const url = `${f.config.baseUrl}/research/projects/${P}/desks/${D}/viewer/file`;
  f.db.dav.set("Dockerfile", Buffer.from("FROM python:3.12\nEXPOSE 8000\n"));
  try {
    await client.connect(transport);
    const folder: any = await client.callTool({
      name: "create_folder",
      arguments: { desk_url: url, path: "src" },
    });
    assert.equal(folder.structuredContent.status, "created");
    assert.equal(f.db.dav.get("src"), null);
    const list: any = await client.callTool({
      name: "list_files",
      arguments: { desk_url: url },
    });
    assert.deepEqual(
      list.structuredContent.entries.map((e: any) => e.path),
      ["Dockerfile", "src"],
    );
    const images: any = await client.callTool({
      name: "list_images",
      arguments: { desk_url: url },
    });
    assert.equal(images.isError, undefined);
    const missing: any = await client.callTool({
      name: "list_files",
      arguments: {},
    });
    assert.equal(missing.isError, true);
    const foreign: any = await client.callTool({
      name: "list_files",
      arguments: { desk_url: link },
    });
    assert.equal(foreign.structuredContent.status, "wrong_environment");
    const deploy: any = await client.callTool({
      name: "deploy_app",
      arguments: {
        desk_url: url,
        application_name: "stack",
        files_uploaded: true,
        wait_seconds: 0,
        services: [{ name: "web", build: { dockerfile: "/Dockerfile" } }],
      },
    });
    assert.equal(deploy.isError, undefined);
    const deadline = Date.now() + 3000;
    while (!f.db.images.some((i: any) => i.dockerfile === "/Dockerfile")) {
      if (Date.now() > deadline) assert.fail("build was not submitted");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      f.db.images.find((i: any) => i.dockerfile === "/Dockerfile").desk_id,
      D,
    );
    assert.ok(
      !f.db.mutations.some(
        (m: any) => m.method === "POST" && m.path === `/projects/${P}/desks`,
      ),
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test("get_deployment without arguments maps deployment-enabled projects to apps and services", async () => {
  const f = await platform();
  try {
    f.db.projects.push({
      id: "other1234",
      name: "notebooks only",
      deployment_enabled: false,
      status: "active",
    });
    f.db.applications.push({
      id: "daf773193e204ea783e70c07f4b97cbc",
      name: "stack",
      project_id: P,
      services: [
        {
          id: "svc11111",
          name: "web",
          status: "running",
          image_id: "image1234",
          ports: [{ number: 8080, expose_to_internet: true }],
          environment_variables: [{ name: "TOKEN", value: "SECRET" }],
        },
        { id: "svc22222", name: "db", status: "stopped", ports: [] },
      ],
    });
    const map: any = await f.engine.get({});
    assert.match(
      map.summary,
      /^1 of 2 projects have deployment enabled; 1 applications, 2 services/,
    );
    assert.deepEqual(map.projects_without_deployment, ["notebooks only"]);
    const [project] = map.projects;
    assert.equal(project.project_id, P);
    const [app] = project.applications;
    assert.equal(app.application_name, "stack");
    assert.deepEqual(
      app.services.map((s: any) => [s.service_name, s.status, s.public_url]),
      [
        ["web", "running", "https://svc11111.constructor.pro"],
        ["db", "stopped", null],
      ],
    );
    assert.deepEqual(app.services[0].ports, [{ number: 8080, public: true }]);
    assert.ok(!JSON.stringify(map).includes("SECRET"));
    assert.ok(
      !f.db.requests.some((r: any) => r.path.startsWith("/projects/other1234")),
    );
  } finally {
    await f.close();
  }
});
