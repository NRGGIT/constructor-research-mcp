#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, originOf, VERSION } from "./config.js";
import { PlatformApi, ToolError } from "./api.js";
import { StateStore } from "./store.js";
import { DeploymentEngine, terminal } from "./deployment.js";
import { DeploymentRuntime } from "./runtime.js";
import { FileManager, dockerignore, type BuildSource } from "./files.js";
import { basename } from "node:path";
import { LogFollower, type LogKind } from "./logs.js";

const RULES =
  "Dockerfile rules: one Dockerfile per service named Dockerfile or <name>.dockerfile; docker-compose is not supported. The Dockerfile must build everything itself; no separate setup script the user runs before the build. The app listens on 0.0.0.0 on a fixed port; only one port per service can be public. Services reach each other through internal references (bare host:port by default, http:// only when scheme is set), never localhost; do not bake compose-style fallback hosts (http://db:5432) into ENV. Files uploaded to a desk lose the executable bit: RUN chmod 0755 any entrypoint script you COPY. In nginx configs use only the IPv4 listen line. A volume belongs to one service; services cannot share a volume. Volume data survives restarts and image changes but is wiped if the service is deleted or the volume is removed or changed. The build context is the folder containing the Dockerfile, exactly like a local docker build in that folder. Test the image locally (docker build/run) before uploading.";
import { located, resolveDeskUrl, type Scope } from "./location.js";
import { ZodError } from "zod";
import {
  buildInput,
  listInput,
  deployInput,
  updateInput,
  lifecycleInput,
  getInput,
  logsInput,
  listFilesInput,
  createFolderInput,
  syncFilesInput,
  movePathInput,
  deletePathInput,
  signInInput,
} from "./schemas.js";
import { harnessOf, sessionFile } from "./config.js";
import { sessionHost } from "./session.js";
import { signIn, type SignInResult } from "./signin.js";

async function main() {
  const config = configFromEnv();
  const api = new PlatformApi(config);
  const engine = new DeploymentEngine(api, new StateStore(config));
  const runtime = new DeploymentRuntime(engine);
  const files = new FileManager(api, engine);
  engine.files = files;
  const logs = new LogFollower(api);
  engine.logs = logs;
  /** Verify Dockerfiles on their disks before any build; surface lint warnings to the agent. */
  const checked =
    (fn: (a: any) => Promise<any>, single = false) =>
    async (a: any) => {
      const begun = Date.now();
      if (!single && a.services?.some((x: any) => x.build?.local_path)) {
        // Upload local sources first, once per (disk, local folder, disk folder).
        const done = new Set<string>();
        const services = [];
        for (const x of a.services) {
          const b = x.build;
          if (!b?.local_path) {
            services.push(x);
            continue;
          }
          if (!b.desk_id || !a.project_id)
            throw new ToolError(
              "invalid_input",
              `Service ${x.name}: local_path needs a disk. Pass desk_url (the desk link from the user) or build.desk_id with project_id.`,
            );
          const remote = (b.remote_path ?? basename(b.local_path))
            .split("/")
            .filter(Boolean)
            .join("/");
          const key = JSON.stringify([b.desk_id, b.local_path, remote]);
          if (!done.has(key)) {
            const r = await files.sync({
              project_id: a.project_id,
              desk_id: b.desk_id,
              local_path: b.local_path,
              remote_path: remote,
              exclude: await dockerignore(b.local_path),
              confirm: a.confirm,
            });
            if (r.status !== "synced")
              return {
                ...r,
                message: `${r.message} Nothing was built yet. ${
                  r.status === "confirm_required"
                    ? "After the user approves, repeat the same call with confirm=true."
                    : r.status === "in_progress"
                      ? "Repeat the same call to continue uploading."
                      : "Resolve the listed files, then repeat the call."
                }`,
              };
            done.add(key);
          }
          const inside = (b.dockerfile ?? "Dockerfile")
            .split("/")
            .filter(Boolean);
          services.push({
            ...x,
            build: {
              ...b,
              remote_path: remote,
              dockerfile:
                "/" +
                [...remote.split("/").filter(Boolean), ...inside].join("/"),
            },
          });
        }
        a = {
          ...a,
          services,
          wait_seconds: Math.min(
            a.wait_seconds ?? 20,
            Math.max(0, Math.floor(35 - (Date.now() - begun) / 1000)),
          ),
        };
      }
      const sources: BuildSource[] = single
        ? [
            {
              service: a.name,
              desk_id: a.desk_id,
              dockerfile: a.dockerfile,
              ports: [],
            },
          ]
        : (a.services ?? [])
            .filter((x: any) => x.build?.desk_id)
            .map((x: any) => ({
              service: x.name,
              desk_id: x.build.desk_id,
              dockerfile: x.build.dockerfile,
              ports: (x.ports ?? []).map((p: any) => p.number),
            }));
      if (!sources.length || !a.project_id) return fn(a);
      const pre = await files.preflight(a.project_id, sources);
      if (pre.missing.length)
        throw new ToolError(
          "dockerfile_missing",
          `Dockerfile not found on the disk for ${pre.missing.join(", ")}. Upload the source with sync_files (check the path), then call again. Nothing was built.`,
        );
      const allOnDisk =
        !single &&
        (a.services ?? []).every((x: any) => !x.build || x.build.desk_id);
      const result = await fn(allOnDisk ? { ...a, files_uploaded: true } : a);
      return pre.warnings.length
        ? {
            ...result,
            message:
              `${result.message ?? ""} Dockerfile warnings to fix or tell the user about: ${pre.warnings.join(" ")}`.trim(),
            dockerfile_warnings: pre.warnings,
          }
        : result;
    };
  const server = new McpServer(
    { name: "constructor-research", version: VERSION },
    {
      instructions: `Sign-in: the MCP works with one Constructor, https://constructor.app unless the user signed in to another. When the user asks to sign in, or names their Constructor or gives a link from it (e.g. https://learn.constructor.university), call sign_in with url set to that link. Where to act: ask the user for the Constructor desk link (they open the desk in the browser and copy the address; it contains /projects/<project>/desks/<desk>) and pass it as desk_url. Do not pick a project or desk yourself; if the user has not said where to deploy or where files live, ask. Ask the user only before replacing, renaming or deleting files on a disk, once per request for the whole list (the tools return confirm_required); creating folders and uploading new files need no question. ${RULES} For a local app, pass build.local_path (the folder with the Dockerfile) and deploy_app uploads it first. Hardware: leave it out; the default is used. Set hardware minimums only when the app cannot run without a GPU or a lot of RAM. Use deploy_app/update_app once for the WHOLE application. The MCP builds, resolves service URLs, configures and starts services in the background. IDs are automatic. To wait, call get_deployment(wait_seconds=20) again as often as needed (a loop of such calls is fine); never perform the deployment steps yourself. On failure, tell the user the failed stage/service; failure.log_tail and get_logs show the last build or service log lines. Do not use browser or debugging tools. For source files: sync_files to the desk before building (the MCP checks each Dockerfile on the disk and reports warnings); after a needs_upload pause, sync and call get_deployment with files_uploaded=true. Started is not readiness.`,
    },
  );
  const register = (
    name: string,
    description: string,
    schema: any,
    fn: (args: any) => Promise<any>,
    readOnly = false,
    budget = 20000,
    scope?: Scope,
  ) => {
    if (scope && scope !== "deploy") schema = located(schema, scope);
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          await api.followSession();
          // Nobody signed in yet: a desk link names the Constructor to sign in to.
          if (
            args?.desk_url &&
            !config.baseUrlFixed &&
            !(await sessionHost(config.cookieFile))
          )
            try {
              api.aimed = config.baseUrl = originOf(args.desk_url);
            } catch {}
          // Do not start a change on a token about to expire; checking on a deployment is still fine.
          const before = await api.authLeft().catch(() => undefined);
          const what = (renewable: boolean) =>
            renewable ? "The login session ends" : "The token expires";
          if (
            !readOnly &&
            name !== "get_deployment" &&
            name !== "sign_in" &&
            before !== undefined &&
            before.minutes < 3
          )
            throw new ToolError(
              "needs_auth",
              api.authHelp(
                `${what(before.renewable)} in ${Math.max(0, Math.floor(before.minutes))} min, too soon to start this operation.`,
              ),
            );
          let result = await api.withBudget(budget, () =>
            fn(
              scope
                ? resolveDeskUrl(
                    args,
                    config.baseUrl,
                    scope,
                    config.baseUrlFixed,
                  )
                : args,
            ),
          );
          const left = await api.authLeft().catch(() => undefined);
          // A build can take half an hour; warn while there is still time to sign in again.
          // A renewable session warns a day ahead.
          const builds = ["deploy_app", "update_app", "build_image"].includes(
            name,
          );
          const limit = left?.renewable ? 24 * 60 : builds ? 40 : 10;
          if (left !== undefined && left.minutes > 0 && left.minutes < limit)
            result = {
              ...result,
              auth_warning: `${what(left.renewable)} in ${
                left.minutes >= 120
                  ? `${Math.floor(left.minutes / 60)} h`
                  : `${Math.floor(left.minutes)} min`
              }${
                builds && !terminal.has(result.status)
                  ? "; builds often take 10–30 min, and when it ends the deployment pauses as needs_auth until the user signs in again"
                  : ""
              }. Ask the user to sign in again now: ${api.authHelp("")}`,
            };
          return {
            content: [
              {
                type: "text" as const,
                text:
                  result.text ??
                  (result.status
                    ? `${result.status}${result.deployment_id ? ` (${result.deployment_id})` : ""}${result.message ? `: ${result.message}` : ""}`
                    : `Discovery result: ${result.total !== undefined ? result.total + " images" : Object.keys(result).join(", ")}. See structuredContent for details.`) +
                    (result.auth_warning
                      ? ` Warning: ${result.auth_warning}`
                      : ""),
              },
            ],
            // A preformatted text (build logs) is not repeated in structuredContent.
            structuredContent: result.text
              ? { ...result, text: undefined }
              : result,
          };
        } catch (err) {
          const result =
            err instanceof ZodError
              ? {
                  status: "invalid_input",
                  message: err.issues.map((x) => x.message).join("; "),
                }
              : err instanceof ToolError
                ? {
                    status: err.code,
                    message: err.message,
                    http_status: err.status,
                    api_error_code: err.apiCode,
                  }
                : {
                    status: "internal_error",
                    message:
                      "The local operation failed. Check configuration and state-directory permissions; no API response or secret values are included in this error.",
                  };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      },
    );
  };
  register(
    "build_image",
    "Build a disk Dockerfile. IDs are generated automatically; omit build storage for the default. Waits up to wait_seconds (default 20), then continues in the background. Check get_deployment for the result. The Dockerfile rules in deploy_app apply.",
    buildInput,
    checked((a) => runtime.buildImage(a), true),
    false,
    20000,
    "desk",
  );
  register(
    "list_images",
    "List images with native build statuses and Dockerfile paths. Optionally filter by disk. Compact results by default; detailed=true returns full image records.",
    listInput,
    (a) => engine.listImages(a),
    true,
    20000,
    "desk",
  );
  register(
    "list_files",
    "List files and folders on a project disk (the Constructor desk's project folder). Non-recursive by default; recursive=true walks subfolders up to max_entries.",
    listFilesInput,
    (a) => files.list(a),
    true,
    60000,
    "desk",
  );
  register(
    "create_folder",
    "Create a folder on a project disk, including missing parent folders. Existing folders are left unchanged.",
    createFolderInput,
    (a) => files.createFolder(a),
    false,
    60000,
    "desk",
  );
  register(
    "sync_files",
    "Upload a local file or folder to a project disk. Compares by size and SHA-256 and sends only new and changed files; never deletes. New files and folders upload without asking. If existing files would be replaced, nothing is uploaded and status is confirm_required: ask the user once for the whole list, then repeat with confirm=true. dry_run=true only previews. Skips .git, node_modules, .env, .venv, __pycache__, .DS_Store and files over 100 MB. If the result is in_progress, repeat the same call to continue.",
    syncFilesInput,
    (a) => files.sync(a),
    false,
    90000,
    "desk",
  );
  register(
    "move_path",
    "Rename or move files/folders on a project disk. Send every move for the request in one call: without confirm it returns the list (confirm_required) for the user to approve once; repeat with confirm=true. Never overwrites; the destination parent folder must exist.",
    movePathInput,
    (a) => files.move(a),
    false,
    60000,
    "desk",
  );
  register(
    "delete_path",
    "Delete files/folders (folders with all contents) on a project disk. Send every path for the request in one call: without confirm it returns what would be deleted (confirm_required) for the user to approve once; repeat with confirm=true. Cannot be undone.",
    deletePathInput,
    (a) => files.remove(a),
    false,
    60000,
    "desk",
  );
  register(
    "deploy_app",
    "Deploy the WHOLE app in one request: prepare project/disk, build or reuse all images, resolve internal/public service references, configure and start. Runs in the background. IDs are automatic. To resume a failure, send deployment_id and service overrides (for example replacement image_id); successful builds are preserved. On failure, failure.log_tail and get_logs show what the build or service printed." +
      " " +
      RULES,
    deployInput,
    checked((a) => runtime.deploy(a)),
    false,
    60000,
    "deploy",
  );
  register(
    "update_app",
    "Update/add selected services in one request; preserve omitted settings. MCP handles builds, links and restarts in the background. Environment variables merge; supplied port/volume lists replace their lists. Resume a failed update using deployment_id and service overrides. The Dockerfile rules in deploy_app apply.",
    updateInput,
    checked((a) => runtime.update(a)),
    false,
    60000,
    "deploy",
  );
  register(
    "start_app",
    "Start all or selected services as one operation. MCP handles all requests. Waits up to wait_seconds (default 20); remaining execution continues in the background. Started does not mean ready.",
    lifecycleInput,
    (a) => runtime.lifecycle("start", a),
    false,
    20000,
    "project",
  );
  register(
    "stop_app",
    "Stop all or selected services as one operation. MCP handles all requests. Waits up to wait_seconds (default 20). Stopped means stop requests accepted, not verified teardown.",
    lifecycleInput,
    (a) => runtime.lifecycle("stop", a),
    false,
    20000,
    "project",
  );
  register(
    "get_deployment",
    "With deployment_id, observe/wait for background execution; the MCP owns execution. Each call waits up to wait_seconds (max 20); to wait longer, call again, as often as needed (a loop of get_deployment calls is fine). Services carry status_changes and restarts_seen when the MCP saw the status change or a new container start. After sync_files (or manual upload) set files_uploaded=true; after cookie replacement checking the job resumes it. With no arguments, returns the map of all deployments: every deployment-enabled project with its applications and services (names, native statuses, public URLs, ports). With desk_url or project_id, returns that project's desks, images, hardware and applications; add application_id for one application. resume=false observes only. Never returns environment-variable values.",
    getInput,
    (a) => runtime.get(a),
    false,
    20000,
    "deploy",
  );
  /** The sign-in window this process opened, while it is open and until its result is read. */
  type SignIn = {
    done: boolean;
    host: string;
    result?: SignInResult;
    promise: Promise<void>;
  };
  let signing: SignIn | undefined;
  register(
    "sign_in",
    "Signs the user in to their Constructor: https://constructor.app unless url names another one (any link from it, e.g. https://learn.constructor.university). Call it when the user asks to sign in, or when a tool returns needs_auth, after telling the user a sign-in window is about to open. It opens a separate Chrome window at the sign-in page; the user signs in there and the window closes by itself. There is one sign-in at a time: signing in to another Constructor replaces it, and the MCP works there afterwards. The session is kept for this harness only, and the MCP renews it automatically for up to 14 days. Waits up to wait_seconds; while the user is still signing in it returns sign_in_pending: call it again (no second window opens), then repeat the call that needed auth.",
    signInInput,
    async (a) => {
      const i = signInInput.parse(a);
      if (!signing) {
        let host = config.baseUrl;
        if (i.url) {
          try {
            host = originOf(i.url);
          } catch (e: any) {
            throw new ToolError("invalid_input", `url: ${e.message}`);
          }
          if (config.baseUrlFixed && host !== config.baseUrl)
            throw new ToolError(
              "wrong_environment",
              `This MCP is fixed to ${config.baseUrl} by CONSTRUCTOR_BASE_URL; it cannot sign in to ${host}.`,
            );
        }
        const signedIn = (await sessionHost(config.cookieFile)) === host;
        const left = signedIn
          ? await api.authLeft().catch(() => undefined)
          : undefined;
        if (!i.force && left?.renewable && left.minutes > 60)
          return {
            status: "signed_in",
            message: `Already signed in to ${host}; the session renews automatically for another ${Math.floor(left.minutes / 1440)} days. Pass force=true to sign in again.`,
            session_file: config.cookieFile,
            host,
          };
        const state: SignIn = {
          done: false,
          host,
          promise: Promise.resolve(),
        };
        state.promise = signIn(
          { ...config, baseUrl: host },
          config.cookieFile,
        ).then((r) => {
          state.result = r;
          state.done = true;
          if (r.status === "signed_in") api.aimed = undefined;
        });
        signing = state;
        api.signingIn = true;
        void state.promise.finally(() => (api.signingIn = false));
      }
      const current = signing;
      await Promise.race([
        current.promise,
        new Promise((r) => setTimeout(r, i.wait_seconds * 1000)),
      ]);
      if (!current.done)
        return {
          status: "sign_in_pending",
          message: `A Chrome window is open at ${current.host}. Ask the user to sign in there; it closes by itself afterwards. Then call sign_in again to confirm, or repeat the call that needed auth.`,
        };
      signing = undefined;
      await api.followSession();
      return current.result!;
    },
    true,
    30000,
  );
  register(
    "get_logs",
    "Last lines (default 20, up to 50) of a build or service log: why a build or start failed, how far a long build got, what a starting service prints. Constructor serves logs only live: a build log while the build runs, a service log for its current container while it runs (both replayed from the start, then streamed). The MCP follows the builds and services it starts or shows and keeps their last 50 lines, so they stay readable after the build ends or the container restarts; anything else can be read only while it runs. When a new container starts, the lines of the one before stay, above a '--- new container' marker, and restarts_seen counts them: that answers whether a service keeps restarting and why. An empty service log on a running service usually means a crash loop.",
    logsInput,
    async (a) => {
      const i = logsInput.parse(a);
      let targets: { kind: LogKind; id: string; name?: string }[] = [];
      if (i.image_id) targets = [{ kind: "build", id: i.image_id }];
      else if (i.service_id) targets = [{ kind: "service", id: i.service_id }];
      else {
        const op = await engine.store.load(i.deployment_id!);
        if (!op)
          throw new ToolError("invalid_input", "Deployment ID not found.");
        const named = (name: string) =>
          op.kind === "build" ? undefined : name;
        targets = Object.entries(op.images).map(([name, id]) => ({
          kind: "build" as const,
          id,
          name: named(name),
        }));
        const failed = op.failure?.image_id;
        if (failed && !targets.some((t) => t.id === failed))
          targets.push({
            kind: "build",
            id: failed,
            name: op.failure?.service,
          });
        for (const [name, id] of Object.entries(op.services))
          targets.push({ kind: "service", id, name });
      }
      if (!targets.length)
        return {
          status: "no_logs",
          message: "This deployment has not started a build or service.",
        };
      const logs_ = await Promise.all(
        targets.map(async (t) => ({
          name: t.name,
          ...(await logs.tail(t.id, t.kind, i.lines)),
        })),
      );
      return {
        logs: logs_,
        text: logs_
          .map(
            (l) =>
              `== ${l.kind} ${l.name ? `${l.name} (${l.id})` : l.id}: ${l.state}${l.message ? `. ${l.message}` : ""}${l.lines.length ? "\n" + l.lines.join("\n") : ""}`,
          )
          .join("\n\n"),
      };
    },
    true,
    20000,
    "deploy",
  );
  server.server.onclose = () => {
    void runtime.close();
    void logs.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void Promise.all([runtime.close(), logs.close()]).then(() =>
        server.close(),
      );
    });
  // Each harness keeps its own session, named after the client in the handshake.
  let recovered = false;
  server.server.oninitialized = () => {
    if (!config.cookieFileFixed)
      config.cookieFile = sessionFile(
        harnessOf(server.server.getClientVersion()?.name),
      );
    if (!recovered) {
      recovered = true;
      void api.followSession().finally(() => runtime.recover());
    }
  };
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  console.error(
    "Constructor Research MCP could not start. Check environment configuration.",
  );
  process.exitCode = 1;
});
