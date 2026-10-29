import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PlatformApi, ToolError } from "./api.js";
import type { DeploymentEngine } from "./deployment.js";
import {
  listFilesInput,
  createFolderInput,
  syncFilesInput,
  movePathInput,
  deletePathInput,
} from "./schemas.js";

/** Single PUTs above ~9 MB are rejected with 413, so larger files go in ranged chunks. */
const CHUNK = 4 * 1024 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
const MAX_FILES = 2000;
/** Stop starting new uploads after this long so each call returns before client tool timeouts. */
const UPLOAD_WINDOW = 45000;
/** Parallel storage requests; 8 checksum requests at once drew 502s from the gateway. */
const PARALLEL = 4;
/** Constructor UI staging folder; hidden from listings and reused for our temp files. */
const TEMP = ".rolos-temp";
const TEMP_PREFIX = "mcp-upload-";
const SKIP = [
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".venv",
  ".env",
];
const LIST_LIMIT = 200;

interface Entry {
  path: string;
  type: "file" | "folder";
  size: number;
  modified?: string;
}
interface Local {
  rel: string;
  abs: string;
  size: number;
  sha256: string;
}
function bad(message: string): never {
  throw new ToolError("invalid_input", message);
}
const segs = (p: string) => p.split("/").filter(Boolean);
const href = (parts: string[], folder = false) =>
  parts.map(encodeURIComponent).join("/") + (folder && parts.length ? "/" : "");
const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const tag = (xml: string, name: string) =>
  xml.match(
    new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`),
  )?.[1];
const cap = (rows: string[]) =>
  rows.length > LIST_LIMIT
    ? [...rows.slice(0, LIST_LIMIT), `…and ${rows.length - LIST_LIMIT} more`]
    : rows;
/** Glob to RegExp: ** spans folders, * and ? stay within one name. */
function glob(p: string) {
  const body = p
    .replace(/^\/+|\/+$/g, "")
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((x) =>
      x === "**/"
        ? "(?:.*/)?"
        : x === "**"
          ? ".*"
          : x === "*"
            ? "[^/]*"
            : x === "?"
              ? "[^/]"
              : x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp("^" + body + "$");
}
function matcher(patterns: string[]) {
  const res = [...SKIP, ...patterns].map(glob);
  return (rel: string) => res.some((r) => r.test(basename(rel)) || r.test(rel));
}
async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}
/**
 * Exclude patterns from a .dockerignore in the build folder: files Docker would not send
 * to the build are not uploaded. Files with "!" exceptions are not used (we cannot express them).
 */
export async function dockerignore(folder: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(folder, ".dockerignore"), "utf8");
  } catch {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.some((l) => l.startsWith("!"))) return [];
  return lines.filter((l) => l !== "." && l !== "*" && l !== "**");
}
async function sha256(abs: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(abs)) h.update(chunk);
  return h.digest("hex");
}

export class FileManager {
  /** Last write per disk. Builds started right after an upload failed live. */
  private written = new Map<string, number>();
  /**
   * Files this process uploaded or checksummed: desk|path -> content and the server's
   * modified time. A repeat sync trusts them while size and modified time are unchanged
   * instead of asking the server for a checksum again.
   */
  private verified = new Map<
    string,
    { sha256: string; size: number; modified?: string }
  >();
  constructor(
    readonly api: PlatformApi,
    readonly engine: DeploymentEngine,
  ) {}
  /** Milliseconds a build on this disk should still wait after the last upload. */
  settleMs(desk: string) {
    const last = this.written.get(desk);
    const settle = (this.api.config.uploadSettleSeconds ?? 30) * 1000;
    return last === undefined ? 0 : Math.max(0, last + settle - Date.now());
  }

  /** One folder level; null when the folder does not exist. */
  private async folder(desk: string, parts: string[]) {
    const r = await this.api.storage("PROPFIND", desk, href(parts, true), {
      headers: { Depth: "1" },
    });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (r.status !== 207) {
      await r.body?.cancel();
      throw new ToolError(
        "api_error",
        `Storage listing returned HTTP ${r.status}.`,
        r.status,
      );
    }
    const root = this.api.davRoot(desk);
    const self = parts.join("/");
    const rows: Entry[] = [];
    for (const m of (await r.text()).matchAll(
      /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/g,
    )) {
      let path: string;
      try {
        path = decodeURIComponent(unxml(tag(m[1], "href") ?? "").trim());
      } catch {
        continue;
      }
      if (!path.startsWith(root) && path + "/" !== root) continue;
      path = path.slice(root.length).replace(/\/$/, "");
      const folder = /<(?:\w+:)?collection\s*\/>/.test(m[1]);
      if (path === self) {
        if (!folder) bad(`${self} is a file, not a folder.`);
        continue;
      }
      rows.push({
        path,
        type: folder ? "folder" : "file",
        size: folder ? 0 : Number(tag(m[1], "getcontentlength") ?? 0),
        modified: tag(m[1], "getlastmodified")?.trim(),
      });
    }
    return rows;
  }
  /** Server-side SHA-256 of a file; null when the file is missing. */
  private async checksum(desk: string, path: string, size: number) {
    if (size === 0)
      return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const r = await this.api.storage("PROPFIND", desk, href(segs(path)), {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "checksum", from: 0, to: size - 1 }),
    });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    const d: any = r.ok ? await r.json().catch(() => undefined) : undefined;
    if (typeof d?.checksum !== "string")
      throw new ToolError(
        "api_error",
        `Storage checksum returned HTTP ${r.status}.`,
        r.status,
      );
    return d.checksum as string;
  }
  /** Type of a path, or null when missing. */
  private async stat(desk: string, parts: string[]) {
    const r = await this.api.storage("PROPFIND", desk, href(parts), {
      headers: { Depth: "0" },
    });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (r.status !== 207) {
      await r.body?.cancel();
      throw new ToolError(
        "api_error",
        `Storage lookup returned HTTP ${r.status}.`,
        r.status,
      );
    }
    return /<(?:\w+:)?collection\s*\/>/.test(await r.text())
      ? ("folder" as const)
      : ("file" as const);
  }
  private async mkcol(desk: string, parts: string[]) {
    const r = await this.api.storage("MKCOL", desk, href(parts, true));
    await r.body?.cancel();
    if (r.status === 201) return true;
    if (r.status === 405) return false;
    throw new ToolError(
      r.status === 409 ? "conflict" : "api_error",
      r.status === 409
        ? `Cannot create ${parts.join("/")}: a parent path is missing or is a file.`
        : `Folder creation returned HTTP ${r.status}.`,
      r.status,
    );
  }

  async list(raw: unknown) {
    const i = listFilesInput.parse(raw);
    await this.engine.filesDesk(i.project_id, i.desk_id);
    const start = segs(i.path);
    const entries: Entry[] = [];
    const queue = [start];
    let truncated = false;
    while (queue.length && !truncated) {
      const dir = queue.shift()!;
      const rows = await this.folder(i.desk_id, dir);
      if (!rows) {
        if (dir === start) bad(`Folder ${i.path} does not exist on the disk.`);
        continue;
      }
      for (const row of rows) {
        if (row.path === TEMP) continue;
        if (entries.length >= i.max_entries) {
          truncated = true;
          break;
        }
        entries.push(row);
        if (row.type === "folder" && i.recursive) queue.push(segs(row.path));
      }
    }
    return {
      desk_id: i.desk_id,
      path: start.join("/"),
      entries,
      total: entries.length,
      truncated,
    };
  }

  async createFolder(raw: unknown) {
    const i = createFolderInput.parse(raw);
    await this.engine.filesDesk(i.project_id, i.desk_id);
    const parts = segs(i.path);
    const created: string[] = [];
    for (let n = 1; n <= parts.length; n++)
      if (await this.mkcol(i.desk_id, parts.slice(0, n)))
        created.push(parts.slice(0, n).join("/"));
    return {
      status: created.length ? "created" : "exists",
      message: created.length
        ? `Created ${created.join(", ")}.`
        : `${parts.join("/")} already exists.`,
      path: parts.join("/"),
      created,
    };
  }

  async move(raw: unknown) {
    const i = movePathInput.parse(raw);
    await this.engine.filesDesk(i.project_id, i.desk_id);
    const desk = i.desk_id;
    const plan: { from: string; to: string; type?: string; issue?: string }[] =
      [];
    for (const m of i.moves) {
      const from = segs(m.from).join("/");
      const to = segs(m.to).join("/");
      const row: (typeof plan)[number] = { from, to };
      plan.push(row);
      if (from === to) row.issue = "source and destination are the same";
      else if (to.startsWith(from + "/"))
        row.issue = "a folder cannot be moved into itself";
      else if (plan.some((p) => p !== row && p.to === to))
        row.issue = "another move in this request has the same destination";
      else {
        row.type = (await this.stat(desk, segs(from))) ?? undefined;
        if (!row.type) row.issue = "does not exist";
        else if (await this.stat(desk, segs(to)))
          row.issue = "destination already exists; it is never overwritten";
      }
    }
    const ok = plan.filter((p) => !p.issue);
    const issues = plan
      .filter((p) => p.issue)
      .map((p) => `${p.from} → ${p.to}: ${p.issue}`);
    if (!i.confirm)
      return {
        status: ok.length ? "confirm_required" : "nothing_to_do",
        message: ok.length
          ? `${ok.length} renames/moves ready${issues.length ? `, ${issues.length} cannot be done` : ""}. Nothing was changed: ask the user once to approve the whole list, then repeat the call with confirm=true.`
          : "None of the moves can be done; nothing was changed.",
        moves: ok.map((p) => ({ from: p.from, to: p.to, type: p.type })),
        issues,
      };
    const moved: string[] = [];
    for (const p of ok) {
      const folder = p.type === "folder";
      const r = await this.api.storage(
        "MOVE",
        desk,
        href(segs(p.from), folder),
        {
          headers: {
            Destination: this.api.davRoot(desk) + href(segs(p.to), folder),
            Overwrite: "F",
          },
        },
      );
      await r.body?.cancel();
      if (r.status === 201 || r.status === 204)
        moved.push(`${p.from} → ${p.to}`);
      else
        issues.push(
          `${p.from} → ${p.to}: ${
            r.status === 412
              ? "destination already exists; it is never overwritten"
              : r.status === 404 || r.status === 409
                ? "destination folder does not exist; create it with create_folder"
                : `move returned HTTP ${r.status}`
          }`,
        );
    }
    return {
      status: issues.length ? "partial" : "moved",
      message: `Moved ${moved.length}${issues.length ? `; ${issues.length} not moved` : ""}.`,
      moved,
      issues,
    };
  }

  async remove(raw: unknown) {
    const i = deletePathInput.parse(raw);
    await this.engine.filesDesk(i.project_id, i.desk_id);
    const desk = i.desk_id;
    const targets: {
      path: string;
      type: string;
      files?: number;
      folders?: number;
      truncated?: boolean;
    }[] = [];
    const issues: string[] = [];
    for (const raw of new Set(i.paths.map((p) => segs(p).join("/")))) {
      const type = await this.stat(desk, segs(raw));
      if (!type) {
        issues.push(`${raw}: does not exist`);
        continue;
      }
      const row: (typeof targets)[number] = { path: raw, type };
      if (type === "folder" && !i.confirm) {
        const inside = await this.list({
          project_id: i.project_id,
          desk_id: desk,
          path: raw,
          recursive: true,
          max_entries: 5000,
        });
        row.files = inside.entries.filter((e) => e.type === "file").length;
        row.folders = inside.total - row.files;
        row.truncated = inside.truncated;
      }
      targets.push(row);
    }
    // A path inside a folder that is also being deleted needs no request of its own.
    const top = targets.filter(
      (t) => !targets.some((o) => o !== t && t.path.startsWith(o.path + "/")),
    );
    if (!i.confirm)
      return {
        status: top.length ? "confirm_required" : "nothing_to_do",
        message: top.length
          ? `${top.length} paths would be deleted${top.some((t) => t.type === "folder") ? " (folders with all contents)" : ""}. This cannot be undone. Nothing was changed: ask the user once to approve the whole list, then repeat the call with confirm=true.`
          : "Nothing to delete.",
        delete: top,
        issues,
      };
    const deleted: string[] = [];
    for (const t of top) {
      const r = await this.api.storage(
        "DELETE",
        desk,
        href(segs(t.path), t.type === "folder"),
      );
      await r.body?.cancel();
      if (r.status === 200 || r.status === 204) deleted.push(t.path);
      else if (r.status === 404) issues.push(`${t.path}: no longer exists`);
      else issues.push(`${t.path}: delete returned HTTP ${r.status}`);
    }
    return {
      status: issues.length ? "partial" : "deleted",
      message: `Deleted ${deleted.length}${issues.length ? `; ${issues.length} not deleted` : ""}.`,
      deleted,
      issues,
    };
  }

  async sync(raw: unknown) {
    const i = syncFilesInput.parse(raw);
    const begun = Date.now();
    await this.engine.filesDesk(i.project_id, i.desk_id);
    const desk = i.desk_id;
    const dest = segs(i.remote_path);
    const skip = matcher(i.exclude);

    // Local side: files with hashes, plus every folder so empty folders are mirrored.
    const files: Local[] = [];
    const dirs = [""];
    const skipped: string[] = [];
    let info;
    try {
      info = await lstat(i.local_path);
    } catch {
      bad(`Local path ${i.local_path} does not exist or is unreadable.`);
    }
    if (info.isFile()) {
      files.push({
        rel: basename(i.local_path),
        abs: i.local_path,
        size: info.size,
        sha256: "",
      });
    } else if (info.isDirectory()) {
      const walk = async (rel: string) => {
        for (const d of await readdir(join(i.local_path, rel), {
          withFileTypes: true,
        })) {
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (skip(r)) continue;
          if (d.isDirectory()) {
            dirs.push(r);
            await walk(r);
          } else if (d.isFile()) {
            if (files.length >= MAX_FILES)
              bad(
                `More than ${MAX_FILES} files; narrow local_path or add exclude patterns.`,
              );
            const abs = join(i.local_path, r);
            files.push({
              rel: r,
              abs,
              size: (await lstat(abs)).size,
              sha256: "",
            });
          } else skipped.push(`${r} (not a regular file)`);
        }
      };
      await walk("");
    } else bad("local_path must be a regular file or folder.");
    const tooLarge = files.filter((f) => f.size > MAX_FILE);
    skipped.push(
      ...tooLarge.map((f) => `${f.rel} (over ${MAX_FILE / 1048576} MB)`),
    );
    const todo = files.filter((f) => f.size <= MAX_FILE);
    await pool(todo, 8, async (f) => {
      f.sha256 = await sha256(f.abs);
    });

    // Remote side: list only folders that mirror local ones; children of missing folders are missing too.
    const remote = new Map<string, Entry>();
    const missing = new Set<string>();
    const full = (rel: string) => [...dest, ...segs(rel)].join("/");
    for (const dir of dirs.sort((a, b) => segs(a).length - segs(b).length)) {
      const target = full(dir);
      const parent = segs(target).slice(0, -1).join("/");
      if (target && missing.has(parent)) {
        missing.add(target);
        continue;
      }
      const rows = await this.folder(desk, segs(target)).catch((err) => {
        if (err instanceof ToolError && err.code === "invalid_input")
          return "file" as const;
        throw err;
      });
      if (rows === "file")
        remote.set(target, { path: target, type: "file", size: 0 });
      else if (!rows) missing.add(target);
      else {
        remote.set(target, { path: target, type: "folder", size: 0 });
        for (const row of rows) remote.set(row.path, row);
      }
    }
    // A missing destination may also lack ancestors: find the deepest one that exists.
    const ancestors: string[] = [];
    if (missing.has(dest.join("/")))
      for (let n = dest.length - 1; n >= 1; n--) {
        const rows = await this.folder(desk, dest.slice(0, n)).catch((err) => {
          if (err instanceof ToolError && err.code === "invalid_input")
            return "file" as const;
          throw err;
        });
        if (rows === "file")
          bad(`${dest.slice(0, n).join("/")} is a file, not a folder.`);
        if (rows) break;
        ancestors.push(dest.slice(0, n).join("/"));
      }
    const blocked = (p: string) =>
      segs(p).some(
        (_, n, a) => remote.get(a.slice(0, n + 1).join("/"))?.type === "file",
      );

    const fresh: Local[] = [];
    const changed: Local[] = [];
    const conflicts: string[] = [];
    let unchanged = 0;
    const same: Local[] = [];
    for (const f of todo) {
      const p = full(f.rel);
      const e = remote.get(p);
      if (blocked(segs(p).slice(0, -1).join("/")) || e?.type === "folder")
        conflicts.push(`${p} (file/folder type mismatch)`);
      else if (!e) fresh.push(f);
      else if (e.size !== f.size) changed.push(f);
      else same.push(f);
    }
    const unchecked: string[] = [];
    await pool(same, PARALLEL, async (f) => {
      const p = full(f.rel);
      const modified = remote.get(p)?.modified;
      const known = this.verified.get(`${desk}|${p}`);
      if (
        known &&
        known.size === f.size &&
        (known.modified === undefined || known.modified === modified)
      ) {
        known.modified = modified;
        if (known.sha256 === f.sha256) unchanged++;
        else changed.push(f);
        return;
      }
      let sum: string | null;
      try {
        sum = await this.checksum(desk, p, f.size);
      } catch (err) {
        if (!(err instanceof ToolError) || err.code !== "api_error") throw err;
        unchecked.push(p);
        return;
      }
      if (sum === null) fresh.push(f);
      else {
        this.verified.set(`${desk}|${p}`, {
          sha256: sum,
          size: f.size,
          modified,
        });
        if (sum === f.sha256) unchanged++;
        else changed.push(f);
      }
    });
    const folders = dirs
      .map(full)
      .filter((p) => p && !remote.has(p) && !blocked(p));
    folders.push(...ancestors);
    folders.sort((a, b) => segs(a).length - segs(b).length);
    for (const p of dirs.map(full))
      if (p && remote.get(p)?.type === "file")
        conflicts.push(`${p} (file/folder type mismatch)`);
    const plan = {
      new_files: cap(fresh.map((f) => full(f.rel))),
      changed_files: cap(changed.map((f) => full(f.rel))),
      unchanged_count: unchanged,
      folders_to_create: cap(folders),
      conflicts: cap(conflicts),
      skipped: cap(skipped),
    };
    const summary = `${fresh.length} new, ${changed.length} changed, ${unchanged} unchanged, ${folders.length} folders to create, ${conflicts.length} conflicts, ${skipped.length} skipped${unchecked.length ? `, ${unchecked.length} not checked (storage busy)` : ""}`;
    if (i.dry_run)
      return {
        status: "planned",
        message: `${summary}. Nothing was uploaded (dry run).`,
        ...plan,
      };
    if (changed.length && !i.confirm)
      return {
        status: "confirm_required",
        message: `${summary}. ${changed.length} existing files would be replaced. Nothing was uploaded: ask the user once to approve the whole list, then repeat the call with confirm=true.`,
        ...plan,
      };

    // Apply: folders, then each file via a temp upload moved into place.
    if (fresh.length || changed.length) {
      await this.mkcol(desk, [TEMP]);
      for (const row of (await this.folder(desk, [TEMP])) ?? [])
        if (row.type === "file" && basename(row.path).startsWith(TEMP_PREFIX)) {
          const r = await this.api.storage(
            "DELETE",
            desk,
            href(segs(row.path)),
          );
          await r.body?.cancel();
        }
    }
    for (const p of folders) await this.mkcol(desk, segs(p));
    const uploaded: string[] = [];
    const failed: string[] = [];
    const queue = [
      ...fresh.map((f) => ({ f, replace: false })),
      ...changed.map((f) => ({ f, replace: true })),
    ];
    let remaining = unchecked.length;
    let stop: unknown;
    await pool(queue, PARALLEL, async ({ f, replace }) => {
      if (stop || Date.now() - begun > UPLOAD_WINDOW) {
        remaining++;
        return;
      }
      const p = full(f.rel);
      try {
        const outcome = await this.upload(desk, f, p, replace);
        this.written.set(desk, Date.now());
        if (outcome === "uploaded") uploaded.push(p);
        else conflicts.push(`${p} (${outcome})`);
      } catch (err) {
        if (
          err instanceof ToolError &&
          ["needs_auth", "connection_error"].includes(err.code)
        ) {
          stop ??= err;
          remaining++;
          return;
        }
        failed.push(
          `${p} (${err instanceof ToolError ? err.message : "local read failed"})`,
        );
      }
    });
    if (stop && !uploaded.length) throw stop;
    const status = remaining
      ? "in_progress"
      : failed.length || conflicts.length
        ? "partial"
        : "synced";
    return {
      status,
      message:
        status === "in_progress"
          ? `Uploaded ${uploaded.length}; ${remaining} files remain. Repeat the same call to continue; finished files are skipped.`
          : status === "partial"
            ? `Uploaded ${uploaded.length}; ${failed.length} failed and ${conflicts.length} conflicts need the user's decision.`
            : `Uploaded ${uploaded.length} files; ${unchanged} were already up to date.`,
      uploaded: cap(uploaded),
      failed: cap(failed),
      conflicts: cap(conflicts),
      skipped: cap(skipped),
      unchanged_count: unchanged,
      remaining_count: remaining,
    };
  }

  /** Check each build's Dockerfile on its disk before a build is submitted. */
  async preflight(project: string, sources: BuildSource[]) {
    const missing: string[] = [];
    const warnings: string[] = [];
    for (const b of sources) {
      await this.engine.filesDesk(project, b.desk_id);
      const parts = segs(b.dockerfile);
      const r = await this.api.storage("GET", b.desk_id, href(parts));
      if (r.status === 404) {
        await r.body?.cancel();
        missing.push(`${b.service}: ${parts.join("/")}`);
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new ToolError(
          "api_error",
          `Reading ${parts.join("/")} returned HTTP ${r.status}.`,
          r.status,
        );
      }
      const text = (await r.text()).slice(0, 256 * 1024);
      warnings.push(
        ...lintDockerfile(parts.join("/"), text, b.ports).map(
          (w) => `${b.service}: ${w}`,
        ),
      );
      const dir = parts.slice(0, -1);
      for (const conf of configsCopied(text)) {
        const c = await this.api.storage(
          "GET",
          b.desk_id,
          href([...dir, ...segs(conf)]),
        );
        const body = c.ok ? (await c.text()).slice(0, 64 * 1024) : "";
        if (!c.ok) await c.body?.cancel();
        if (/^\s*listen\s+\[::\]/m.test(body))
          warnings.push(
            `${b.service}: ${conf} has "listen [::]". nginx exits on start when the cluster has no IPv6; keep only the IPv4 listen line (listen <port>;).`,
          );
      }
      for (const row of (await this.folder(b.desk_id, dir)) ?? [])
        if (/^(docker-)?compose\.ya?ml$/.test(basename(row.path)))
          warnings.push(
            `${b.service}: ${row.path} is ignored; docker-compose is not supported, so each service is configured in deploy_app.`,
          );
    }
    return { missing, warnings: [...new Set(warnings)] };
  }

  /** Upload to a fresh temp file, move it over the target, then verify the server checksum. */
  private async upload(
    desk: string,
    f: Local,
    target: string,
    replace: boolean,
  ) {
    const tmp = [TEMP, TEMP_PREFIX + randomUUID()];
    const hash = createHash("sha256");
    const put = async (body: Uint8Array<ArrayBuffer>, range?: string) => {
      const r = await this.api.storage("PUT", desk, href(tmp), {
        body,
        headers: {
          "Content-Type": "application/octet-stream",
          ...(range ? { "Content-Range": range } : {}),
        },
      });
      await r.body?.cancel();
      if (r.status !== 201 && r.status !== 204)
        throw new ToolError(
          r.status === 413 ? "too_large" : "api_error",
          `Upload returned HTTP ${r.status}.`,
          r.status,
        );
    };
    const clean = async () => {
      try {
        const r = await this.api.storage("DELETE", desk, href(tmp));
        await r.body?.cancel();
      } catch {
        /* Stale temp files are removed at the start of the next sync. */
      }
    };
    try {
      const fh = await open(f.abs, "r");
      try {
        const size = (await fh.stat()).size;
        if (size > MAX_FILE)
          throw new ToolError("too_large", "File grew past the size limit.");
        if (size === 0) await put(new Uint8Array());
        for (let at = 0; at < size; at += CHUNK) {
          const buf = Buffer.alloc(Math.min(CHUNK, size - at));
          const { bytesRead } = await fh.read(buf, 0, buf.length, at);
          if (bytesRead !== buf.length)
            throw new ToolError(
              "local_changed",
              "File changed while uploading.",
            );
          hash.update(buf);
          await put(
            buf,
            size > CHUNK
              ? `bytes ${at}-${at + buf.length - 1}/${size}`
              : undefined,
          );
        }
        f.size = size;
      } finally {
        await fh.close();
      }
      const r = await this.api.storage("MOVE", desk, href(tmp), {
        headers: {
          Destination: this.api.davRoot(desk) + href(segs(target)),
          Overwrite: replace ? "T" : "F",
        },
      });
      await r.body?.cancel();
      if (r.status === 412) {
        await clean();
        return "created by someone else during sync; not replaced";
      }
      // MOVE is not repeated: after a gateway error the checksum below tells whether it landed.
      if (r.status !== 201 && r.status !== 204 && r.status < 502)
        throw new ToolError(
          "api_error",
          `Move into place returned HTTP ${r.status}.`,
          r.status,
        );
    } catch (err) {
      await clean();
      throw err;
    }
    const sha = hash.digest("hex");
    if ((await this.checksum(desk, target, f.size)) !== sha)
      throw new ToolError(
        "verify_failed",
        "The file did not land intact (storage busy); repeat the same call.",
      );
    this.verified.set(`${desk}|${target}`, { sha256: sha, size: f.size });
    return "uploaded";
  }
}

/** Dockerfile problems the platform will not report clearly: wrong name, missing FROM/EXPOSE, localhost use. */
export function lintDockerfile(path: string, text: string, ports: number[]) {
  const out: string[] = [];
  const name = basename(path);
  if (name !== "Dockerfile" && !name.endsWith(".dockerfile"))
    out.push(
      `${name}: Constructor recognizes only "Dockerfile" or "<name>.dockerfile".`,
    );
  const lines = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const cmd = (l: string) => l.split(/\s+/)[0].toUpperCase();
  if (!lines.some((l) => cmd(l) === "FROM")) out.push("No FROM instruction.");
  const exposed = lines
    .filter((l) => cmd(l) === "EXPOSE")
    .flatMap((l) => l.split(/\s+/).slice(1))
    .map((p) => Number.parseInt(p, 10))
    .filter((p) => Number.isInteger(p));
  if (!exposed.length)
    out.push(
      "No EXPOSE: check that the service port matches the port the app listens on.",
    );
  else
    for (const p of ports)
      if (!exposed.includes(p))
        out.push(
          `Service port ${p} is not EXPOSEd (Dockerfile exposes ${exposed.join(", ")}).`,
        );
  if (
    lines.some(
      (l) =>
        ["ENV", "ARG", "CMD", "ENTRYPOINT"].includes(cmd(l)) &&
        /\b(localhost|127\.0\.0\.1)\b/.test(l),
    )
  )
    out.push(
      "Uses localhost/127.0.0.1: the app must listen on 0.0.0.0, and other services must be reached through their internal links, not localhost.",
    );
  // Compose-style service hosts ("cerbos:3592") resolve only inside docker-compose.
  const hosts = lines
    .filter((l) => cmd(l) === "ENV")
    .flatMap((l) => [
      ...l.matchAll(
        /(?:^|[\s="'])(?:[a-z][a-z0-9+.-]*:\/\/)?([a-z][a-z0-9_-]*):(\d{2,5})(?![\w.-])/gi,
      ),
    ])
    .map((m) => `${m[1]}:${m[2]}`)
    .filter((h) => !h.startsWith("localhost:"));
  if (hosts.length)
    out.push(
      `Default address ${[...new Set(hosts)].join(", ")} works only in docker-compose. Set it as a service reference in deploy_app (environment_variables) and do not bake a fallback into the image: a missing variable then points at a host that does not exist.`,
    );
  for (const script of unexecutable(lines, cmd))
    out.push(
      `${script} is run as the entrypoint but never made executable. Files uploaded to a desk lose the executable bit, so the container exits at once without printing anything. Add RUN chmod 0755 ${script} after the COPY (or COPY --chmod=0755).`,
    );
  return out;
}

/** Config files (nginx .conf/.template) the Dockerfile copies from the build context; at most five. */
function configsCopied(text: string) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .filter((l) => /^\s*(COPY|ADD)\s/i.test(l) && !/--from=/.test(l))
        .flatMap((l) => l.trim().split(/\s+/).slice(1, -1))
        .filter(
          (w) =>
            !w.startsWith("--") &&
            !/[*?\[]|^\.\.?\/?$|\.\./.test(w) &&
            /\.(conf|template)$/.test(w),
        ),
    ),
  ].slice(0, 5);
}

/** Scripts started directly by ENTRYPOINT/CMD (not through sh/bash) with no chmod in the Dockerfile. */
function unexecutable(lines: string[], cmd: (l: string) => string) {
  const chmods = lines
    .filter(
      (l) =>
        (cmd(l) === "RUN" && /\bchmod\b/.test(l)) ||
        (["COPY", "ADD"].includes(cmd(l)) && /--chmod=/.test(l)),
    )
    .join(" ");
  const copied = lines
    .filter((l) => ["COPY", "ADD"].includes(cmd(l)) && !/--from=/.test(l))
    .map((l) => l.split(/\s+/).filter((w) => !w.startsWith("--")))
    .filter((w) => w.length >= 3)
    .map((w) => ({ sources: w.slice(1, -1), dest: w.at(-1)! }));
  const out: string[] = [];
  for (const l of lines.filter((l) => ["ENTRYPOINT", "CMD"].includes(cmd(l)))) {
    const args = l.slice(cmd(l).length).trim();
    const first = args.startsWith("[")
      ? (/^\[\s*"([^"]+)"/.exec(args)?.[1] ?? "")
      : args.split(/\s+/)[0];
    if (!/\.(sh|bash)$/.test(first)) continue;
    const name = basename(first);
    // Only scripts that came from the build context; scripts in base images keep their mode.
    const fromContext = copied.some((c) =>
      c.sources.some((x) => x === "." || x === "./")
        ? true
        : c.dest.endsWith("/")
          ? c.sources.some((x) => basename(x) === name)
          : c.dest === first || basename(c.dest) === name,
    );
    if (fromContext && !chmods.includes(name) && !chmods.includes("*.sh"))
      out.push(first);
  }
  return [...new Set(out)];
}

export interface BuildSource {
  service: string;
  desk_id: string;
  dockerfile: string;
  ports: number[];
}
