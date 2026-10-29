import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
  readdir,
  stat,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { ToolError } from "./api.js";
export interface Operation {
  id: string;
  kind: "deploy" | "update" | "build" | "start" | "stop";
  endpoint: string;
  input: any;
  status: string;
  volumes_to_wipe?: string[];
  project_id?: string;
  application_id?: string;
  desks: Record<string, string>;
  images: Record<string, string>;
  services: Record<string, string>;
  applied: string[];
  stopped: string[];
  started: string[];
  pending?: { method: string; path: string };
  message?: string;
  created_at: string;
  updated_at: string;
  result?: any;
  action?: { stage: string; service?: string; dockerfile?: string };
  revision?: number;
  /** Image ID seen with build_status error once; a failure counts on the second sighting. */
  errorSeen?: Record<string, string>;
  /** Name of the failed image per build that was already rebuilt once. */
  retried?: Record<string, string>;
  /** Public-URL checks after start. */
  readiness?: {
    since: number;
    checks: Record<string, { url: string; status: number | null; ok: boolean }>;
    /** Services that printed nothing since they started, once the window ran out. */
    silent?: string[];
  };
  /** Earlier deployments of the same application this one replaced. */
  replaced?: { deployment_id: string; services_not_included: string[] }[];
  submission_key?: string;
  failure?: {
    stage: string;
    service?: string;
    dockerfile?: string;
    image_id?: string;
    image_name?: string;
    first_image_name?: string;
    desk_link?: string;
    /** Last build log lines, when the MCP followed the build. */
    log_tail?: string[];
  };
}
export class StateStore {
  constructor(readonly config: Config) {}
  /** The Constructor API saved operations belong to; follows a sign-in to another host. */
  get endpoint() {
    return this.config.baseUrl + this.config.apiPath;
  }
  private async init() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.stateDir, 0o700);
  }
  async load(id: string): Promise<Operation | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ToolError("invalid_input", "Invalid deployment ID.");
    try {
      const op = JSON.parse(
        await readFile(join(this.config.stateDir, `${id}.json`), "utf8"),
      ) as Operation;
      for (const field of ["desks", "images", "services"] as const)
        op[field] = Object.assign(Object.create(null), op[field]);
      if (op.endpoint !== this.endpoint)
        throw new ToolError(
          "endpoint_mismatch",
          "This operation belongs to a different Constructor endpoint.",
        );
      return op;
    } catch (e: any) {
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
  }
  async ids(): Promise<string[]> {
    await this.init();
    return (await readdir(this.config.stateDir))
      .filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n))
      .map((n) => n.slice(0, -5));
  }
  /** Marks that a process is executing this deployment right now. */
  async beat(id: string) {
    await this.init();
    await writeFile(this.alive(id), "", { mode: 0o600 });
  }
  /** Epoch ms of the last beat; 0 when none. */
  async lastBeat(id: string) {
    try {
      return (await stat(this.alive(id))).mtimeMs;
    } catch {
      return 0;
    }
  }
  private alive(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ToolError("invalid_input", "Invalid deployment ID.");
    return join(this.config.stateDir, `${id}.alive`);
  }
  async save(op: Operation) {
    await this.init();
    op.updated_at = new Date().toISOString();
    const target = join(this.config.stateDir, `${op.id}.json`),
      tmp = target + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(op, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, target);
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.init();
    const lock = join(this.config.stateDir, ".lock");
    return withLock(
      lock,
      fn,
      0,
      () =>
        new ToolError("busy", `Another operation holds ${lock}. Retry later.`),
    );
  }
}

/**
 * Runs `fn` while holding `lock`, a file created exclusively and shared by every process.
 * Waits up to `waitMs` for another holder, then throws `busy()`. A lock left by a process
 * that no longer exists is removed.
 */
export async function withLock<T>(
  lock: string,
  fn: () => Promise<T>,
  waitMs: number,
  busy: () => Error,
): Promise<T> {
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (await breakStale(lock)) continue;
      if (Date.now() >= deadline) throw busy();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(lock, "utf8")) === token) await unlink(lock);
  }
}

/**
 * Removes a lock whose process is gone (a server killed or restarted mid-step). The
 * lock is moved aside first and only deleted if it is still the dead one, so two
 * processes breaking it at once cannot delete a lock just taken by a live one.
 */
async function breakStale(lock: string) {
  let held: string;
  try {
    held = await readFile(lock, "utf8");
  } catch (e: any) {
    return e.code === "ENOENT";
  }
  let pid = NaN;
  try {
    pid = Number(JSON.parse(held).pid);
  } catch {
    /* Not a lock this server wrote; leave it. */
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || running(pid))
    return false;
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await rename(lock, aside);
  } catch (e: any) {
    return e.code === "ENOENT";
  }
  if ((await readFile(aside, "utf8")) !== held)
    // A live process took the lock in between: put it back unless another took it since.
    await link(aside, lock).catch(() => {});
  await unlink(aside);
  return true;
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}
