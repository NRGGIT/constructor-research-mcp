import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PlatformApi, ToolError, segment as e } from "./api.js";
import { StateStore, type Operation } from "./store.js";
import type { FileManager } from "./files.js";
import type { LogFollower } from "./logs.js";
import {
  deployInput,
  updateInput,
  buildInput,
  listInput,
  lifecycleInput,
  getInput,
  type ServiceInput,
} from "./schemas.js";

const NOTICE =
  "Start requested; application readiness is unverified. Initial small deployments usually take 1–2 minutes; updates often take tens of seconds. These are estimates.";
export const terminal = new Set([
  "started",
  "stopped",
  "built",
  "failed",
  "needs_reconciliation",
  "confirm_required",
  "superseded",
]);
/** What to check when a public URL does not answer, ordered by how often it was the cause. */
function silentHint(silent?: string[]) {
  if (!silent?.length)
    return "Usually the app is not listening on 0.0.0.0 on the service port, or it crashed on start. get_logs with this deployment_id shows what the services printed since they started.";
  return `${silent.join(", ")} printed nothing since starting: the container most likely exits before its first line and keeps restarting. Check, in this order: (1) the ENTRYPOINT/CMD script is not executable (files uploaded to a desk lose the executable bit; add RUN chmod 0755 <script>); (2) ENTRYPOINT/CMD names a path that does not exist in the image; (3) nginx has "listen [::]" and the cluster has no IPv6; (4) the app listens on 127.0.0.1 or another port. Fix the Dockerfile, sync it and run update_app for these services.`;
}
function bad(message: string): never {
  throw new ToolError("invalid_input", message);
}
function one<T>(rows: T[], message: string): T | undefined {
  if (rows.length > 1) bad(message);
  return rows[0];
}
function internal(project: string, app: string, name: string, port: number) {
  return `svc-${name}.app-${project.slice(0, 4)}${app.slice(0, 4)}.svc.cluster.local:${port}`;
}
function publicService(s: any, project: string, app: string) {
  return {
    id: s.id,
    name: s.name,
    image_id: s.image_id,
    status: s.status,
    ports: s.ports,
    volumes: s.volumes,
    environment_variable_names: (s.environment_variables ?? []).map(
      (x: any) => x.name,
    ),
    public_url: s.ports?.some((p: any) => p.expose_to_internet)
      ? (s.link ?? `https://${s.id}.constructor.pro`)
      : null,
    internal_addresses: (s.ports ?? []).map((p: any) => ({
      port: p.number,
      address: internal(project, app, s.name, p.number),
    })),
  };
}
function ordered(inputs: ServiceInput[], existing: any[] = []): ServiceInput[] {
  const ids = inputs.filter((s) => s.service_id).map((s) => s.service_id);
  if (new Set(ids).size !== ids.length)
    bad("Each service_id can be targeted only once.");
  const names = new Set(inputs.map((s) => s.name));
  if (names.size !== inputs.length) bad("Service names must be unique.");
  const owner = new Map<string, string>();
  for (const s of existing)
    for (const v of s.volumes ?? []) if (v.id) owner.set(v.id, s.name);
  const named = new Map<string, string>();
  for (const s of inputs)
    for (const v of s.volumes ?? []) {
      const by = (v.id && owner.get(v.id)) ?? named.get(v.name);
      if (by && by !== s.name)
        bad(
          `Volume ${v.name} is already mounted on ${by}; a volume belongs to one service. Give ${s.name} its own volume, or let it reach ${by} over an internal reference.`,
        );
      named.set(v.name, s.name);
    }
  const all = new Set([...names, ...existing.map((s) => s.name)]);
  const result: ServiceInput[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(s: ServiceInput) {
    if (done.has(s.name)) return;
    if (visiting.has(s.name)) bad("Service dependencies contain a cycle.");
    visiting.add(s.name);
    const refs = Object.values(s.environment_variables ?? {}).filter(
      (v) => typeof v !== "string",
    );
    for (const dep of new Set([
      ...(s.depends_on ?? []),
      ...refs.map((r) => r.service),
    ])) {
      if (!all.has(dep)) bad(`Unknown dependency: ${dep}.`);
      const other = inputs.find((x) => x.name === dep);
      if (other) visit(other);
    }
    for (const ref of refs) {
      const other = inputs.find((x) => x.name === ref.service);
      const old = existing.find((x) => x.name === ref.service);
      const targetPorts = other?.ports ?? old?.ports ?? [];
      if (ref.exposure === "public") {
        if (
          !targetPorts.some(
            (p: any) =>
              p.expose_to_internet &&
              (ref.port === undefined || p.number === ref.port),
          )
        )
          bad(`Service ${ref.service} has no matching public port.`);
      } else if (!targetPorts.some((p: any) => p.number === ref.port))
        bad(`Referenced port ${ref.port} is not configured on ${ref.service}.`);
    }
    visiting.delete(s.name);
    done.add(s.name);
    result.push(s);
  }
  inputs.forEach(visit);
  return result;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Image name owned by `base`: the base itself or a UI-style `base-vN`. */
const namedFor = (base: string, name: string) =>
  name === base || new RegExp(`^${escapeRe(base)}-v\\d+$`).test(name);
/**
 * Unique UI-style image name. Each build gets its own name: `base-vN` after the
 * highest existing version, or `base` itself when explicit and still free.
 */
function imageName(base: string, images: any[], versioned: boolean) {
  const top = Math.max(
    0,
    ...images.map(
      (i) =>
        +(
          new RegExp(`^${escapeRe(base)}-v(\\d+)$`).exec(i.name ?? "")?.[1] ?? 0
        ),
    ),
  );
  if (!versioned && !top && !images.some((i) => i.name === base)) return base;
  return `${base}-v${top + 1}`;
}
const usable = (h: any) =>
  !h.removed &&
  !["not_available", "unavailable"].includes(h.availability?.status);
/** Smallest usable option meeting the minimums; GPU options only when a GPU is requested. */
function fitting(
  hardware: any[],
  need: { cpu?: number; ram_gb?: number; gpu?: boolean },
) {
  return hardware
    .filter(
      (h) =>
        usable(h) &&
        !!h.gpu === !!need.gpu &&
        h.cpu_count >= (need.cpu ?? 0) &&
        h.ram_gb >= (need.ram_gb ?? 0),
    )
    .sort((a, b) => a.cpu_count - b.cpu_count || a.ram_gb - b.ram_gb)[0];
}
/** What an agent may choose from: specs only, no names or IDs. */
function hardwareOptions(hardware: any[]) {
  const seen = new Set<string>();
  return hardware
    .filter(usable)
    .map((h) => ({
      cpu: h.cpu_count,
      ram_gb: h.ram_gb,
      gpu: h.gpu ? (h.gpu.name ?? h.gpu.model ?? "yes") : null,
    }))
    .sort((a, b) => +!!a.gpu - +!!b.gpu || a.cpu - b.cpu || a.ram_gb - b.ram_gb)
    .filter(
      (o) => !seen.has(JSON.stringify(o)) && !!seen.add(JSON.stringify(o)),
    );
}

export class DeploymentEngine {
  /** Set by the server so a build retry can re-check and re-upload its sources. */
  files?: FileManager;
  logs?: LogFollower;
  /** Native statuses this MCP saw each service go through, oldest first. */
  private seen = new Map<string, { status: string; at: string }[]>();
  /**
   * Adds what the MCP observed to a service view: the status changes it saw and the new
   * containers it saw starting in the service log. Constructor reports neither, so an
   * agent can tell a restart loop from a stable service. Follows the log to keep seeing.
   */
  private observed(v: any) {
    const at = new Date().toISOString();
    const history = this.seen.get(v.id) ?? [];
    if (history.at(-1)?.status !== v.status) {
      history.push({ status: v.status, at });
      if (history.length > 20) history.shift();
      this.seen.set(v.id, history);
    }
    if (v.status === "running" || v.status === "starting")
      this.logs?.follow(v.id, "service");
    const restarts = this.logs?.restarts(v.id) ?? [];
    return {
      ...v,
      ...(history.length > 1 ? { status_changes: history } : {}),
      ...(restarts.length
        ? { restarts_seen: restarts.length, restarted_at: restarts }
        : {}),
    };
  }
  /** Builds of this operation that are still running get their log followed. */
  private followLogs(op: Operation, images: any[]) {
    const ours = new Set(Object.values(op.images));
    for (const im of images)
      if (ours.has(im.id) && !["done", "error"].includes(im.build_status))
        this.logs?.follow(im.id);
  }
  /** How long a file tool waits for a stopped desk storage to start. */
  filesystemWaitMs = 45000;
  /** HTTP status of a public URL, or null when nothing answers. */
  probeUrl = async (url: string): Promise<number | null> => {
    try {
      const r = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel();
      return r.status;
    } catch {
      return null;
    }
  };
  constructor(
    readonly api: PlatformApi,
    readonly store: StateStore,
  ) {}
  /** Hold a build while files uploaded to its disk may not have reached the builder yet. */
  private async settling(op: Operation, desk: string) {
    const ms = this.files?.settleMs(desk) ?? 0;
    if (!ms) return false;
    op.status = "preparing";
    op.message = `Waiting ${Math.ceil(ms / 1000)} s for just-uploaded files to reach the builder.`;
    await this.store.save(op);
    return true;
  }
  private deskLink(project: string, desk: string) {
    return `${this.api.config.baseUrl}/research/projects/${project}/desks/${desk}/viewer/file`;
  }
  /**
   * The platform briefly reports error while it retries, so an error counts only
   * when seen twice for the same image. The first confirmed failure is rebuilt
   * once under a new name, after re-uploading (local_path) and re-checking the
   * Dockerfile on the disk.
   */
  private async buildError(
    op: Operation,
    key: string,
    image: any,
    source: {
      desk_id: string;
      dockerfile: string;
      local_path?: string;
      remote_path?: string;
    },
  ): Promise<"wait" | "retry" | "fail"> {
    op.errorSeen ??= {};
    op.retried ??= {};
    if (op.errorSeen[key] !== image.id) {
      op.errorSeen[key] = image.id;
      return "wait";
    }
    if (op.retried[key]) return "fail";
    op.retried[key] = image.name ?? image.id;
    delete op.errorSeen[key];
    if (this.files && source.local_path)
      try {
        await this.files.sync({
          project_id: op.project_id,
          desk_id: source.desk_id,
          local_path: source.local_path,
          remote_path: source.remote_path ?? "",
        });
      } catch (err) {
        if (err instanceof ToolError && err.code === "needs_auth") throw err;
      }
    if (this.files) {
      const pre = await this.files.preflight(op.project_id!, [
        { service: key, ...source, ports: [] },
      ]);
      if (pre.missing.length) return "fail";
    }
    delete op.images[key];
    op.message = `Build for ${key} failed; the MCP re-checked the source files and is rebuilding once under a new name.`;
    return "retry";
  }
  private async buildFailed(
    op: Operation,
    key: string,
    image: any,
    deskId: string,
    dockerfile: string,
    service?: string,
  ) {
    const link = this.deskLink(op.project_id!, deskId);
    const first = op.retried?.[key];
    op.status = "failed";
    op.failure = {
      stage: "build",
      service,
      dockerfile,
      image_id: image.id,
      image_name: image.name,
      first_image_name: first,
      desk_link: link,
    };
    const log = await this.logs?.peek(image.id, "build", 20);
    if (log) op.failure.log_tail = log.lines;
    op.message = `Image build${service ? ` for ${service}` : ""} failed${first ? ` twice (${first}, then ${image.name} after re-checking the files)` : ` (${image.name})`}. ${
      log
        ? "The last build log lines are in failure.log_tail (get_logs with the image ID shows up to 50)."
        : `No build log was captured. To see the error, open the desk (${link}), rebuild ${dockerfile} from the UI and watch the live log.`
    } Fix the Dockerfile or source, then deploy again.`;
  }
  /** Poll public URLs after start until they answer or readinessSeconds pass. */
  private async ready(op: Operation, appId: string) {
    const seconds = this.api.config.readinessSeconds ?? 60;
    if (!seconds) return true;
    const ids = Object.values(op.services);
    for (const id of ids) this.logs?.follow(id, "service");
    const targets = (await this.app(op.project_id!, appId)).services
      .filter(
        (s: any) =>
          ids.includes(s.id) && s.ports?.some((p: any) => p.expose_to_internet),
      )
      .map((s: any) => publicService(s, op.project_id!, appId));
    op.readiness ??= { since: Date.now(), checks: {} };
    for (const t of targets) {
      if (op.readiness.checks[t.name]?.ok) continue;
      const status = await this.probeUrl(t.public_url!);
      op.readiness.checks[t.name] = {
        url: t.public_url!,
        status,
        ok: status !== null && status < 500,
      };
    }
    if (targets.every((t: any) => op.readiness!.checks[t.name].ok)) return true;
    if (Date.now() - op.readiness.since <= seconds * 1000) return false;
    // Not answering: services that printed nothing since start most likely exit before their first line.
    op.readiness.silent = [];
    for (const [name, id] of Object.entries(op.services))
      if (this.logs && !(await this.logs.peek(id, "service", 1)))
        op.readiness.silent.push(name);
    return true;
  }
  private root(project: string) {
    return `/projects/${e(project)}`;
  }
  private async rows(path: string) {
    const d = await this.api.request("GET", path);
    if (
      !Array.isArray(d.results) ||
      (typeof d.total === "number" && d.total > d.results.length)
    )
      throw new ToolError(
        "incomplete_response",
        "API returned incomplete discovery results; refusing ambiguous resource selection.",
      );
    return d.results as any[];
  }
  private async project(id: string) {
    const p = await this.api.request("GET", this.root(id));
    if (p.id !== id) bad("Project response does not match requested project.");
    if (p.archived || p.status === "archived") bad("Project is archived.");
    return p;
  }
  private async apps(project: string) {
    return this.rows(this.root(project) + "/applications");
  }
  private async app(project: string, id: string) {
    return (
      one(
        (await this.apps(project)).filter((a) => a.id === id),
        "Ambiguous application ID.",
      ) ?? bad("Application does not belong to this project or does not exist.")
    );
  }
  private async images(project: string, desk?: string) {
    return this.rows(
      this.root(project) + "/images" + (desk ? `?desk_id=${e(desk)}` : ""),
    );
  }
  async desk(project: string, id: string) {
    const d = await this.api.request("GET", `/desks/${e(id)}`);
    if (d.project_id !== project)
      bad("Disk does not belong to the selected project.");
    if (d.state && d.state !== "ready")
      throw new ToolError("not_ready", "Disk is not ready; retry later.");
    return d;
  }
  /**
   * The desk record plus a running file storage. A desk nobody opened recently has
   * its storage stopped (WebDAV answers 502/503), so start it as the browser does
   * and wait; it takes about 30-40 s.
   */
  async filesDesk(project: string, id: string) {
    let d = await this.desk(project, id);
    let status = d.filesystem?.status;
    if (status === undefined || status === "running") return d;
    if (status !== "starting") {
      d = await this.api.request("POST", `/desks/${e(id)}/filesystem`);
      status = d.filesystem?.status;
    }
    const until = Math.min(
      Date.now() + this.filesystemWaitMs,
      this.api.deadlineMs() - 5000,
    );
    while (status !== "running" && Date.now() < until) {
      await delay(Math.min(3000, Math.max(0, until - Date.now())));
      d = await this.desk(project, id);
      status = d.filesystem?.status;
    }
    if (status === "running") return d;
    throw new ToolError(
      "not_ready",
      `The desk's file storage was stopped (desk not used recently), so the MCP started it, as opening the desk in the browser does. It is still ${status ?? "starting"}; this takes about 30-40 s. Nothing was changed. Repeat the same call in a moment.`,
    );
  }
  async listImages(raw: unknown) {
    const input = listInput.parse(raw);
    await this.project(input.project_id);
    if (input.desk_id) await this.desk(input.project_id, input.desk_id);
    const results = await this.images(input.project_id, input.desk_id);
    return {
      results: input.detailed
        ? results
        : results.map((x) => ({
            id: x.id,
            name: x.name,
            desk_id: x.desk_id,
            desk_name: x.desk_name,
            dockerfile: x.dockerfile,
            tag: x.tag,
            build_status: x.build_status,
          })),
      total: results.length,
    };
  }
  async deploy(raw: unknown) {
    const input = deployInput.parse(raw);
    return input.deployment_id
      ? this.resume(input, "deploy")
      : this.submit("deploy", input);
  }
  async update(raw: unknown) {
    const input = updateInput.parse(raw);
    return input.deployment_id
      ? this.resume(input, "update")
      : this.submit("update", input);
  }
  async buildImage(raw: unknown) {
    return this.submit("build", buildInput.parse(raw));
  }
  async lifecycle(kind: "start" | "stop", raw: unknown) {
    return this.submit(kind, lifecycleInput.parse(raw));
  }
  private async submit(kind: Operation["kind"], input: any) {
    return this.store.exclusive(async () => {
      input = { ...input };
      delete input.wait_seconds;
      delete input.deployment_id;
      const key = JSON.stringify({ ...input, files_uploaded: undefined });
      let id = input.request_id ?? randomUUID();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      ) {
        const h = createHash("sha256")
          .update(`${this.store.endpoint}|${kind}|${id}`)
          .digest("hex");
        id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      }
      let op = await this.store.load(id);
      if (op) {
        if (
          op.kind !== kind ||
          (op.submission_key ??
            JSON.stringify({ ...op.input, files_uploaded: undefined })) !== key
        )
          bad("request_id was already used with different arguments.");
        if (input.files_uploaded) op.input.files_uploaded = true;
        return this.advance(op);
      }
      // Validate known topology before any authenticated mutation; existing services are checked below.
      if (kind === "deploy") ordered(input.services);
      op = {
        id,
        kind,
        endpoint: this.store.endpoint,
        submission_key: key,
        input,
        status: "preparing",
        project_id: input.project_id,
        application_id: input.application_id,
        desks: Object.create(null),
        images: Object.create(null),
        services: Object.create(null),
        applied: [],
        stopped: [],
        started: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (op.application_id && ["update", "start", "stop"].includes(kind))
        op.replaced = await this.supersede(op);
      await this.store.save(op);
      return this.advance(op);
    });
  }
  /**
   * Ends unfinished deployments of the same application, so an older one cannot apply its
   * images after the newer one. Builds it already submitted keep running on Constructor
   * but are not used. Called under the store lock, so no step of theirs is mid-flight.
   */
  private async supersede(op: Operation) {
    const replaced: NonNullable<Operation["replaced"]> = [];
    const mine = new Set(
      (op.input.services ?? []).map((s: ServiceInput) => s.name),
    );
    for (const id of await this.store.ids()) {
      let old: Operation | undefined;
      try {
        old = await this.store.load(id);
      } catch {
        continue;
      }
      if (
        !old ||
        old.id === op.id ||
        old.application_id !== op.application_id ||
        terminal.has(old.status) ||
        old.pending
      )
        continue;
      old.status = "superseded";
      old.message = `Replaced by deployment ${op.id} for the same application; this one stopped here.`;
      await this.store.save(old);
      replaced.push({
        deployment_id: old.id,
        services_not_included:
          op.kind === "update"
            ? (old.input.services ?? [])
                .map((s: ServiceInput) => s.name)
                .filter((n: string) => !mine.has(n))
            : [],
      });
    }
    return replaced.length ? replaced : undefined;
  }
  private async resume(input: any, kind: "deploy" | "update") {
    return this.store.exclusive(async () => {
      const op = await this.store.load(input.deployment_id);
      if (!op || op.kind !== kind)
        bad("Deployment ID not found or operation type does not match.");
      if (op.pending || op.status === "needs_reconciliation")
        bad(
          "Inspect the uncertain mutation in Constructor before submitting a new operation.",
        );
      if (input.project_id && input.project_id !== op.project_id)
        bad("Project does not match the saved deployment.");
      if (input.application_id && input.application_id !== op.application_id)
        bad("Application does not match the saved deployment.");
      const next = structuredClone(op.input.services) as ServiceInput[];
      if (input.services) {
        if (
          new Set(input.services.map((s: ServiceInput) => s.name)).size !==
          input.services.length
        )
          bad("Service overrides must be unique.");
        const images = op.project_id ? await this.images(op.project_id) : [];
        for (const override of input.services as ServiceInput[]) {
          const at = next.findIndex((s) => s.name === override.name);
          if (at < 0)
            bad(
              "Resume overrides can only change services already in this deployment.",
            );
          if (
            override.image_id &&
            !images.some(
              (im) => im.id === override.image_id && im.build_status === "done",
            )
          )
            bad("Replacement image is not successfully built in this project.");
          const saved = next[at];
          next[at] = {
            ...saved,
            ...override,
            ...(override.environment_variables
              ? {
                  environment_variables: {
                    ...saved.environment_variables,
                    ...override.environment_variables,
                  },
                }
              : {}),
            ...(override.build
              ? { build: { ...saved.build, ...override.build } }
              : {}),
          };
          if (override.image_id) delete next[at].build;
          if (override.build) delete next[at].image_id;
        }
        // Validate topology before changing saved inputs; references to unchanged live services are allowed.
        const existing =
          op.application_id && op.project_id
            ? (await this.app(op.project_id, op.application_id)).services
            : [];
        ordered(next, existing);
        for (const override of input.services as ServiceInput[]) {
          if (override.image_id || override.build)
            delete op.images[override.name];
          if (override.build) delete op.desks[override.name];
          op.applied = op.applied.filter((n) => n !== override.name);
          op.started = op.started.filter((n) => n !== override.name);
          const serviceId = op.services[override.name];
          op.stopped = op.stopped.filter((id) => id !== serviceId);
        }
        op.input.services = next;
      }
      if (input.files_uploaded) op.input.files_uploaded = true;
      if (input.services || !terminal.has(op.status)) {
        op.status = "preparing";
        delete op.failure;
        delete op.message;
      }
      await this.store.save(op);
      return this.advance(op);
    });
  }
  async observe(id: string) {
    const op = await this.store.load(id);
    if (!op) bad("Deployment ID not found.");
    return this.view(op, false);
  }
  /** Map of every deployment-enabled project with its applications and services. */
  private async overview() {
    const all = await this.rows("/projects");
    const enabled = all.filter((p) => p.deployment_enabled);
    const projects: any[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, enabled.length) }, async () => {
        while (next < enabled.length) {
          const p = enabled[next++];
          const row: any = { project_id: p.id, project_name: p.name };
          try {
            row.applications = (await this.apps(p.id)).map((a) => ({
              application_id: a.id,
              application_name: a.name,
              services: (a.services ?? []).map((s: any) => {
                const v = publicService(s, p.id, a.id);
                return {
                  service_id: v.id,
                  service_name: v.name,
                  status: v.status,
                  image_id: v.image_id,
                  public_url: v.public_url,
                  ports: (v.ports ?? []).map((x: any) => ({
                    number: x.number,
                    public: !!x.expose_to_internet,
                  })),
                };
              }),
            }));
          } catch (err) {
            if (err instanceof ToolError && err.code === "needs_auth")
              throw err;
            row.error =
              err instanceof ToolError
                ? err.message
                : "Could not load applications.";
          }
          projects.push(row);
        }
      }),
    );
    const order = new Map(enabled.map((p, n) => [p.id, n]));
    projects.sort(
      (a, b) => order.get(a.project_id)! - order.get(b.project_id)!,
    );
    const apps = projects.flatMap((p) => p.applications ?? []);
    return {
      summary: `${projects.length} of ${all.length} projects have deployment enabled; ${apps.length} applications, ${apps.reduce((n, a) => n + a.services.length, 0)} services. Statuses are native; started is not readiness.`,
      projects,
      projects_without_deployment: all
        .filter((p) => !p.deployment_enabled)
        .map((p) => p.name),
      readiness: "unverified",
    };
  }
  async get(raw: unknown) {
    const input = getInput.parse(raw);
    if (!input.deployment_id) {
      if (!input.project_id) return this.overview();
      await this.project(input.project_id);
      if (input.application_id) {
        const a = await this.app(input.project_id, input.application_id);
        return {
          ...a,
          services: a.services.map((s: any) =>
            this.observed(publicService(s, input.project_id!, a.id)),
          ),
          readiness: "unverified",
        };
      }
      const [desks, images, applications, hardware] = await Promise.all([
        this.rows(this.root(input.project_id) + "/desks"),
        this.images(input.project_id),
        this.apps(input.project_id),
        this.rows(this.root(input.project_id) + "/hardware-configurations"),
      ]);
      return {
        project_id: input.project_id,
        desks: desks.map((d) => ({
          id: d.id,
          name: d.name,
          state: d.state,
          storage_size_gb: d.storage_size_gb,
        })),
        images: images.map((i) => ({
          id: i.id,
          name: i.name,
          desk_id: i.desk_id,
          dockerfile: i.dockerfile,
          build_status: i.build_status,
          tag: i.tag,
        })),
        hardware_options: hardwareOptions(hardware),
        applications: applications.map((a) => ({
          ...a,
          services: a.services.map((s: any) =>
            publicService(s, input.project_id!, a.id),
          ),
        })),
      };
    }
    return this.store.exclusive(async () => {
      const op = await this.store.load(input.deployment_id!);
      if (!op) bad("Deployment ID not found.");
      if (input.files_uploaded !== undefined) {
        op.input.files_uploaded = input.files_uploaded;
        await this.store.save(op);
      }
      return input.resume ? this.advance(op) : this.view(op, false);
    });
  }
  private async mutate(
    op: Operation,
    method: string,
    path: string,
    body: unknown,
    apply: (data: any) => void,
  ) {
    const stage = /\/images$/.test(path)
      ? "build"
      : /\/start$/.test(path)
        ? "start"
        : /\/stop$/.test(path)
          ? "stop"
          : path.includes("/services")
            ? "configure"
            : "prepare";
    const targetId = /\/(start|stop)$/.test(path)
      ? path.split("/").at(-2)
      : path.split("/").at(-1);
    const named = (body as any)?.name
      ? (op.input.services ?? []).find((s: ServiceInput) =>
          namedFor(s.build?.name ?? s.name, (body as any)?.name),
        )
      : undefined;
    const mapped = Object.entries(op.services).find(
      ([, id]) => id === targetId,
    )?.[0];
    op.action = {
      stage,
      service:
        named?.name ??
        mapped ??
        (["start", "stop"].includes(stage) ? op.action?.service : undefined),
      dockerfile: stage === "build" ? (body as any)?.dockerfile : undefined,
    };
    op.pending = { method, path };
    await this.store.save(op);
    try {
      const result = await this.api.request(method, path, body);
      if (
        method === "POST" &&
        !/\/(start|stop)$/.test(path) &&
        !/^[a-zA-Z0-9_-]{4,128}$/.test(result?.id ?? "")
      )
        throw new ToolError(
          "uncertain_outcome",
          "Create response did not contain a valid resource ID. Inspect resources before retrying.",
        );
      apply(result);
      op.revision = (op.revision ?? 0) + 1;
      delete op.pending;
      await this.store.save(op);
    } catch (err) {
      if (err instanceof ToolError && err.code !== "uncertain_outcome") {
        delete op.pending;
        await this.store.save(op);
      }
      throw err;
    }
  }
  private async advance(op: Operation): Promise<any> {
    if (op.pending) {
      op.status = "needs_reconciliation";
      op.message =
        "A previous mutation has an uncertain outcome. Use get_deployment(project_id) or list_images to inspect resources, then start a new request using their IDs; do not blindly repeat creation.";
      await this.store.save(op);
      return this.view(op);
    }
    if (terminal.has(op.status)) return this.view(op);
    try {
      op.message = undefined;
      await this.api.request("GET", "/auth/session");
      if (op.kind === "build") return await this.advanceBuild(op);
      if (op.kind === "start" || op.kind === "stop")
        return await this.advanceLifecycle(op);
      return await this.advanceApp(op);
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      if (err.code === "invalid_input") throw err;
      op.status =
        err.code === "needs_auth"
          ? "needs_auth"
          : err.code === "uncertain_outcome"
            ? "needs_reconciliation"
            : err.code === "connection_error" || err.code === "not_ready"
              ? "waiting"
              : "failed";
      op.message =
        op.status === "failed"
          ? `${err.message} Please check the logs in Constructor.`
          : err.message;
      if (op.status === "failed") {
        op.failure = op.action ?? {
          stage: op.kind === "build" ? "build" : "deployment",
        };
        op.message = `${op.failure.stage} failed${op.failure.service ? ` for ${op.failure.service}` : ""}. Please check the logs in Constructor.`;
        const id = op.failure.service && op.services[op.failure.service];
        const log = id && (await this.logs?.peek(id, "service", 20));
        if (log) {
          op.failure = { ...op.failure, log_tail: log.lines };
          op.message = `${op.failure.stage} failed for ${op.failure.service}. The last service log lines are in failure.log_tail (get_logs with the service ID shows up to 50).`;
        }
      }
      await this.store.save(op);
      return this.view(op);
    }
  }
  private async advanceBuild(op: Operation) {
    const i = op.input;
    await this.project(i.project_id);
    await this.desk(i.project_id, i.desk_id);
    if (!op.images.image) {
      const p = await this.project(i.project_id);
      if (!p.deployment_enabled) {
        await this.mutate(
          op,
          "PATCH",
          this.root(i.project_id),
          { deployment_enabled: true },
          () => {
            op.status = "preparing";
          },
        );
        return this.view(op);
      }
      if (await this.settling(op, i.desk_id)) return this.view(op);
      const body = {
        name: imageName(i.name, await this.images(i.project_id), false),
        dockerfile: i.dockerfile,
        ...(i.ephemeral_build_disk_size_gb === undefined
          ? {}
          : { ephemeral_build_disk_size_gb: i.ephemeral_build_disk_size_gb }),
      };
      await this.mutate(
        op,
        "POST",
        `/desks/${e(i.desk_id)}/images`,
        body,
        (d) => {
          op.images.image = d.id;
          op.status = "building";
        },
      );
      return this.view(op);
    }
    const image = (await this.images(i.project_id, i.desk_id)).find(
      (x) => x.id === op.images.image,
    );
    if (image) this.followLogs(op, [image]);
    op.status = image?.build_status === "done" ? "built" : "building";
    if (image?.build_status === "error") {
      const next = await this.buildError(op, "image", image, i);
      if (next === "fail")
        await this.buildFailed(op, "image", image, i.desk_id, i.dockerfile);
    } else if (op.errorSeen) delete op.errorSeen.image;
    await this.store.save(op);
    return this.view(op);
  }
  private async advanceLifecycle(op: Operation) {
    const a = await this.app(op.project_id!, op.application_id!);
    const requested =
      op.input.service_names ?? a.services.map((s: any) => s.name);
    for (const name of requested)
      if (!a.services.some((s: any) => s.name === name))
        bad(`Service ${name} does not exist in this application.`);
    const done = op.kind === "start" ? op.started : op.stopped;
    for (const s of a.services.filter((s: any) => requested.includes(s.name))) {
      if (done.includes(s.id)) continue;
      if (op.kind === "start" && s.status === "stopping") {
        op.status = "waiting";
        await this.store.save(op);
        return this.view(op);
      }
      if (
        (op.kind === "stop" && ["stopped", "stopping"].includes(s.status)) ||
        (op.kind === "start" && ["running", "starting"].includes(s.status))
      ) {
        done.push(s.id);
        continue;
      }
      op.action = { stage: op.kind, service: s.name };
      await this.mutate(
        op,
        "POST",
        `/services/${e(s.id)}/${op.kind}`,
        undefined,
        () => {
          done.push(s.id);
          op.status =
            done.length === requested.length
              ? op.kind === "start"
                ? "started"
                : "stopped"
              : "applying";
        },
      );
      return this.view(op);
    }
    op.status = op.kind === "start" ? "started" : "stopped";
    await this.store.save(op);
    return this.view(op);
  }
  private async advanceApp(op: Operation): Promise<any> {
    const input = op.input;
    // For a new project all sources must be builds; image IDs are project-scoped.
    if (!op.project_id) {
      if (
        input.services.some(
          (s: ServiceInput) => !s.build || s.build.desk_id || s.service_id,
        )
      )
        bad(
          "A new project requires build sources without existing disk/service IDs.",
        );
      const matches = (await this.rows("/projects")).filter(
        (p) => p.name === (input.project_name ?? input.application_name),
      );
      if (matches.length)
        bad(
          "A project with this name exists. Discover its ID with get_deployment before proceeding.",
        );
      await this.mutate(
        op,
        "POST",
        "/projects",
        { name: input.project_name ?? input.application_name },
        (p) => {
          op.project_id = p.id;
          op.status = "preparing";
        },
      );
      return this.view(op);
    }
    const project = await this.project(op.project_id);
    if (project.status && project.status !== "active")
      throw new ToolError(
        "not_ready",
        "Project is not active yet; retry later.",
      );
    const applications = await this.apps(op.project_id);
    let app = op.application_id
      ? one(
          applications.filter((a) => a.id === op.application_id),
          "Ambiguous application ID.",
        )
      : undefined;
    if (op.application_id && !app)
      bad("Application does not belong to this project or does not exist.");
    if (!app && applications.some((a) => a.name === input.application_name))
      bad(
        "Application name already exists. Use update_app with its application ID.",
      );
    const services: ServiceInput[] = ordered(
      input.services,
      app?.services ?? [],
    );
    const [images, hardware] = await Promise.all([
      this.images(op.project_id),
      this.rows(this.root(op.project_id) + "/hardware-configurations"),
    ]);
    const existing = (s: ServiceInput) => {
      const old = s.service_id
        ? (app?.services ?? []).find((x: any) => x.id === s.service_id)
        : one(
            (app?.services ?? []).filter((x: any) => x.name === s.name),
            "Service name is ambiguous; provide service_id.",
          );
      if (s.service_id && !old)
        bad("service_id does not belong to this application.");
      if (
        old &&
        old.name !== s.name &&
        (app?.services ?? []).some(
          (x: any) => x.name === s.name && x.id !== old.id,
        )
      )
        bad("Service name is already used.");
      return old;
    };
    /** Requested minimums pick the smallest fitting option; otherwise keep the current or use the default. */
    const hardwareFor = (s: ServiceInput, old: any) => {
      if (!s.hardware)
        return old?.hardware_configuration_id ?? fitting(hardware, {})?.id;
      const hw = fitting(hardware, s.hardware);
      if (!hw)
        bad(
          `No available hardware meets ${JSON.stringify(s.hardware)} for ${s.name}. Options: ${JSON.stringify(hardwareOptions(hardware))}.`,
        );
      return hw.id;
    };
    const resolvedIds = new Set<string>();
    for (const s of services) {
      const old = existing(s);
      if (old && resolvedIds.has(old.id))
        bad(
          "Each existing service can be targeted only once, whether selected by name or ID.",
        );
      if (old) resolvedIds.add(old.id);
      if (!old && !s.image_id && !s.build)
        bad(`New service ${s.name} requires image_id or build.`);
      if (s.image_id) {
        const im = images.find((x) => x.id === s.image_id);
        if (!im || im.build_status !== "done")
          bad(
            `Image for ${s.name} is missing or not successfully built in this project.`,
          );
      }
      const hw = hardwareFor(s, old);
      if (!hw || !hardware.some((h) => h.id === hw && !h.removed))
        bad(`No valid hardware configuration for ${s.name}.`);
      if (s.build?.desk_id) await this.desk(op.project_id, s.build.desk_id);
      for (const key of ["ports", "volumes"] as const) {
        for (const item of s[key] ?? []) {
          if (item.id && !old?.[key].some((v: any) => v.id === item.id))
            bad(`Unknown ${key} ID for ${s.name}.`);
        }
      }
    }
    // Removing or changing an existing volume wipes its data: ask the user once for the whole list.
    const wiped: string[] = [];
    for (const s of services) {
      const old = existing(s);
      if (!old || s.volumes === undefined) continue;
      for (const v of old.volumes ?? []) {
        const next = s.volumes.find((x) =>
          x.id ? x.id === v.id : x.name === v.name,
        );
        if (!next)
          wiped.push(`${s.name}: ${v.name} (${v.mount_point}) removed`);
        else if (
          next.name !== v.name ||
          next.mount_point !== v.mount_point ||
          next.size_gb !== v.size_gb
        )
          wiped.push(`${s.name}: ${v.name} (${v.mount_point}) changed`);
      }
    }
    if (wiped.length && !input.confirm_volume_wipe) {
      op.status = "confirm_required";
      op.volumes_to_wipe = wiped;
      op.message = `These volumes would lose all their data: ${wiped.join("; ")}. Nothing was changed. Ask the user once; after approval repeat the same call with confirm_volume_wipe=true.`;
      await this.store.save(op);
      return this.view(op);
    }
    if (!project.deployment_enabled) {
      await this.mutate(
        op,
        "PATCH",
        this.root(op.project_id),
        { deployment_enabled: true },
        () => {
          op.status = "preparing";
        },
      );
      return this.view(op);
    }
    const builds = services.filter((s) => s.build);
    for (const s of builds) {
      if (op.desks[s.name]) continue;
      if (s.build!.desk_id) {
        op.desks[s.name] = s.build!.desk_id;
        continue;
      }
      const desks = await this.rows(this.root(op.project_id) + "/desks");
      // One shared upload disk for all sources without an explicit disk.
      const shared = Object.entries(op.desks).find(
        ([name]) => !services.find((s) => s.name === name)?.build?.desk_id,
      )?.[1];
      const chosen = shared ?? (desks.length === 1 ? desks[0].id : undefined);
      if (chosen) {
        op.desks[s.name] = chosen;
        continue;
      }
      await this.mutate(
        op,
        "POST",
        this.root(op.project_id) + "/desks",
        {
          name: `${input.application_name ?? app?.name ?? "application"}-source`,
        },
        (d) => {
          op.desks[s.name] = d.id;
          op.status = "preparing";
        },
      );
      return this.view(op);
    }
    if (builds.length && !input.files_uploaded) {
      op.status = "needs_upload";
      op.message =
        "Upload the source files and Dockerfiles to the listed disks with sync_files, then call get_deployment with files_uploaded=true.";
      await this.store.save(op);
      return this.view(op);
    }
    for (const s of builds) {
      const deskId = op.desks[s.name];
      await this.desk(op.project_id, deskId);
      if (op.images[s.name]) continue;
      if (await this.settling(op, deskId)) return this.view(op);
      const b = s.build!;
      const body = {
        name: imageName(b.name ?? s.name, images, !b.name),
        dockerfile: b.dockerfile!,
        ...(b.ephemeral_build_disk_size_gb === undefined
          ? {}
          : { ephemeral_build_disk_size_gb: b.ephemeral_build_disk_size_gb }),
      };
      await this.mutate(
        op,
        "POST",
        `/desks/${e(deskId)}/images`,
        body,
        (im) => {
          op.images[s.name] = im.id;
          op.status = "building";
        },
      );
      return this.view(op);
    }
    this.followLogs(op, images);
    for (const s of builds) {
      const im = images.find((x) => x.id === op.images[s.name]);
      if (im?.build_status === "error") {
        const source = {
          desk_id: op.desks[s.name],
          dockerfile: s.build!.dockerfile!,
          local_path: s.build!.local_path,
          remote_path: s.build!.remote_path,
        };
        const next = await this.buildError(op, s.name, im, source);
        op.status = "building";
        if (next === "fail")
          await this.buildFailed(
            op,
            s.name,
            im,
            source.desk_id,
            source.dockerfile,
            s.name,
          );
        await this.store.save(op);
        return this.view(op);
      }
      if (op.errorSeen) delete op.errorSeen[s.name];
      if (im?.build_status !== "done") {
        op.status = "building";
        await this.store.save(op);
        return this.view(op);
      }
    }
    if (!app) {
      await this.mutate(
        op,
        "POST",
        this.root(op.project_id) + "/applications",
        { name: input.application_name },
        (a) => {
          op.application_id = a.id;
          op.status = "configuring";
        },
      );
      return this.view(op);
    }
    for (const s of services) {
      let old = existing(s);
      if (old) op.services[s.name] = old.id;
      const serviceId = op.services[s.name] ?? old?.id;
      if (!op.applied.includes(s.name)) {
        if (
          old &&
          ["running", "starting"].includes(old.status) &&
          !op.stopped.includes(old.id)
        ) {
          await this.mutate(
            op,
            "POST",
            `/services/${e(old.id)}/stop`,
            undefined,
            () => {
              op.stopped.push(old.id);
              op.status = "configuring";
            },
          );
          return this.view(op);
        }
        if (old && old.status === "stopping") {
          op.status = "waiting";
          await this.store.save(op);
          return this.view(op);
        }
        const body = this.serviceBody(
          s,
          old,
          op,
          hardwareFor(s, old),
          app.services,
        );
        const path = old
          ? `/applications/${e(app.id)}/services/${e(old.id)}`
          : `/applications/${e(app.id)}/services`;
        await this.mutate(op, old ? "PATCH" : "POST", path, body, (d) => {
          op.services[s.name] = old?.id ?? d.id;
          op.applied.push(s.name);
          op.status = "configuring";
        });
        return this.view(op);
      }
      if (!op.started.includes(s.name)) {
        if (!serviceId) bad("Service ID missing from checkpoint.");
        await this.mutate(
          op,
          "POST",
          `/services/${e(serviceId)}/start`,
          undefined,
          () => {
            op.started.push(s.name);
            op.status = "starting";
          },
        );
        // A restarted container starts with an empty log: follow from the start.
        this.logs?.follow(serviceId, "service");
        return this.view(op);
      }
    }
    if (!(await this.ready(op, app.id))) {
      op.status = "verifying";
      await this.store.save(op);
      return this.view(op);
    }
    op.status = "started";
    await this.store.save(op);
    return this.view(op);
  }
  private serviceBody(
    s: ServiceInput,
    old: any,
    op: Operation,
    hardwareId?: string,
    existingServices: any[] = [],
  ) {
    const ports =
      s.ports === undefined
        ? (old?.ports ?? [])
        : s.ports.map((p) => ({
            ...p,
            ...(!p.id && old?.ports.find((v: any) => v.number === p.number)
              ? { id: old.ports.find((v: any) => v.number === p.number).id }
              : {}),
          }));
    const volumes =
      s.volumes === undefined
        ? (old?.volumes ?? [])
        : s.volumes.map((v) => ({
            ...v,
            ...(!v.id && old?.volumes.find((x: any) => x.name === v.name)
              ? { id: old.volumes.find((x: any) => x.name === v.name).id }
              : {}),
          }));
    const env = new Map<string, any>(
      (old?.environment_variables ?? []).map((v: any) => [v.name, v]),
    );
    for (const [name, raw] of Object.entries(s.environment_variables ?? {})) {
      let value: string;
      if (typeof raw === "string") value = raw;
      else if (raw.exposure === "public") {
        const target =
          existingServices.find((s) => s.id === op.services[raw.service]) ??
          existingServices.find((s) => s.name === raw.service);
        if (!target) bad(`Public service ${raw.service} has not been created.`);
        value = target.link ?? `https://${target.id}.constructor.pro`;
      } else
        value = `${raw.scheme ? raw.scheme + "://" : ""}${internal(op.project_id!, op.application_id!, raw.service, raw.port!)}`;
      env.set(name, {
        ...(env.get(name)?.id ? { id: env.get(name).id } : {}),
        name,
        value,
      });
    }
    return {
      name: s.name,
      image_id: op.images[s.name] ?? s.image_id ?? old?.image_id,
      hardware_configuration_id: hardwareId,
      ports,
      volumes,
      environment_variables: [...env.values()],
    };
  }
  /** readiness: http_ok / not_responding / no_public_url once checked, else unverified. */
  readinessView(op: Operation) {
    const checks = op.readiness?.checks ?? {};
    const names = Object.keys(checks);
    if (op.status !== "started" || !op.readiness)
      return {
        readiness: "unverified",
        message: op.message ?? (op.status === "started" ? NOTICE : undefined),
      };
    const failing = names.filter((n) => !checks[n].ok);
    const readiness = !names.length
      ? "no_public_url"
      : failing.length
        ? "not_responding"
        : "http_ok";
    return {
      readiness,
      readiness_checks: names.length ? checks : undefined,
      message:
        op.message ??
        (readiness === "http_ok"
          ? `Started; the public URL answers (${names.map((n) => `${n}: HTTP ${checks[n].status}`).join(", ")}).`
          : readiness === "no_public_url"
            ? "Started. No public port, so readiness was not checked over HTTP."
            : `Started, but ${failing.map((n) => `${n} (${checks[n].url}: ${checks[n].status === null ? "no answer" : `HTTP ${checks[n].status}`})`).join(", ")} did not answer within ${this.api.config.readinessSeconds ?? 60} s. ${silentHint(op.readiness.silent)}`),
    };
  }
  private async view(op: Operation, cache = true): Promise<any> {
    let services: any[] = [];
    let images: any[] = [];
    try {
      if (op.project_id && Object.keys(op.images).length) {
        const all = await this.images(op.project_id);
        images = Object.entries(op.images).map(([service, id]) => ({
          service,
          id,
          build_status: all.find((x) => x.id === id)?.build_status ?? "unknown",
        }));
      }
      if (op.application_id && op.project_id) {
        const a = await this.app(op.project_id, op.application_id);
        services = a.services.map((s: any) =>
          this.observed(publicService(s, op.project_id!, op.application_id!)),
        );
      }
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
    }
    const result = {
      deployment_id: op.id,
      operation: op.kind,
      status: op.status,
      project_id: op.project_id,
      application_id: op.application_id,
      images,
      services,
      failure: op.failure,
      build_retried: op.retried,
      replaced: op.replaced,
      volumes_to_wipe: op.volumes_to_wipe,
      ...this.readinessView(op),
      ...(op.status === "needs_upload"
        ? {
            upload_targets: Object.entries(op.desks).map(
              ([service, desk_id]) => ({
                service,
                desk_id,
                dockerfile: op.input.services.find(
                  (s: ServiceInput) => s.name === service,
                )?.build?.dockerfile,
                project_url: `${this.api.config.baseUrl}/research/projects/${op.project_id}`,
              }),
            ),
          }
        : {}),
      next_action:
        op.status === "failed"
          ? "Tell the user which stage/service failed and pass on the message. failure.log_tail has the last log lines when the MCP captured them; get_logs shows more. Do not use browser or other tools to investigate."
          : terminal.has(op.status)
            ? undefined
            : op.status === "needs_auth"
              ? `${this.api.authHelp("The token expired or is invalid.")} Then call get_deployment with this deployment_id.`
              : op.status === "needs_upload"
                ? "Upload files with sync_files, then call get_deployment with files_uploaded=true."
                : "Execution continues automatically in the MCP. Use get_deployment with wait_seconds=20 to wait for the result; do not orchestrate individual steps.",
    };
    if (cache) {
      op.result = result;
      await this.store.save(op);
    }
    return result;
  }
}
