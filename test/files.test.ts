import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { FileManager, dockerignore } from "../src/files.js";
import { platform, P, D } from "./platform.js";

async function setup() {
  const f = await platform();
  const files = new FileManager(f.api, f.engine);
  const src = join(f.dir, "src");
  await mkdir(join(src, "app/static"), { recursive: true });
  await mkdir(join(src, ".git"), { recursive: true });
  await mkdir(join(src, "node_modules/x"), { recursive: true });
  await mkdir(join(src, "empty"), { recursive: true });
  await writeFile(join(src, "Dockerfile"), "FROM python:3.12\n");
  await writeFile(join(src, "app/main.py"), "print('hi')\n");
  await writeFile(join(src, "app/static/blank.txt"), "");
  await writeFile(join(src, "app/data.log"), "skip me");
  await writeFile(join(src, ".git/HEAD"), "ref");
  await writeFile(join(src, "node_modules/x/i.js"), "x");
  await writeFile(join(src, ".env"), "SECRET=1");
  return { ...f, files, src };
}
const sync = (x: any, extra: any = { dry_run: true }) =>
  x.files.sync({
    project_id: P,
    desk_id: D,
    local_path: x.src,
    exclude: ["*.log"],
    ...extra,
  });
const writes = (db: any) =>
  db.davRequests.filter((r: any) => !["PROPFIND", "GET"].includes(r.method));

test("dry run plans new files and folders without writing", async () => {
  const x = await setup();
  try {
    const plan = await sync(x, { dry_run: true });
    assert.equal(plan.status, "planned");
    assert.deepEqual(plan.new_files.sort(), [
      "Dockerfile",
      "app/main.py",
      "app/static/blank.txt",
    ]);
    assert.deepEqual(plan.folders_to_create, ["app", "empty", "app/static"]);
    assert.equal(writes(x.db).length, 0);
  } finally {
    await x.close();
  }
});

test("sync uploads exact content, skips excluded files, and is idempotent", async () => {
  const x = await setup();
  try {
    const big = randomBytes(9 * 1024 * 1024 + 123);
    await writeFile(join(x.src, "app/model.bin"), big);
    const done = await sync(x, { dry_run: false });
    assert.equal(done.status, "synced");
    assert.equal(done.uploaded.length, 4);
    const fs = x.db.dav;
    assert.equal(fs.get("Dockerfile").toString(), "FROM python:3.12\n");
    assert.equal(fs.get("app/static/blank.txt").length, 0);
    assert.ok(fs.get("app/model.bin").equals(big));
    assert.equal(fs.get("empty"), null);
    for (const k of fs.keys())
      assert.ok(!/\.git|node_modules|\.env|\.log/.test(k), k);
    assert.ok(![...fs.keys()].some((k) => k.includes("mcp-upload-")));
    x.db.davRequests.length = 0;
    const again = await sync(x, { dry_run: false });
    assert.equal(again.status, "synced");
    assert.equal(again.unchanged_count, 4);
    assert.equal(writes(x.db).filter((r: any) => r.method === "PUT").length, 0);
  } finally {
    await x.close();
  }
});

test("changed files are detected by checksum and replaced without stale bytes", async () => {
  const x = await setup();
  try {
    await sync(x, { dry_run: false });
    await writeFile(join(x.src, "Dockerfile"), "FROM python:3.13\n");
    const shorter = randomBytes(5 * 1024 * 1024);
    x.db.dav.set("app/main.py", randomBytes(12 * 1024 * 1024));
    await writeFile(join(x.src, "app/main.py"), shorter);
    const plan = await sync(x, { dry_run: false });
    assert.equal(plan.status, "confirm_required");
    assert.deepEqual(plan.changed_files.sort(), ["Dockerfile", "app/main.py"]);
    assert.deepEqual(plan.folders_to_create, []);
    assert.equal(x.db.dav.get("Dockerfile").toString(), "FROM python:3.12\n");
    const done = await sync(x, { dry_run: false, confirm: true });
    assert.equal(done.status, "synced");
    assert.equal(x.db.dav.get("Dockerfile").toString(), "FROM python:3.13\n");
    assert.ok(x.db.dav.get("app/main.py").equals(shorter));
  } finally {
    await x.close();
  }
});

test("type conflicts are reported and left untouched", async () => {
  const x = await setup();
  try {
    x.db.dav.set("Dockerfile", null);
    x.db.dav.set("app", Buffer.from("a file"));
    const done = await sync(x, { dry_run: false });
    assert.equal(done.status, "partial");
    assert.equal(done.conflicts.length, 4);
    assert.equal(x.db.dav.get("Dockerfile"), null);
    assert.equal(x.db.dav.get("app").toString(), "a file");
  } finally {
    await x.close();
  }
});

test("sync into a new nested folder creates its ancestors; single files keep their name", async () => {
  const x = await setup();
  try {
    x.db.dav.set("deploy", null);
    const target = {
      local_path: join(x.src, "Dockerfile"),
      remote_path: "deploy/web/v1",
    };
    const plan = await sync(x, { ...target, dry_run: true });
    assert.deepEqual(plan.folders_to_create, ["deploy/web", "deploy/web/v1"]);
    const done = await sync(x, { ...target, dry_run: false });
    assert.equal(done.status, "synced");
    assert.equal(
      x.db.dav.get("deploy/web/v1/Dockerfile").toString(),
      "FROM python:3.12\n",
    );
  } finally {
    await x.close();
  }
});

test("stale temp uploads are removed before applying", async () => {
  const x = await setup();
  try {
    x.db.dav.set(".rolos-temp", null);
    x.db.dav.set(".rolos-temp/mcp-upload-old", Buffer.from("x"));
    x.db.dav.set(".rolos-temp/ui-upload", Buffer.from("keep"));
    await sync(x, { dry_run: false });
    assert.equal(x.db.dav.has(".rolos-temp/mcp-upload-old"), false);
    assert.equal(x.db.dav.has(".rolos-temp/ui-upload"), true);
  } finally {
    await x.close();
  }
});

test("list_files walks folders level by level and hides the staging folder", async () => {
  const x = await setup();
  try {
    await sync(x, { dry_run: false });
    const top = await x.files.list({ project_id: P, desk_id: D });
    assert.deepEqual(top.entries.map((e: any) => e.path).sort(), [
      "Dockerfile",
      "app",
      "empty",
    ]);
    const all = await x.files.list({
      project_id: P,
      desk_id: D,
      recursive: true,
    });
    assert.ok(all.entries.some((e: any) => e.path === "app/static/blank.txt"));
    assert.ok(!x.db.davRequests.some((r: any) => r.path === "infinity"));
    const few = await x.files.list({
      project_id: P,
      desk_id: D,
      recursive: true,
      max_entries: 2,
    });
    assert.equal(few.truncated, true);
    await assert.rejects(
      x.files.list({ project_id: P, desk_id: D, path: "missing" }),
      /does not exist/,
    );
    await assert.rejects(
      x.files.list({ project_id: P, desk_id: D, path: "Dockerfile" }),
      /is a file/,
    );
  } finally {
    await x.close();
  }
});

test("create_folder creates missing parents and is idempotent", async () => {
  const x = await setup();
  try {
    const a = await x.files.createFolder({
      project_id: P,
      desk_id: D,
      path: "data/raw/2026",
    });
    assert.deepEqual(a.created, ["data", "data/raw", "data/raw/2026"]);
    const b = await x.files.createFolder({
      project_id: P,
      desk_id: D,
      path: "data/raw/2026",
    });
    assert.equal(b.status, "exists");
    x.db.dav.set("blocker", Buffer.from("f"));
    await assert.rejects(
      x.files.createFolder({ project_id: P, desk_id: D, path: "blocker/sub" }),
      /parent path is missing or is a file/,
    );
  } finally {
    await x.close();
  }
});

test("paths with traversal are rejected and expired cookies pause for auth", async () => {
  const x = await setup();
  try {
    await assert.rejects(sync(x, { remote_path: "../etc" }));
    await assert.rejects(sync(x, { local_path: "relative/path" }));
    x.db.auth = false;
    await assert.rejects(sync(x), (e: any) => e.code === "needs_auth");
  } finally {
    await x.close();
  }
});

test("move_path previews the whole batch, then moves only with confirm", async () => {
  const x = await setup();
  try {
    await sync(x, { dry_run: false });
    const base = { project_id: P, desk_id: D };
    const moves = [
      { from: "Dockerfile", to: "Dockerfile.old" },
      { from: "app", to: "service" },
      { from: "empty", to: "app/main.py" },
      { from: "missing.txt", to: "x.txt" },
      { from: "app", to: "app/inner" },
    ];
    x.db.davRequests.length = 0;
    const preview = await x.files.move({ ...base, moves });
    assert.equal(preview.status, "confirm_required");
    assert.deepEqual(
      preview.moves.map((m: any) => [m.from, m.type]),
      [
        ["Dockerfile", "file"],
        ["app", "folder"],
      ],
    );
    assert.equal(preview.issues.length, 3);
    assert.equal(writes(x.db).length, 0);
    const done = await x.files.move({ ...base, moves, confirm: true });
    assert.equal(done.status, "partial");
    assert.equal(done.moved.length, 2);
    assert.equal(
      x.db.dav.get("Dockerfile.old").toString(),
      "FROM python:3.12\n",
    );
    assert.equal(x.db.dav.get("service/main.py").toString(), "print('hi')\n");
    assert.equal(x.db.dav.has("app/main.py"), false);
    const missingParent = await x.files.move({
      ...base,
      moves: [{ from: "Dockerfile.old", to: "nope/Dockerfile" }],
      confirm: true,
    });
    assert.match(missingParent.issues[0], /create it with create_folder/);
  } finally {
    await x.close();
  }
});

test("delete_path previews the whole batch once and deletes only with confirm", async () => {
  const x = await setup();
  try {
    await sync(x, { dry_run: false });
    const base = { project_id: P, desk_id: D };
    const paths = ["app", "app/main.py", "Dockerfile", "missing.txt"];
    x.db.davRequests.length = 0;
    const preview = await x.files.remove({ ...base, paths });
    assert.equal(preview.status, "confirm_required");
    assert.deepEqual(
      preview.delete.map((t: any) => [t.path, t.files, t.folders]),
      [
        ["app", 2, 1],
        ["Dockerfile", undefined, undefined],
      ],
    );
    assert.deepEqual(preview.issues, ["missing.txt: does not exist"]);
    assert.equal(writes(x.db).length, 0);
    const done = await x.files.remove({ ...base, paths, confirm: true });
    assert.deepEqual(done.deleted, ["app", "Dockerfile"]);
    assert.ok(![...x.db.dav.keys()].some((k) => k.startsWith("app")));
    assert.equal(x.db.dav.has("Dockerfile"), false);
    await assert.rejects(
      x.files.remove({ ...base, paths: ["/"], confirm: true }),
    );
    await assert.rejects(
      x.files.remove({ ...base, paths: ["../x"], confirm: true }),
    );
  } finally {
    await x.close();
  }
});

test("sync uploads new files without confirmation", async () => {
  const x = await setup();
  try {
    const done = await sync(x, { dry_run: false });
    assert.equal(done.status, "synced");
    assert.equal(x.db.dav.get("Dockerfile").toString(), "FROM python:3.12\n");
  } finally {
    await x.close();
  }
});

test("a build waits until files uploaded to its disk have settled", async () => {
  const x = await setup();
  try {
    x.engine.files = x.files;
    x.config.uploadSettleSeconds = 0.3;
    x.db.buildStatus = "done";
    await sync(x, { dry_run: false });
    const r: any = await x.engine.buildImage({
      project_id: P,
      desk_id: D,
      dockerfile: "/Dockerfile",
      name: "app",
    });
    let v = await x.engine.get({ deployment_id: r.deployment_id });
    assert.equal(v.status, "preparing");
    assert.match(v.message, /just-uploaded files/);
    assert.equal(
      x.db.images.some((i: any) => i.name === "app"),
      false,
    );
    await new Promise((r) => setTimeout(r, 350));
    for (let n = 0; n < 5 && v.status !== "built"; n++)
      v = await x.engine.get({ deployment_id: r.deployment_id });
    assert.equal(v.status, "built");
  } finally {
    await x.close();
  }
});

test("a stopped desk storage is started and awaited before listing; a slow start asks to repeat", async () => {
  const x = await setup();
  try {
    const desk = x.db.desks[0];
    desk.filesystem = { status: "not_started" };
    x.db.filesystemStartPolls = 1;
    const listed = await x.files.list({ project_id: P, desk_id: D });
    assert.equal(desk.filesystem.status, "running");
    assert.ok(Array.isArray(listed.entries));
    assert.equal(
      x.db.requests.filter((r: any) => r.path === `/desks/${D}/filesystem`)
        .length,
      1,
    );

    desk.filesystem = { status: "not_started" };
    x.db.filesystemStartPolls = 1000;
    x.engine.filesystemWaitMs = 50;
    await assert.rejects(
      x.files.list({ project_id: P, desk_id: D }),
      (e: any) =>
        e.code === "not_ready" &&
        /started it.*Nothing was changed.*Repeat the same call/.test(e.message),
    );
  } finally {
    await x.close();
  }
});

test("a repeat sync trusts files it already verified instead of re-checksumming them", async () => {
  const x = await setup();
  try {
    const first = await sync(x, { dry_run: false });
    assert.equal(first.status, "synced");
    const before = x.db.davRequests.length;
    const again = await sync(x, { dry_run: false });
    assert.equal(again.status, "synced");
    assert.equal(again.unchanged_count, first.uploaded.length);
    const after = x.db.davRequests.slice(before);
    assert.deepEqual(
      after.filter((r: any) => r.checksum),
      [],
      "no per-file checksum requests",
    );
    assert.ok(after.every((r: any) => r.method === "PROPFIND"));
  } finally {
    await x.close();
  }
});

test("gateway 502s on checksums are retried; persistent ones skip the file instead of failing the call", async () => {
  const x = await setup();
  try {
    await sync(x, { dry_run: false });
    const other = new FileManager(x.api, x.engine); // fresh process: no verified cache
    x.db.davFail = { count: 2 };
    const retried = await sync({ ...x, files: other }, { dry_run: false });
    assert.equal(retried.status, "synced");

    const third = new FileManager(x.api, x.engine);
    x.db.davFail = { count: 1000, path: "app/main.py" };
    const busy = await sync({ ...x, files: third }, { dry_run: false });
    assert.equal(busy.status, "in_progress");
    assert.equal(busy.remaining_count, 1);
    assert.match(busy.message, /Repeat the same call/);
    x.db.davFail = undefined;
    const done = await sync({ ...x, files: third }, { dry_run: false });
    assert.equal(done.status, "synced");
  } finally {
    await x.close();
  }
});

test(".dockerignore patterns exclude files from a build upload, including ** globs", async () => {
  const x = await setup();
  try {
    await mkdir(join(x.src, "packages/a/dist"), { recursive: true });
    await writeFile(join(x.src, "packages/a/dist/out.js"), "x");
    await writeFile(join(x.src, "packages/a/keep.ts"), "x");
    await mkdir(join(x.src, "docs/deep"), { recursive: true });
    await writeFile(join(x.src, "docs/deep/a.md"), "x");
    await writeFile(join(x.src, "app/static/x.map"), "x");
    await writeFile(
      join(x.src, ".dockerignore"),
      "# build output\npackages/*/dist\n/docs/\n**/*.map\n",
    );
    const exclude = await dockerignore(x.src);
    assert.deepEqual(exclude, ["packages/*/dist", "/docs/", "**/*.map"]);
    const plan = await sync(x, { dry_run: true, exclude });
    const all = plan.new_files.join(" ");
    assert.match(all, /packages\/a\/keep\.ts/);
    assert.doesNotMatch(all, /dist\/out\.js|docs\/deep|x\.map/);

    await writeFile(join(x.src, ".dockerignore"), "*\n!app\n");
    assert.deepEqual(
      await dockerignore(x.src),
      [],
      "! exceptions are not used",
    );
  } finally {
    await x.close();
  }
});
