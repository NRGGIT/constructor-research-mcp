import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PlatformApi, ToolError, segment } from "./api.js";

/** Lines kept per build or service, in memory and in its file. */
export const KEEP = 2000;
/** The most lines get_logs returns at once. */
export const SHOW = 500;
/** Periods of watching kept per log. */
const PERIODS = 20;
/** Longer lines are cut, so one runaway line cannot fill memory. */
const WIDTH = 1000;
const ID = /^[a-zA-Z0-9_-]{4,128}$/;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)(?: |$)/;
/** What the platform prints, unstamped, before a container's first line. */
const WAITING = /^Container is waiting to start/i;
/** Restart times kept per service. */
const RESTARTS = 20;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export type LogState = "live" | "finished" | "unavailable";
/** Every connection replays the log from the start (a service: its current container), then streams. */
export type LogKind = "build" | "service";
const PATH: Record<LogKind, string> = {
  build: "image-builds",
  service: "services",
};
interface Log {
  kind: LogKind;
  /** Stop following after this time (epoch ms); interest extends it. */
  until: number;
  lines: string[];
  state: LogState;
  /** Timestamp of the newest line, to skip the history a reconnect replays. */
  last?: string;
  /** Times a new container was seen starting while followed (services). */
  restarts: string[];
  /** This connection has not shown a stamped line yet, so it may be a replay or a new container. */
  fresh?: boolean;
  /** Unstamped lines at the start of a connection, held until a stamped line tells which. */
  pending?: string[];
  /** A "new container" marker is placed and that container has not printed yet. */
  restarting?: boolean;
  /** The previous line as received, and how often it repeated, to collapse repeats. */
  previous?: string;
  repeats?: number;
  received?: string;
  error?: string;
  reader?: Promise<void>;
  saved: number;
  /** When the MCP had this log open; anything printed outside these periods is lost. */
  watched: Period[];
}
/** A stretch of time the MCP followed a log; `to` is missing while it still does. */
export interface Period {
  from: string;
  to?: string;
}
export interface LogView {
  kind: LogKind;
  id: string;
  state: LogState;
  lines: string[];
  last_received_at?: string;
  /** New containers seen starting while the MCP followed this service. */
  restarts_seen?: number;
  restarted_at?: string[];
  /** When the MCP followed this log; lines printed outside these periods were never seen. */
  watched?: Period[];
  message?: string;
}

/**
 * Follows build and service log streams and keeps the last KEEP lines of each, in memory
 * and in a file in the state directory; old files are deleted (rotate). The platform serves a build log only
 * while the build runs, and every connection replays it from the start, so a dropped
 * stream is reopened and already-seen lines are skipped. When the build ends the stream
 * closes and reopening answers "not found"; the kept lines stay readable. A service log
 * covers its current container only (a restarted container starts empty), so services are followed from their start
 * and for a while after anyone last asked.
 */
export class LogFollower {
  private logs = new Map<string, Log>();
  private readonly controller = new AbortController();
  /** Backoff between reconnects; tests shorten it. */
  retryMs = [1000, 2000, 5000, 10000, 20000];
  /** Reopen a stream that sent nothing for this long (a silent proxy timeout). */
  idleMs = 5 * 60 * 1000;
  /** How long to follow after the last interest: builds until they end, services briefly. */
  followMs: Record<LogKind, number> = {
    build: 2 * 60 * 60 * 1000,
    service: 2 * 60 * 60 * 1000,
  };
  /** Kept files older than this are deleted. */
  retainMs = 14 * 24 * 60 * 60 * 1000;
  /** Beyond this many bytes of kept files, the oldest are deleted. */
  maxBytes = 100 * 1024 * 1024;
  /** When old files were last looked for. */
  private rotated = 0;
  constructor(
    readonly api: PlatformApi,
    private readonly dir = join(api.config.stateDir, "logs"),
  ) {}

  /** Start following if nobody is; cheap to call on every poll. */
  follow(id: string, kind: LogKind = "build") {
    if (!ID.test(id) || this.controller.signal.aborted) return;
    let log = this.logs.get(`${kind}:${id}`);
    if (log) log.until = Date.now() + this.followMs[kind];
    if (log?.reader || (kind === "build" && log?.state === "finished")) return;
    if (!log) {
      log = {
        kind,
        until: Date.now() + this.followMs[kind],
        lines: [],
        restarts: [],
        state: "live",
        saved: 0,
        watched: [],
      };
      this.logs.set(`${kind}:${id}`, log);
      this.prune();
    }
    log.state = "live";
    log.error = undefined;
    log.watched.push({ from: new Date().toISOString() });
    if (log.watched.length > PERIODS) log.watched.shift();
    const current = log;
    current.reader = this.read(id, current).finally(() => {
      current.reader = undefined;
      const period = current.watched.at(-1);
      if (period && !period.to) period.to = new Date().toISOString();
      if (current.state === "live")
        current.state = current.lines.length ? "finished" : "unavailable";
      return this.save(id, current, true);
    });
  }

  /** Last `count` lines, following first if the build or service may still be running. */
  async tail(
    id: string,
    kind: LogKind = "build",
    count = 20,
    waitMs = kind === "build" ? 8000 : 1500,
  ): Promise<LogView> {
    if (!ID.test(id))
      throw new ToolError("invalid_input", `Invalid ${kind} ID.`);
    let log = this.logs.get(`${kind}:${id}`) ?? (await this.load(id, kind));
    if (log?.reader || kind === "service" || log?.state !== "finished") {
      this.follow(id, kind);
      log = this.logs.get(`${kind}:${id}`)!;
      // A new connection replays the build log so far, in bursts over a few seconds:
      // wait until it has been quiet for a second.
      const deadline = Date.now() + waitMs;
      while (
        log.reader &&
        Date.now() < deadline &&
        !(log.received && Date.now() - Date.parse(log.received) >= 1000)
      )
        await delay(100);
    }
    return this.view(id, log, count);
  }

  /** Kept lines without contacting the platform. */
  async peek(
    id: string,
    kind: LogKind = "build",
    count = 20,
  ): Promise<LogView | undefined> {
    const log = this.logs.get(`${kind}:${id}`) ?? (await this.load(id, kind));
    return log && log.lines.length ? this.view(id, log, count) : undefined;
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.logs.values()].map((log) => log.reader));
  }

  /** New containers seen starting while this service was followed. */
  restarts(id: string) {
    return this.logs.get(`service:${id}`)?.restarts ?? [];
  }

  private view(id: string, log: Log, count: number): LogView {
    const service = log.kind === "service";
    const restarts = log.restarts.length;
    const lines = log.lines.slice(-Math.max(1, Math.min(KEEP, count)));
    const said =
      log.error ??
      (restarts
        ? `The container restarted ${restarts} time${restarts > 1 ? "s" : ""} while the MCP followed it (last at ${log.restarts.at(-1)}). Lines above each "--- new container" marker come from the container before it; its last lines usually show why it stopped.`
        : undefined) ??
      (log.state === "unavailable"
        ? service
          ? "No log: the service is not running, or its current container has printed nothing (a container that keeps crashing has no current log)."
          : "No log: the build is not running and this MCP did not follow it while it ran. Constructor serves build logs only during the build."
        : log.state === "finished"
          ? service
            ? "No longer following; these are the last lines kept."
            : "The build is no longer running; these are the last lines it wrote."
          : service
            ? "Following the log of the service's current container. No lines can mean the container keeps restarting (crash loop) or has printed nothing yet."
            : undefined);
    // Every connection replays the current container from its start, so only a container
    // that started and stopped while nobody followed is lost: Constructor keeps no old logs.
    const gaps =
      service && log.state !== "live" && log.watched.length
        ? `The MCP followed this service's log ${log.watched
            .map((p) => `from ${p.from} to ${p.to ?? "now"}`)
            .join(
              ", ",
            )}. A container that started and stopped outside ${log.watched.length > 1 ? "those periods" : "that period"} left no lines here, because Constructor serves logs only while they are live.`
        : undefined;
    const more =
      log.lines.length > lines.length
        ? `${log.lines.length} lines are kept; ask for more with lines (up to ${SHOW}).`
        : undefined;
    return {
      kind: log.kind,
      id,
      state: log.state,
      lines,
      last_received_at: log.received,
      ...(restarts
        ? { restarts_seen: restarts, restarted_at: log.restarts }
        : {}),
      ...(log.watched.length ? { watched: log.watched } : {}),
      message: [said, gaps, more].filter(Boolean).join(" ") || undefined,
    };
  }

  private async read(id: string, log: Log) {
    const signal = this.controller.signal;
    for (let failures = 0; ;) {
      if (signal.aborted || Date.now() > log.until) return;
      const connection = new AbortController();
      const stop = () => connection.abort();
      signal.addEventListener("abort", stop, { once: true });
      let idle: NodeJS.Timeout | undefined;
      const watch = () => {
        clearTimeout(idle);
        idle = setTimeout(stop, this.idleMs);
      };
      try {
        watch();
        const response = await this.api.stream(
          `/${PATH[log.kind]}/${segment(id)}/logs`,
          connection.signal,
        );
        if (response.status === 404 || response.status === 421) {
          // Not running (the build is over); what was kept is final.
          await response.body?.cancel();
          return;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          if (response.status < 500) {
            log.error = `Constructor answered HTTP ${response.status} for this build log.`;
            return;
          }
          throw new ToolError("connection_error", "");
        }
        failures = 0;
        log.fresh = true;
        log.pending = [];
        let partial = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          watch();
          partial += decoder.decode(chunk, { stream: true });
          const parts = partial.split(/\r?\n/);
          partial = parts.pop()!.slice(-WIDTH * 4);
          for (const part of parts) this.add(log, part);
          await this.save(id, log);
        }
        if (partial) this.add(log, partial);
        // Held lines of a connection that never showed a stamped line are a replay or a
        // container that has not started yet; the next connection decides.
        log.pending = [];
        // A closed stream means the build ended or a proxy cut it; reopening tells which.
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ToolError && err.code === "needs_key") {
          log.error =
            "Constructor rejected the access key while following this build log; the lines below may be incomplete.";
          return;
        }
        if (++failures > 8) {
          log.error =
            "The build log connection kept failing; the lines below may be incomplete.";
          return;
        }
      } finally {
        clearTimeout(idle);
        signal.removeEventListener("abort", stop);
      }
      await delay(
        this.retryMs[Math.min(failures, this.retryMs.length - 1)],
        undefined,
        { signal },
      ).catch(() => {});
    }
  }

  private add(log: Log, raw: string) {
    let line = raw.replace(ANSI, "");
    // Server-sent-event framing, if any: keep data, drop fields and comments.
    if (/^(event|id|retry):/.test(line) || line.startsWith(":")) return;
    if (line.startsWith("data:")) line = line.slice(5).replace(/^ /, "");
    line = line.trimEnd();
    if (!line) return;
    const stamp = STAMP.exec(line)?.[1];
    if (!stamp) {
      if (log.kind === "service" && WAITING.test(line) && log.last) {
        // After a container's own lines, the platform's waiting line means a new container,
        // whether it arrives on this connection or opens the next one.
        if (log.fresh) return void log.pending?.push(line);
        this.restarted(log, new Date().toISOString());
        log.fresh = true;
        log.pending = [line];
        return;
      }
      if (log.fresh && log.last) return void log.pending?.push(line);
      return this.keep(log, line);
    }
    if (log.fresh) {
      log.fresh = false;
      const held = log.pending ?? [];
      log.pending = [];
      // A replay starts with lines already kept (its held lines were kept too); anything
      // newer on a fresh connection comes from a new container.
      if (!log.last || stamp > log.last) {
        if (log.kind === "service" && log.last) this.restarted(log, stamp);
        log.restarting = false;
        for (const h of held) this.keep(log, h);
      }
    }
    if (log.last && stamp <= log.last) return; // replayed after a reconnect
    log.last = stamp;
    // A line that is only a timestamp carries nothing to show.
    if (line.length > stamp.length) this.keep(log, line);
  }

  /** Marks a new container in the kept lines. */
  private restarted(log: Log, at: string) {
    if (log.restarting) return;
    log.restarting = true;
    log.restarts.push(at);
    if (log.restarts.length > RESTARTS) log.restarts.shift();
    this.keep(log, `--- new container (restart ${log.restarts.length}) ---`);
  }

  private keep(log: Log, line: string) {
    log.received = new Date().toISOString();
    if (line === log.previous && log.lines.length) {
      log.repeats = (log.repeats ?? 1) + 1;
      log.lines[log.lines.length - 1] = `${line} (×${log.repeats})`;
      return;
    }
    log.previous = line;
    log.repeats = 1;
    log.lines.push(line.length > WIDTH ? line.slice(0, WIDTH) + "…" : line);
    if (log.lines.length > KEEP) log.lines.shift();
  }

  /** At most every few seconds while streaming, and once at the end. */
  private async save(id: string, log: Log, force = false) {
    if (!force && Date.now() - log.saved < 5000) return;
    log.saved = Date.now();
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(this.dir, `${log.kind}-${id}.json`),
        JSON.stringify({
          state: log.reader && !force ? "live" : log.state,
          lines: log.lines,
          last: log.last,
          restarts: log.restarts,
          received: log.received,
          error: log.error,
          watched: log.watched,
        }),
        { mode: 0o600 },
      );
      if (Date.now() - this.rotated > 60 * 60 * 1000) await this.rotate();
    } catch {
      /* Logs are a convenience; never fail a deployment over them. */
    }
  }

  private async load(id: string, kind: LogKind): Promise<Log | undefined> {
    try {
      const kept = JSON.parse(
        await readFile(join(this.dir, `${kind}-${id}.json`), "utf8"),
      );
      // A "live" file was written by another process, which may have stopped.
      const log: Log = {
        kind,
        until: 0,
        lines: Array.isArray(kept.lines) ? kept.lines.slice(-KEEP) : [],
        state: kept.state === "finished" ? "finished" : "unavailable",
        last: kept.last,
        restarts: Array.isArray(kept.restarts) ? kept.restarts : [],
        received: kept.received,
        error: kept.error,
        saved: 0,
        watched: Array.isArray(kept.watched)
          ? kept.watched.filter((p: any) => typeof p?.from === "string")
          : [],
      };
      // A period another process left open ended when it last wrote the file, at the latest.
      const open = log.watched.at(-1);
      if (open && !open.to) open.to = log.received ?? open.from;
      this.logs.set(`${kind}:${id}`, log);
      return log;
    } catch {
      return undefined;
    }
  }

  /** Forget the oldest finished logs; their files remain. */
  private prune() {
    for (const [id, log] of this.logs) {
      if (this.logs.size <= 30) return;
      if (!log.reader) this.logs.delete(id);
    }
  }

  /**
   * Deletes kept files older than retainMs, then the oldest until all of them fit in
   * maxBytes. Logs being followed now are never deleted. Runs at most hourly, on save.
   */
  async rotate() {
    this.rotated = Date.now();
    try {
      const live = new Set(
        [...this.logs]
          .filter(([, log]) => log.reader)
          .map(([key]) => key.replace(":", "-") + ".json"),
      );
      const files = [];
      for (const name of await readdir(this.dir)) {
        if (!/^(build|service)-[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
        const info = await stat(join(this.dir, name)).catch(() => undefined);
        if (info) files.push({ name, at: info.mtimeMs, size: info.size });
      }
      files.sort((a, b) => b.at - a.at); // newest first
      let total = 0;
      for (const f of files) {
        total += f.size;
        const old = Date.now() - f.at > this.retainMs || total > this.maxBytes;
        if (old && !live.has(f.name)) {
          await rm(join(this.dir, f.name), { force: true });
          total -= f.size;
          const [kind, ...rest] = f.name.slice(0, -5).split("-");
          const key = `${kind}:${rest.join("-")}`;
          if (!this.logs.get(key)?.reader) this.logs.delete(key);
        }
      }
    } catch {
      /* Logs are a convenience; never fail over them. */
    }
  }
}
