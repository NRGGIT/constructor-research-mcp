import { createServer } from "node:http";
import { LogFollower } from "../src/logs.js";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformApi } from "../src/api.js";
import { DeploymentEngine } from "../src/deployment.js";
import { StateStore } from "../src/store.js";
export const P = "c98d546de8104a2d9968aba721fe90f2";
export const A = "daf773193e204ea783e70c07f4b97cbc";
export const D = "dddd1111";
export const H = "hhhh1111";
export const I = "iiii1111";
/** An access token expiring in `minutes`, with extra claims. */
export const jwt = (minutes: number, extra: object = {}) =>
  "eyJhbGciOiJIUzI1NiJ9." +
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000 + minutes * 60),
      ...extra,
    }),
  ).toString("base64url") +
  ".sig";
export async function platform() {
  const dir = await mkdtemp(join(tmpdir(), "constructor-flow-"));
  const db: any = {
    projects: [
      { id: P, name: "project", deployment_enabled: true, status: "active" },
    ],
    desks: [{ id: D, name: "source", project_id: P, state: "ready" }],
    images: [
      { id: I, name: "image", desk_id: D, project_id: P, build_status: "done" },
    ],
    applications: [],
    mutations: [],
    requests: [],
    auth: true,
    /** Session renewal: the one refresh token the server still accepts. */
    refresh: "refresh-0",
    renewals: 0,
    sessionEnd: Math.floor(Date.now() / 1000) + 14 * 86400,
    cookies: [] as string[],
    buildStatus: "in_progress",
    errorPath: undefined,
    /** Disk D's project folder: path -> contents; folders hold null. */
    dav: new Map<string, Buffer | null>([["", null]]),
    davRequests: [] as { method: string; path: string; checksum?: boolean }[],
  };
  /** Build logs: served while a build runs, replayed in full on every connection. */
  const logs = new Map<
    string,
    { lines: string[]; running: boolean; replay: boolean }
  >();
  const open = new Map<string, Set<import("node:http").ServerResponse>>();
  db.logRequests = 0;
  db.serviceLogs = new Set<string>();
  db.log = (id: string, ...lines: string[]) => {
    const log = logs.get(id) ?? {
      lines: [],
      running: true,
      replay: !db.serviceLogs.has(id),
    };
    logs.set(id, log);
    log.lines.push(...lines);
    for (const res of open.get(id) ?? [])
      res.write(lines.map((l) => l + "\n").join(""));
  };
  /** Ends the build: open streams close and the log is gone. */
  db.endLog = (id: string) => {
    logs.get(id)!.running = false;
    db.cutLogs(id);
  };
  /** A new container: the log starts over with these lines and open streams close. */
  db.restartContainer = (id: string, ...lines: string[]) => {
    const log = logs.get(id)!;
    log.lines = [...lines];
    db.cutLogs(id);
  };
  /** Drops open connections (a proxy timeout) while the build goes on. */
  db.cutLogs = (id: string) => {
    for (const res of open.get(id) ?? []) res.end();
    open.delete(id);
  };
  let n = 1000;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    /** Logs in db.serviceLogs are not replayed: a container that restarted since those lines. */
    const build =
      /^\/api\/platform-keeper\/(?:image-builds|services)\/([^/]+)\/logs$/.exec(
        url.pathname,
      )?.[1];
    if (build) {
      db.logRequests++;
      const log = logs.get(build);
      if (!log?.running) {
        res.writeHead(421, { "content-type": "application/json" });
        return res.end(
          '{"detail":{"msg":"Image job is not found","error_code":210001}}',
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (log.replay) res.write(log.lines.map((l) => l + "\n").join(""));
      else res.flushHeaders();
      const set = open.get(build) ?? new Set();
      open.set(build, set);
      set.add(res);
      req.on("close", () => set.delete(res));
      return;
    }
    if (url.pathname === "/research/") {
      // Signing in ends on a page that sets the session cookies.
      res.setHeader("set-cookie", [
        `ap_access_token=${jwt(60, { max_slt: db.sessionEnd })}; Path=/; HttpOnly`,
        "ap_id_token=id-0; Path=/; HttpOnly",
        `ap_refresh_token=${db.refresh}; Path=/; HttpOnly`,
      ]);
      return res.end("<h1>Constructor</h1>");
    }
    if (url.pathname.startsWith("/api/platform-storage/"))
      return dav(req, res, url);
    const path = url.pathname.replace("/api/platform-account", "");
    const body = await new Promise<any>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s ? JSON.parse(s) : undefined));
    });
    const send = (data: any, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    db.requests.push({ method: req.method, path, body });
    const cookie = req.headers.cookie ?? "";
    db.cookies.push(cookie);
    // Like the gateway: a request with only a refresh token renews the session.
    if (path === "/auth/session" && !/ap_access_token=/.test(cookie)) {
      const sent = /ap_refresh_token=([^;\s]+)/.exec(cookie)?.[1];
      if (!sent || sent !== db.refresh)
        return send({ details: { msg: "SECRET", error_code: 20001 } }, 401);
      db.renewals++;
      db.refresh = `refresh-${db.renewals}`;
      res.setHeader("set-cookie", [
        `ap_access_token=${jwt(60, { max_slt: db.sessionEnd })}; Path=/; HttpOnly; Secure`,
        `ap_id_token=id-${db.renewals}; Path=/; HttpOnly`,
        `ap_refresh_token=${db.refresh}; Path=/; HttpOnly`,
      ]);
      return send({ user: { id: "user" }, refresh_interval: 150 });
    }
    if (!db.auth)
      return send({ details: { msg: "SECRET", error_code: 20001 } }, 401);
    if (req.method !== "GET")
      db.mutations.push({ method: req.method, path, body });
    if (path === db.errorPath)
      return send({ details: { msg: "SECRET", error_code: 10001 } }, 421);
    if (path === "/auth/session")
      return send({ user: { id: "user" }, refresh_interval: 150 });
    if (path === "/projects" && req.method === "GET")
      return send({ results: db.projects, total: db.projects.length });
    if (path === "/projects" && req.method === "POST") {
      const p = {
        id: P,
        name: body.name,
        deployment_enabled: false,
        status: "active",
      };
      db.projects.push(p);
      return send(p);
    }
    if (path === `/projects/${P}` && req.method === "GET")
      return send(db.projects.find((p: any) => p.id === P));
    if (path === `/projects/${P}` && req.method === "PATCH") {
      Object.assign(db.projects[0], body);
      return send(db.projects[0]);
    }
    if (path === `/projects/${P}/hardware-configurations`)
      return send({
        results: db.hardware ?? [
          {
            id: H,
            name: "small",
            cpu_count: 1,
            ram_gb: 4,
            gpu: null,
            removed: false,
            availability: { status: "high", total: 10, used: 0 },
          },
        ],
        total: 1,
      });
    if (path === `/projects/${P}/desks` && req.method === "GET")
      return send({ results: db.desks, total: db.desks.length });
    if (path === `/projects/${P}/desks` && req.method === "POST") {
      const d = { id: D, name: body.name, project_id: P, state: "ready" };
      db.desks.push(d);
      return send(d);
    }
    if (path === `/desks/${D}/filesystem` && req.method === "POST") {
      const d = db.desks.find((d: any) => d.id === D);
      d.filesystem = { status: "starting" };
      return send(d);
    }
    if (path === `/desks/${D}` && req.method === "GET") {
      // A started storage becomes running after db.filesystemStartPolls reads.
      const d = db.desks.find((d: any) => d.id === D);
      if (
        d?.filesystem?.status === "starting" &&
        --db.filesystemStartPolls <= 0
      )
        d.filesystem = { status: "running" };
    }
    if (path === `/desks/${D}` && req.method === "GET")
      return send(
        db.desks.find((d: any) => d.id === D) ?? {},
        db.desks.length ? 200 : 404,
      );
    if (path === `/desks/${D}/images`) {
      const i = {
        id: `image${n++}`,
        project_id: P,
        desk_id: D,
        name: body.name,
        dockerfile: body.dockerfile,
        build_status: db.buildStatus,
      };
      db.images.push(i);
      return send(db.badCreateReply ? {} : i);
    }
    if (path === `/projects/${P}/images`) {
      const rows = db.images.filter(
        (i: any) =>
          !url.searchParams.get("desk_id") ||
          i.desk_id === url.searchParams.get("desk_id"),
      );
      return send({ results: rows, total: rows.length });
    }
    if (path === `/projects/${P}/applications` && req.method === "GET")
      return send({ results: db.applications, total: db.applications.length });
    if (path === `/projects/${P}/applications` && req.method === "POST") {
      const a = { id: A, name: body.name, project_id: P, services: [] };
      db.applications.push(a);
      return send(a);
    }
    const app = db.applications.find((a: any) => a.id === A);
    if (path === `/applications/${A}/services` && req.method === "POST") {
      const sv = {
        ...body,
        id: `service${n++}`,
        status: "stopped",
        link: null,
      };
      for (const k of ["ports", "volumes", "environment_variables"])
        sv[k] = sv[k].map((x: any) => ({ ...x, id: x.id ?? `child${n++}` }));
      app.services.push(sv);
      return send(sv);
    }
    const match = path.match(/^\/services\/([^/]+)(?:\/(start|stop))?$/);
    const sv = app?.services.find((s: any) => s.id === match?.[1]);
    if (match && sv) {
      if (match[2]) sv.status = match[2] === "start" ? "running" : "stopped";
      sv.link = sv.ports.some((p: any) => p.expose_to_internet)
        ? `https://${sv.id}.constructor.pro`
        : null;
      return send(sv);
    }
    if (
      path.startsWith(`/applications/${A}/services/`) &&
      req.method === "PATCH"
    ) {
      const sv = app.services.find((s: any) => s.id === path.split("/").at(-1));
      Object.assign(sv, body);
      return send(undefined, 204);
    }
    send({ details: { error_code: 404 } }, 404);
  });
  /** Mirrors the live WebDAV behaviour observed live. */
  async function dav(req: any, res: any, url: URL) {
    const root = `/api/platform-storage/desks/${D}/dav/project/`;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const end = (status: number, data?: string, type = "application/xml") => {
      res.writeHead(status, { "content-type": type });
      res.end(data);
    };
    if (!db.auth) return end(401);
    const storage = db.desks.find((d: any) => d.id === D)?.filesystem?.status;
    if (storage && storage !== "running")
      return end(storage === "starting" ? 503 : 502);
    const raw = url.pathname + "/";
    if (!raw.startsWith(root)) return end(404);
    const path = decodeURIComponent(url.pathname.slice(root.length)).replace(
      /\/$/,
      "",
    );
    const parent = path.split("/").slice(0, -1).join("/");
    const fs: Map<string, Buffer | null> = db.dav;
    db.davRequests.push({
      method: req.method,
      path,
      ...(req.method === "PROPFIND" && body.length ? { checksum: true } : {}),
    });
    // Gateway errors seen live: the next db.davFail.count checksum requests answer 502.
    if (
      req.method === "PROPFIND" &&
      body.length &&
      db.davFail?.count > 0 &&
      (db.davFail.path === undefined || db.davFail.path === path)
    ) {
      db.davFail.count--;
      return end(502, "<html>502 Bad Gateway</html>", "text/html");
    }
    if (req.method === "PROPFIND" && body.length) {
      const f = fs.get(path);
      if (!f && f !== null)
        return end(404, "[FileNotFoundError]", "text/plain");
      const { from, to } = JSON.parse(body.toString());
      const sum = createHash("sha256")
        .update(f!.subarray(from, to + 1))
        .digest("hex");
      return end(
        200,
        JSON.stringify({ method: "checksum", checksum: sum, chunks: [sum] }),
        "application/json",
      );
    }
    if (req.method === "PROPFIND") {
      if (req.headers.depth === "infinity") return end(403);
      if (!fs.has(path)) return end(404);
      const row = (p: string) => {
        const f = fs.get(p)!;
        return `<response><href>${root}${p.split("/").map(encodeURIComponent).join("/")}</href><propstat><prop>${f ? "<resourcetype/>" : "<resourcetype><collection/></resourcetype>"}<getlastmodified>2026-10-27T00:00:00+00:00</getlastmodified><getcontentlength>${f ? f.length : 4096}</getcontentlength></prop></propstat></response>`;
      };
      const kids =
        fs.get(path) === null && req.headers.depth !== "0"
          ? [...fs.keys()].filter(
              (k) => k && k.split("/").slice(0, -1).join("/") === path,
            )
          : [];
      return end(
        207,
        `<?xml version='1.0'?><multistatus xmlns="DAV:">${[path, ...kids].map(row).join("")}</multistatus>`,
      );
    }
    if (req.method === "MKCOL") {
      if (fs.has(path)) return end(405);
      if (fs.get(parent) !== null) return end(409);
      fs.set(path, null);
      return end(201);
    }
    if (req.method === "PUT") {
      if (body.length > 9 * 1024 * 1024)
        return end(413, "<html>413</html>", "text/html");
      if (fs.get(parent) !== null)
        return end(404, "[FileNotFoundError]", "text/plain");
      const old = fs.get(path);
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(
        req.headers["content-range"] ?? "",
      );
      let next = body;
      if (range) {
        const at = +range[1];
        next = Buffer.alloc(Math.max(old?.length ?? 0, at + body.length));
        old?.copy(next);
        body.copy(next, at);
      }
      fs.set(path, next);
      return end(old ? 204 : 201);
    }
    if (req.method === "MOVE") {
      const to = decodeURIComponent(String(req.headers.destination));
      if (!to.startsWith(root)) return end(404);
      const target = to.slice(root.length).replace(/\/$/, "");
      if (!fs.has(path)) return end(404);
      if (fs.has(target) && req.headers.overwrite === "F") return end(412);
      if (fs.get(target.split("/").slice(0, -1).join("/")) !== null)
        return end(404);
      const existed = fs.has(target);
      for (const k of [...fs.keys()])
        if (k === path || k.startsWith(path + "/")) {
          fs.set(target + k.slice(path.length), fs.get(k)!);
          fs.delete(k);
        }
      return end(existed ? 204 : 201);
    }
    if (req.method === "DELETE") {
      for (const k of [...fs.keys()])
        if (k === path || k.startsWith(path + "/")) fs.delete(k);
      return end(204);
    }
    if (req.method === "GET") {
      const f = fs.get(path);
      return f ? end(200, f.toString(), "application/octet-stream") : end(404);
    }
    end(405);
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cookieFile = join(dir, "cookie");
  await writeFile(cookieFile, "ap_access_token=test-cookie");
  const config = {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    baseUrlFixed: true,
    apiPath: "/api/platform-account",
    cookieFile,
    stateDir: join(dir, "state"),
    requestTimeoutMs: 1000,
  };
  const api = new PlatformApi(config);
  api.storageRetryMs = [1, 1, 1];
  const store = new StateStore(config);
  store.lockWaitMs = 0;
  const engine = new DeploymentEngine(api, store);
  /** Public URLs answer immediately unless a test says otherwise. */
  engine.probeUrl = async () => db.probeStatus ?? 200;
  const buildLogs = new LogFollower(api);
  buildLogs.retryMs = [10, 10, 10];
  engine.logs = buildLogs;
  return {
    db,
    config,
    api,
    store,
    engine,
    dir,
    logs: buildLogs,
    async close() {
      await buildLogs.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function finish(
  engine: DeploymentEngine,
  result: any,
  extra: any = {},
) {
  for (
    let n = 0;
    n < 40 &&
    ![
      "started",
      "failed",
      "needs_auth",
      "needs_upload",
      "needs_reconciliation",
    ].includes(result.status);
    n++
  )
    result = await engine.get({
      deployment_id: result.deployment_id,
      ...extra,
    });
  return result;
}
