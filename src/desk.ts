import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The Constructor desk this MCP runs inside (VS Code in Constructor Research), from the
 * environment Constructor sets there. Its project folder is the desk's disk, so the agent edits
 * files in place and the MCP never uploads to it.
 */
export interface LocalDesk {
  projectId: string;
  deskId: string;
  /** The desk's project folder on this machine; the disk root for builds. */
  root: string;
  /** The Constructor the desk belongs to. */
  server?: string;
}

const ID = /^[a-zA-Z0-9_-]{4,128}$/;

export function localDeskFromEnv(
  env: NodeJS.ProcessEnv,
  origin: (link: string) => string,
): LocalDesk | undefined {
  if (
    ["0", "false", "off"].includes(
      (env.CONSTRUCTOR_LOCAL_DESK ?? "").toLowerCase(),
    )
  )
    return undefined;
  const projectId = env.ROLOS_PROJECT_ID || env.RESEARCH_PROJECT_ID;
  const deskId = env.ROLOS_DESK_ID || env.RESEARCH_DESK_ID;
  if (!projectId || !deskId || !ID.test(projectId) || !ID.test(deskId))
    return undefined;
  let server: string | undefined;
  try {
    const s = env.ROLOS_API_SERVER || env.RESEARCH_API_SERVER;
    server = s ? origin(s) : undefined;
  } catch {
    server = undefined;
  }
  const home = env.HOME || homedir();
  const root = resolve(env.CONSTRUCTOR_DESK_ROOT ?? join(home, "project"));
  return { projectId, deskId, root, server };
}

/**
 * Disk path ("/a/Dockerfile") of a local path inside the desk's project folder, or undefined
 * when it lies outside. Symlinks are resolved on both sides when the path exists.
 */
export function diskPath(desk: LocalDesk, local: string) {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(desk.root), real(local));
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return "/" + rel.split(sep).filter(Boolean).join("/");
}

/** Absolute local path of a disk path; refuses anything that escapes the project folder. */
export function localPath(desk: LocalDesk, disk: string) {
  const parts = disk.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "."))
    throw new Error("Disk paths must not contain . or ..");
  return join(desk.root, ...parts);
}

/** What the agent is told about working inside the desk. */
export function deskInstructions(desk: LocalDesk) {
  return `This MCP runs inside Constructor desk ${desk.deskId} of project ${desk.projectId} (VS Code in Constructor Research). That desk's disk is the local folder ${desk.root}: create and change its files there directly with your own file and shell tools, and do not use sync_files, list_files, create_folder, move_path or delete_path for this desk. build_image, deploy_app, update_app, start_app, stop_app and list_images use this desk and project by default, so no desk link is needed; pass desk_url only when the user names another desk. When the Dockerfile and sources are ready, call deploy_app (or build_image) with build.dockerfile as the path inside ${desk.root} (for example /backend/Dockerfile), or build.local_path set to a folder inside ${desk.root}; nothing is uploaded.`;
}
