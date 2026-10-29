import { setTimeout as delay } from "node:timers/promises";
import { DeploymentEngine, terminal } from "./deployment.js";
import { ToolError } from "./api.js";
import { waitCommand } from "./config.js";
import {
  buildInput,
  deployInput,
  updateInput,
  lifecycleInput,
  getInput,
} from "./schemas.js";

export const paused = new Set(["needs_auth", "needs_upload"]);
/** Tells the agent which unfinished deployments a new one ended, and what they changed that it does not. */
function replacedNote(
  replaced?: { deployment_id: string; services_not_included: string[] }[],
) {
  if (!replaced?.length) return undefined;
  const dropped = [
    ...new Set(replaced.flatMap((r) => r.services_not_included)),
  ];
  return `Replaced unfinished deployment ${replaced.map((r) => r.deployment_id).join(", ")} of this application${
    dropped.length
      ? `; its changes to ${dropped.join(", ")} are not applied (repeat update_app including them if they should still change)`
      : ""
  }.`;
}
interface Running {
  controller: AbortController;
  task: Promise<void>;
}

/** Owns execution. The agent submits intent and observes results, never engine steps. */
export class DeploymentRuntime {
  private active = new Map<string, Running>();
  private closed = false;
  constructor(
    readonly engine: DeploymentEngine,
    private readonly pollMilliseconds = 5000,
  ) {}

  async recover() {
    for (const id of await this.engine.store.ids()) {
      try {
        const op = await this.engine.store.load(id);
        if (op && !terminal.has(op.status) && op.status !== "needs_upload")
          this.wake(id);
      } catch {
        /* Corrupt/foreign checkpoints must not prevent MCP startup. */
      }
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((j) => j.task));
  }
  async deploy(raw: unknown) {
    const i = deployInput.parse(raw);
    if (i.deployment_id) await this.pause(i.deployment_id);
    return this.execute(() => this.engine.deploy(i), i.wait_seconds);
  }
  async update(raw: unknown) {
    const i = updateInput.parse(raw);
    if (i.deployment_id) await this.pause(i.deployment_id);
    return this.execute(() => this.engine.update(i), i.wait_seconds);
  }
  async buildImage(raw: unknown) {
    const i = buildInput.parse(raw);
    return this.execute(() => this.engine.buildImage(i), i.wait_seconds);
  }
  async lifecycle(kind: "start" | "stop", raw: unknown) {
    const i = lifecycleInput.parse(raw);
    return this.execute(() => this.engine.lifecycle(kind, i), i.wait_seconds);
  }
  async get(raw: unknown) {
    const i = getInput.parse(raw);
    if (!i.deployment_id)
      return this.engine.api.withBudget(20000, () => this.engine.get(i));
    const start = Date.now();
    if (i.files_uploaded !== undefined) {
      await this.pause(i.deployment_id);
      await this.engine.api.withBudget(15000, () =>
        this.engine.get({ ...i, resume: true }),
      );
    }
    let op = await this.engine.store.load(i.deployment_id);
    if (
      op?.status === "needs_auth" &&
      i.resume &&
      i.files_uploaded === undefined
    ) {
      await this.pause(i.deployment_id);
      await this.engine.api.withBudget(15000, () =>
        this.engine.get({ ...i, resume: true }),
      );
      op = await this.engine.store.load(i.deployment_id);
    }
    if (!op) throw new ToolError("invalid_input", "Deployment ID not found.");
    if (i.resume && op.status !== "needs_upload" && !terminal.has(op.status))
      this.wake(i.deployment_id);
    const result = await this.wait(
      i.deployment_id,
      i.resume ? Math.max(0, i.wait_seconds * 1000 - (Date.now() - start)) : 0,
    );
    if (["started", "stopped", "built"].includes(result.status)) {
      try {
        const live = await this.engine.api.withBudget(3000, () =>
          this.engine.observe(i.deployment_id!),
        );
        if (live.services?.length) result.services = live.services;
        if (live.images?.length) result.images = live.images;
      } catch {
        /* Preserve the last known result if a read-only refresh is unavailable. */
      }
    }
    return result;
  }
  private async execute(fn: () => Promise<any>, seconds: number) {
    const start = Date.now();
    const result = await this.engine.api.withBudget(15000, fn);
    if (!terminal.has(result.status) && !paused.has(result.status))
      this.wake(result.deployment_id);
    return this.wait(
      result.deployment_id,
      Math.max(0, seconds * 1000 - (Date.now() - start)),
    );
  }
  private async pause(id: string) {
    const job = this.active.get(id);
    if (job) {
      job.controller.abort();
      await job.task;
    }
  }
  private wake(id: string) {
    if (this.closed || this.active.has(id)) return;
    const job: Running = {
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.active.set(id, job);
    job.task = this.run(id, job.controller.signal).finally(() => {
      if (this.active.get(id) === job) this.active.delete(id);
    });
  }
  private async run(id: string, signal: AbortSignal) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (!signal.aborted && !this.closed) {
      try {
        const before = await this.engine.store.load(id);
        if (!before || terminal.has(before.status)) return;
        await this.engine.store.beat(id);
        if (Date.now() > deadline)
          throw new ToolError(
            "execution_timeout",
            "Deployment execution exceeded one hour. Please check the logs in Constructor.",
          );
        const result = await this.engine.api.withBudget(20000, () =>
          this.engine.get({ deployment_id: id, resume: true, wait_seconds: 0 }),
        );
        if (terminal.has(result.status) || paused.has(result.status)) return;
        const after = await this.engine.store.load(id);
        if (
          (result.status === "building" || result.status === "waiting") &&
          (after?.revision ?? 0) === (before.revision ?? 0)
        )
          await delay(this.pollMilliseconds, undefined, { signal });
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ToolError && err.code === "busy") {
          await delay(Math.min(1000, this.pollMilliseconds), undefined, {
            signal,
          }).catch(() => {});
          continue;
        }
        // API failures normally become structured engine results. Persist unexpected local failures too.
        try {
          await this.engine.store.exclusive(async () => {
            const op = await this.engine.store.load(id);
            if (!op) return;
            op.status = op.pending ? "needs_reconciliation" : "failed";
            op.message =
              err instanceof ToolError
                ? `${err.message} Please check the logs in Constructor.`
                : "Deployment execution failed. Please check the logs in Constructor.";
            op.failure = { stage: "execution" };
            await this.engine.store.save(op);
          });
        } catch (writeError) {
          if (writeError instanceof ToolError && writeError.code === "busy") {
            await delay(Math.min(1000, this.pollMilliseconds), undefined, {
              signal,
            }).catch(() => {});
            continue;
          }
        }
        return;
      }
    }
  }
  private async snapshot(id: string) {
    const op = await this.engine.store.load(id);
    if (!op) throw new ToolError("invalid_input", "Deployment ID not found.");
    // Derived from the checkpoint itself: op.result may predate the final step.
    const ready = this.engine.readinessView(op);
    return {
      ...(op.result ??
        (await this.engine.api.withBudget(15000, () =>
          this.engine.observe(id),
        ))),
      deployment_id: op.id,
      operation: op.kind,
      status: op.status,
      project_id: op.project_id,
      application_id: op.application_id,
      readiness: ready.readiness,
      readiness_checks: ready.readiness_checks,
      message:
        [ready.message ?? op.result?.message, replacedNote(op.replaced)]
          .filter(Boolean)
          .join(" ") || undefined,
      replaced: op.replaced,
      volumes_to_wipe: op.volumes_to_wipe,
      failure: op.failure,
      updated_at: op.updated_at,
      execution: terminal.has(op.status)
        ? "finished"
        : paused.has(op.status)
          ? "paused"
          : "background",
      next_action:
        op.status === "failed"
          ? "Tell the user which stage/service failed and pass on the message. failure.log_tail has the last log lines when the MCP captured them; get_logs shows more. Do not investigate using browser or other tools."
          : op.status === "needs_auth"
            ? `${this.engine.api.authHelp("The token expired or is invalid.")} Then check this deployment again.`
            : op.status === "needs_upload"
              ? "Upload the listed files with sync_files, then call get_deployment with files_uploaded=true."
              : op.status === "confirm_required"
                ? "Ask the user once whether the listed volumes may lose their data; if yes, repeat the same update with confirm_volume_wipe=true."
                : op.status === "needs_reconciliation"
                  ? "Inspect the uncertain mutation in Constructor before submitting a new operation."
                  : terminal.has(op.status)
                    ? undefined
                    : `The MCP is executing this deployment. Keep working on other things and check later with get_deployment. If nothing else is left, wait with the shell command \`${waitCommand(this.engine.api.config, [op.id])}\` (run it in the background if your client wakes you when a background command ends); it prints the outcome when the deployment finishes. Without a shell, call get_deployment with wait_seconds=20.`,
    };
  }
  private async wait(id: string, milliseconds: number) {
    const deadline = Date.now() + milliseconds;
    let result = await this.snapshot(id);
    while (
      !terminal.has(result.status) &&
      !paused.has(result.status) &&
      Date.now() < deadline &&
      !this.closed
    ) {
      await delay(Math.min(100, deadline - Date.now()));
      result = await this.snapshot(id);
    }
    return result;
  }
}
