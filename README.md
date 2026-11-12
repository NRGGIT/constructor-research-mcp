# Constructor Research MCP

> **0.6:** a registry `image` the project does not have is added to it as an external image, with no desk and no build; Constructor refuses a bad one at once, with its reason.
>
> **0.5:** one command sets it up: `npx -y constructor-research-mcp@latest install` finds your coding agents, saves your access key and adds the MCP to each of them.
>
> **0.4:** works with Constructor's public API and a personal access key (`rk-…`); browser sign-in is gone. On a Constructor without the public API yet, pin the previous version: `constructor-research-mcp@0.3.3`.

Local stdio MCP for Codex CLI, Claude Code, OpenCode, jcode, Cline, Cursor and Gemini CLI. Submit the whole application once; the MCP builds images, connects services, configures them and starts them. The agent supplies missing configuration and reports the result.

## Install

You need Node.js 22+ and your personal access key (`rk-…`); the MCP does not work without it. In a terminal, run:

```sh
npx -y constructor-research-mcp@latest install
```

It finds the coding agents on your machine (Claude Code, Codex, OpenCode, jcode, Cline, Cursor, Gemini CLI), asks which of them to set up and whether for this project or globally, and where you use Constructor Research (constructor.app or your organisation's instance). It then links to the page where you create an access key, takes the key hidden, checks it with Constructor and saves it to the key file below. Each agent gets an entry that runs `npx -y constructor-research-mcp@latest` and holds no key. Every settings file it changes is first copied to `<file>.constructor-backup`; `--verbose` shows the files and entries, `--dry-run` changes nothing, `--help` lists the options for scripted installs. Then restart the agents.

### By hand

Add the MCP with the key; the address is `https://constructor.app` unless your organisation has its own Constructor (e.g. `https://acme.constructor.app`).

**Claude Code**

```sh
claude mcp add --scope user constructor-research \
  -e CONSTRUCTOR_BASE_URL=https://constructor.app \
  -e CONSTRUCTOR_ACCESS_KEY=rk-your-key \
  -- npx -y constructor-research-mcp@latest
```

**Codex**

```sh
codex mcp add constructor-research \
  --env CONSTRUCTOR_BASE_URL=https://constructor.app \
  --env CONSTRUCTOR_ACCESS_KEY=rk-your-key \
  -- npx -y constructor-research-mcp@latest
```

**OpenCode**: add the entry to `~/.config/opencode/opencode.json` (layouts for 1.x and 2.x in [INSTALL.md](INSTALL.md)).

Then restart the tool and ask the agent anything about Constructor. Windows notes, the optional wake-up hooks and troubleshooting are in [INSTALL.md](INSTALL.md). Restarting the tool picks up a new version.

The key then sits in the tool's settings file (`~/.claude.json`, `~/.codex/config.toml`, `opencode.json`). To keep it out of there, add the MCP without the two variables and save the key with `set-key` (below).

## Access key and connection

The MCP uses only a personal access key (`rk-…`) from Constructor's public API; there is no browser sign-in. Every request carries it as `X-Research-AccessKey: Bearer rk-…`, to the account API (`/api/platform-account/v1`), the desk storage (WebDAV) and the logs alike. The key never goes through the chat. It comes from the MCP settings (`CONSTRUCTOR_ACCESS_KEY`, with `CONSTRUCTOR_BASE_URL`, as in Install), or from a key file the user saves in a terminal, where the key is read hidden, checked against Constructor and saved:

```sh
npx -y -p constructor-research-mcp@latest constructor-research-set-key https://acme.constructor.app
```

It goes to `~/.config/constructor-research/access-key.json` (mode 600) together with the Constructor it belongs to, and the MCP works with that Constructor. All harnesses (Claude Code, Codex, OpenCode) and the wait command share this one file. Every request rereads it, so a new key needs no restart. A key is never sent to a Constructor other than the one it was saved for.

`CONSTRUCTOR_ACCESS_KEY` in the MCP settings takes precedence over the file. The wait hooks do not see the MCP settings: with the key there, give the hooks the same two variables in their own environment, or save the key with `set-key` as well.

Without a key, or when Constructor rejects it (401: revoked, expired or for another Constructor), tools return `needs_key` with the command above; a deployment pauses as `needs_key` and resumes on the next check once a valid key is saved. A desk link from another Constructor returns `wrong_environment`.

Deployment must be switched on for the project. When it is off, the MCP switches it on (`POST /projects/{id}/deployment`), which only the project owner may do. For anyone else (error 40005), the operation fails at stage `prepare` with a message asking the project owner to switch it on in Constructor.

| Variable                            | Default                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CONSTRUCTOR_BASE_URL`              | unset: the Constructor of the saved key, else `https://constructor.app`; set, it fixes the host |
| `CONSTRUCTOR_API_PATH`              | `/api/platform-account/v1`                                                                      |
| `CONSTRUCTOR_STORAGE_PATH`          | `/api/platform-storage`                                                                         |
| `CONSTRUCTOR_ACCESS_KEY`            | unset: the key file is used                                                                     |
| `CONSTRUCTOR_KEY_FILE`              | `~/.config/constructor-research/access-key.json`                                                |
| `CONSTRUCTOR_DESK_ROOT`             | `~/project` (inside a desk only)                                                                |
| `CONSTRUCTOR_STATE_DIR`             | `~/.local/state/constructor-research-mcp`                                                       |
| `CONSTRUCTOR_UPLOAD_SETTLE_SECONDS` | `30`                                                                                            |
| `CONSTRUCTOR_READINESS_SECONDS`     | `60`                                                                                            |

HTTPS is required except on localhost.

## Inside a Constructor desk (VS Code)

When the MCP runs in VS Code inside a Constructor Research desk, it finds that desk from the environment Constructor sets there (`ROLOS_PROJECT_ID`/`RESEARCH_PROJECT_ID`, `ROLOS_DESK_ID`/`RESEARCH_DESK_ID`, `ROLOS_API_SERVER`/`RESEARCH_API_SERVER`) and works in it:

- the desk's project folder (`~/project`, or `CONSTRUCTOR_DESK_ROOT`) is its disk, so the agent creates and changes files there directly; nothing is uploaded, and `sync_files`, `list_files`, `create_folder`, `move_path` and `delete_path` answer `local_desk` for this desk;
- `build_image`, `deploy_app`, `update_app`, `start_app`, `stop_app` and `list_images` act on this desk and project without a desk link; a `desk_url` or other IDs still name another desk;
- `build.dockerfile` is the path inside the project folder (`/backend/Dockerfile`), or `build.local_path` names a folder inside it; Dockerfiles are checked from the local files;
- the MCP works with the desk's Constructor (`ROLOS_API_SERVER`) unless `CONSTRUCTOR_BASE_URL` is set.

`CONSTRUCTOR_LOCAL_DESK=0` turns this off.

## Thirteen tools

| Tool                     | Agent's task                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `deploy_app`             | Describe all services in one request, or resume that deployment with overrides.     |
| `update_app`             | Describe selected changes/additions; the MCP builds and restarts affected services. |
| `start_app` / `stop_app` | Request lifecycle changes for all or selected services.                             |
| `get_deployment`         | Map all deployments, inspect a project or app, or wait for background execution.    |
| `get_logs`               | Last 10–50 lines of a build or service log (see "Logs").                            |
| `build_image`            | Build an image independently when needed.                                           |
| `list_images`            | List image IDs, Dockerfiles and native build statuses.                              |
| `list_files`             | List a disk's files and folders; `recursive:true` walks subfolders.                 |
| `create_folder`          | Create a disk folder, including missing parents.                                    |
| `sync_files`             | Upload new and changed files; asks once before replacing existing files.            |
| `move_path`              | Rename or move files/folders in one batch, approved once; never overwrites.         |
| `delete_path`            | Delete files/folders in one batch; reports first, deletes only with `confirm:true`. |

No special clone/new-instance workflow is implemented. The thirteen tools use the same standard MCP transport across harnesses.

## Where to act: the desk link

The agent does not choose a project or desk. It asks the user for the desk link: open the desk in Constructor and copy the browser address, for example

```text
https://constructor.app/research/projects/<project_id>/desks/<desk_id>/viewer/file
```

Every tool accepts it as `desk_url`, in place of `project_id`/`desk_id`. Anything after `/desks/<desk_id>` is ignored. The link's host must be the Constructor the key belongs to; a link from another one returns `wrong_environment` (see the access key above). Explicit IDs, if also sent, must agree with the link. In `deploy_app`/`update_app`, builds without their own `desk_id` use the link's desk; `start_app`/`stop_app` and `get_deployment` take only the project from it.

Given only `project_id`, the MCP finds the desk itself:

- one desk in the project: it is used;
- no desk: `deploy_app`/`update_app` create one (`<application>-source`) for the sources; the file tools return an error;
- several desks: nothing is changed and the tool returns `desk_choice_required` with each desk's `name`, `id` and `desk_url`. The agent asks the user which one and repeats the call with that link or ID.

## Normal deployment flow

1. Inspect with `get_deployment`: no arguments returns the map of all deployments (every deployment-enabled project → applications → services with names, native statuses, public URLs and ports; other projects are listed by name only); `desk_url` or `project_id` returns that project's disks, images, hardware and apps; add `application_id` for service details.
2. If the app is built from source, pass `build.local_path` (the local folder with the Dockerfile) and `deploy_app` uploads it first, or upload separately with `sync_files`.
3. Call `deploy_app` **once with the entire application**. Use build sources, existing image IDs, or a mix.
4. The MCP executes the job in the background. It generates the deployment ID and resolves service references.
5. If the response is still in progress, call `get_deployment` with that ID to wait for the result. Do not write loops to advance individual steps.
6. On failure, report the stage/service and ask the user to check logs in Constructor. No browser or debugging detour, and no automatic fallback to an older image.

Every execution tool accepts `wait_seconds` from 0 to 20 (default 20). A response after that time is not a timeout/cancellation: execution continues while the MCP process is connected. `get_deployment` waits for completion or a user-action state; it does not drive the pipeline. `wait_seconds:0` returns immediately.

The background executor runs inside the MCP process, not a detached daemon. Closing the harness stops local orchestration; remote builds continue. On the next MCP startup, unfinished checkpoints recover automatically. If a mutation's outcome is uncertain, recovery pauses instead of repeating it.

### Whole-application example

```json
{
  "project_id": "PROJECT_ID",
  "application_name": "subfinder",
  "files_uploaded": true,
  "services": [
    {
      "name": "backend",
      "build": { "desk_id": "DISK_ID", "dockerfile": "/backend/Dockerfile" },
      "ports": [{ "number": 8080, "expose_to_internet": true }]
    },
    {
      "name": "frontend",
      "build": { "desk_id": "DISK_ID", "dockerfile": "/frontend/Dockerfile" },
      "ports": [{ "number": 3000, "expose_to_internet": true }],
      "environment_variables": {
        "NUXT_PUBLIC_API_BASE_URL": {
          "service": "backend",
          "exposure": "public"
        }
      }
    }
  ]
}
```

No request ID is required. An optional `request_id` is a retry key (descriptive strings and legacy UUIDs are accepted); reusing it with the original request resumes the same operation. Save the returned `deployment_id`. After an interrupted initial call without a retry key, an undisclosed checkpoint may exist; inspect state/resources rather than blindly resubmitting.

### Service references

Public URL, resolved after the target service is created:

```json
{ "service": "backend", "exposure": "public" }
```

Internal host and port:

```json
{ "service": "database", "port": 5432 }
```

Internal HTTP URL:

```json
{ "service": "backend", "port": 8080, "scheme": "http" }
```

References imply dependency ordering. `depends_on` can add explicit ordering. Unknown targets, cycles and unconfigured target ports are rejected. Public references require a public target port and use HTTPS. Internal addresses follow `svc-{name}.app-{project_id_first4}{application_id_first4}.svc.cluster.local:{port}` for this environment. Public URLs use the API link or `https://{service_id}.constructor.pro`.

Private DNS works between containers; browser JavaScript needs a public backend URL or a frontend server proxy. Build-time frontend variables are not injected into image builds by this MCP: runtime wiring requires an application that reads runtime configuration.

### Image reuse and limits

Replace a service's `build` with `"image_id":"IMAGE_ID"` to skip building, or with `"image":"registry/repo:tag"` to run a registry image unchanged, such as `jgraph/drawio:latest` from Docker Hub. Which of `build`, `image` and `image_id` fits is the agent's choice; the tool descriptions say what each one does. `list_images` returns compact records with `source` (`desk_build` or `external`), `reference` and `build_status` (`not_started`, `snapshot_creation`, `in_progress`, `done` or `error`); `detailed:true` returns full records.

With `image`, the MCP first looks for it in the project (by `reference` or name). External images there (`source: external`) are pulled, not built, so they are used whatever their build status, unless it is `error`. An image the project does not have is added to the project as an external image (`POST /projects/{id}/images/external`): no desk, no upload, no build. Constructor reads the image manifest at once and refuses a missing tag, a private image, an image without a `linux/amd64` variant or a malformed reference; the MCP then returns `image_refused` with Constructor's reason and creates nothing else. Docker Hub references are sent in the short form (`docker.io/library/nginx:1.27` becomes `nginx:1.27`), which Constructor requires for now. A reference without a tag means `latest`, which moves: the result then carries `image_warnings`. On a Constructor without this endpoint, the MCP falls back to building the image on the desk from a one-line `FROM <image>` Dockerfile in `.constructor/images/<name>/`.

- Build storage is omitted by default, using the API's documented **50 GB** default. Explicit `ephemeral_build_disk_size_gb` overrides must be **10–1000 GB**.
- Each service can have multiple ports (1–65535), with at most **one public port**. That port must match where the container listens.
- Hardware: omit it. New services get the smallest available non-GPU option; existing services keep theirs. Only when the app needs more, pass minimums `hardware: {cpu, ram_gb, gpu}`; the MCP picks the smallest available option that meets them (GPU options only when `gpu:true`). `get_deployment` with `desk_url` lists `hardware_options` as plain specs (CPU, RAM, GPU), without names or IDs.
- Up to three volumes, each 10–2000 GB, with a mount path.
- Service names are lowercase DNS labels, max 63 characters.

## Missing prerequisites

- **No or rejected key:** `needs_key` with the command to save one (see Access key). Save a valid key, then check the same deployment again.
- **No project/disk:** omit `project_id`, optionally supply `project_name`, and use build sources without disk IDs. MCP creates the project/disk and enables deployment tools.
- **Files absent:** `needs_upload` lists disks and Dockerfile paths. Upload with `sync_files` (or manually), then call `get_deployment` with `deployment_id` and `files_uploaded:true`.

Before any build, the MCP reads each Dockerfile from its disk. A missing one returns `dockerfile_missing` and nothing is created. When every build's Dockerfile is present, the upload pause is skipped. The MCP also returns `dockerfile_warnings` (in `message` too) for: a name other than `Dockerfile`/`<name>.dockerfile`, no `FROM`, no `EXPOSE` or a service port that is not exposed, `localhost`/`127.0.0.1` in `ENV`/`ARG`/`CMD`/`ENTRYPOINT`, a docker-compose file next to the Dockerfile, compose-style default hosts in `ENV` (`http://cerbos:3592`, `temporal:7233`), an `ENTRYPOINT`/`CMD` script copied from the build context with no `chmod` (files uploaded to a desk lose the executable bit, so such a container exits before printing anything), and `listen [::]` in an nginx `.conf`/`.template` the Dockerfile copies (nginx exits where the cluster has no IPv6). The same rules are in the tool descriptions, so agents see them before writing a Dockerfile. An existing project with a conflicting name requires an explicit ID; the MCP does not guess.

## Resume with a replacement image

After the user selects a replacement, call the original tool (`deploy_app` or `update_app`) with the same deployment ID and only the service overrides:

```json
{
  "deployment_id": "RETURNED_DEPLOYMENT_UUID",
  "services": [{ "name": "frontend", "image_id": "WORKING_IMAGE_ID" }]
}
```

Successful builds and unchanged service definitions are retained. Environment overrides merge with saved values. Supplying a new `build` source retries that service's build; the previous successful builds are reused. Overrides cannot add services that were not in the saved operation; use a new update for additions.

A failed build returns `failure.stage`, `failure.service`, `failure.dockerfile` and `failure.image_id`. A service API failure includes the stage and service. The message is concise: **“Please check the logs in Constructor.”** Logs and browser access are not part of this workflow.

## Service links and volumes

- An environment variable can be `{service, port}` instead of a string. The MCP turns it into the other service's internal address as a bare `host:port` (e.g. `svc-temporal.app-1234abcd.svc.cluster.local:7233`), which suits gRPC, databases and Temporal. Add `scheme: "http"` to get `http://host:port`. `{service, exposure: "public"}` gives the public https URL.
- A volume belongs to one service and the container can write to it. Data lives as long as the service: it survives stop/start, restarts and image changes. It is wiped when the service is deleted, or when the volume is removed or its name, mount point or size changes. `update_app` therefore returns `confirm_required` with `volumes_to_wipe` before such a change; after the user approves, repeat with `confirm_volume_wipe=true`. Another service cannot mount it; a request that mounts the same volume on two services is rejected before anything changes. Share data over an internal link instead.

## Updates and lifecycle

`update_app` takes `project_id`, `application_id` and selected `services`. Match an existing service by exact name, or supply `service_id` when renaming. New names add services and require an image or build. Services omitted from the request remain untouched.

Omitted image/hardware/ports/volumes are retained. Environment variables merge by name; deletion of environment variables is not implemented. Supplied port and volume lists replace those lists, preserving matching IDs by port number/volume name. Empty lists remove attachments; no volume-data migration occurs.

All required builds must succeed before existing services are changed. The MCP stops affected running services, sends a complete merged PATCH and starts them. Multiple services are handled internally, not through agent-managed start/stop loops. This is not an atomic rollout; a failure can leave some services updated. Avoid concurrent UI edits and finish one operation on an app before starting another.

`start_app` and `stop_app` take `project_id`, `application_id` and optional `service_names`. `started`/`stopped` mean requests accepted, not verified readiness/teardown. Native statuses (`starting`, `running`, `stopping`, `stopped`, `failed`) remain visible. A finished job's service status can be refreshed with `get_deployment`; the job's historical outcome is distinct from current native status. Readiness is always unverified.

## Build and start reliability

Learned from live runs (28 Oct 2026):

- **Upload settle.** A build started right after its Dockerfile was uploaded failed every time; with a pause it built first time. After any upload to a disk, builds on that disk wait until 30 s have passed (status `preparing`, message says so). `CONSTRUCTOR_UPLOAD_SETTLE_SECONDS` changes it; 0 disables.
- **Confirmed failure, one automatic rebuild.** The platform briefly reports `error` and then `in_progress` again, so an error counts only when seen twice for the same image. The first confirmed failure is rebuilt once under a new image name, after re-uploading `local_path` sources and re-checking the Dockerfile on the disk. `build_retried` names the image that failed.
- **Actionable failure.** A build that fails again returns `failure.image_name`, `first_image_name`, `desk_link`, and a message saying how to see the log: Constructor does not keep build logs, so rebuild that Dockerfile from the UI and watch it live.
- **Readiness check.** After start, the MCP requests each public URL until it answers (any HTTP status below 500) or 60 s pass (status `verifying`). `readiness` is then `http_ok`, `not_responding` (with `readiness_checks` and a hint; services of the deployment that printed nothing since starting are named, with an ordered checklist: entrypoint not executable, wrong entrypoint path, nginx IPv6 listen, wrong listen address or port), or `no_public_url`. `CONSTRUCTOR_READINESS_SECONDS` changes the window; 0 disables.

## State and recovery

Progress and sanitized results are checkpointed. Configuration secrets remain in owner-only local checkpoint files (`0600`, directory `0700`); tool responses return environment-variable names, never values. The access key is not checkpointed. Do not commit credentials or state.

Checkpoints are bound to the API endpoint. A shared state directory coordinates local harnesses. `resume:false` on `get_deployment` observes without scheduling execution or confirming uploads; already running background work is not paused.

Terminal states: `built`, `started`, `stopped`, `failed`, `needs_reconciliation`, `superseded`. A new `update_app`, `start_app` or `stop_app` for an application ends that application's unfinished deployments as `superseded`, so an older one cannot apply its images after the newer one; its builds keep running on Constructor but are not used. The new result lists them in `replaced`, with the services they were changing that the new update leaves out. User-action pauses: `needs_key`, `needs_upload`. Other statuses indicate background progress. An executor stops after one hour rather than retrying forever.

For `needs_reconciliation`, inspect the possible remote mutation before submitting a new operation. The server never blindly repeats an uncertain create. A `.lock` left by a process that no longer exists (a server killed or restarted mid-step) is removed automatically on the next operation; a lock held by a live process returns `busy`. Checkpoints remain available. No rollback or resource deletion is automated.

## Logs

Constructor serves logs only live, as a stream: a build log while the build runs, a service log for the service's current container. Each connection replays the log from the start, then streams. Nothing is kept afterwards: a finished build has no log, and a restarted container starts with an empty one, so a crash-looping service shows no log at all. The MCP therefore follows every build and service it starts and keeps only the last 50 lines of each, in memory and in `logs/` in the state directory, so it stays small however long the log is.

- A build is followed from its first status check until it ends; a dropped connection is reopened and replayed lines are skipped. When the stream closes, reopening it answers "not found" and the kept lines are final.
- A service is followed from its start request, or from when `get_deployment` shows it running, for 15 minutes after anyone last asked for it.
- Restarts: Constructor reports no restart count, so the MCP detects them in the stream. When a new container starts (the platform's "Container is waiting to start" line after the container's own lines, or a reconnect that begins with newer lines than were kept), it inserts `--- new container (restart N) ---` and keeps the old container's last lines above it, which usually show why it stopped. `get_logs` and the services in `get_deployment` report `restarts_seen` and `restarted_at`.
- `get_deployment` services also carry `status_changes`: the native statuses this MCP process saw, with times, once a service has had more than one.
- Lines that are only a timestamp are dropped, and identical consecutive lines are collapsed into one with a count (`(×5)`).
- A failed build or start puts the last 20 lines into `failure.log_tail`.
- `get_logs` takes `image_id`, `service_id` or `deployment_id` (all its builds and services) and `lines` (10–50, default 20). It also reads builds and services this MCP did not start, but only while they run.

## Waiting for long builds

Builds can run for many minutes. The MCP keeps executing in the background, but an agent that has ended its turn is not told when they finish. `dist/wait.js` (bin `constructor-research-wait`) blocks until the given deployments, or all in-progress ones when no ID is given, finish, and prints one line each: status, message, services with public URLs, next step. Exit codes: `0` finished, `2` needs the user (failed, key, upload, volume confirmation), `3` still running at `--max-minutes` (default 60), `4` nothing in progress.

```sh
npx -y -p constructor-research-mcp@latest constructor-research-wait <deployment_id>
```

It watches the checkpoints the MCP writes. For deployments named by ID, if no process has advanced one for a minute (the MCP was closed), it continues it itself, exactly as the MCP would on restart. Without IDs it only watches, since those deployments may belong to other sessions. While a deployment runs, `next_action` gives the agent the exact command, including the MCP's non-default `CONSTRUCTOR_*` settings; the wait command needs the same settings as the MCP.

How the agent learns the outcome depends on the client:

| Client      | Without setup                                                                 | Optional wake-up                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | runs the command in the background; Claude Code wakes the agent when it exits | [PostToolUse hook](examples/claude-hooks.json) with `asyncRewake` (merge into `settings.json`): wakes the agent after any deploy/update/build/start/stop                                                                               |
| Codex CLI   | runs the command in the foreground (no background wake-up exists)             | [Stop hook](examples/codex-hooks.json) (`~/.codex/hooks.json`, trust it in `/hooks`): when the agent would stop, waits up to 9 min, then continues the turn with the outcome, or with "still in progress" so the next stop waits again |
| OpenCode    | runs the command in the foreground                                            | [plugin](examples/opencode-plugin.js) (`.opencode/plugins/`): after a deploy tool call, waits in the background and sends the outcome as a new message                                                                                 |

Hooks report each deployment once: one that had already finished when the tool returned is skipped, and only one waiter per deployment runs. The Codex hook covers every in-progress deployment touched in the last two hours, including ones from other sessions. The Codex and OpenCode add-ons follow their documentation (Codex hooks; OpenCode `tool.execute.after` and `client.session.prompt`) and have not yet been run in those clients.

## Harness configuration

Examples:

- [Codex CLI](examples/codex.toml): `~/.codex/config.toml` or a trusted project's `.codex/config.toml`.
- [Claude Code](examples/claude.mcp.json): merge into project `.mcp.json`.
- [OpenCode v1](examples/opencode.json): merge into `opencode.json`/`opencode.jsonc`.
- [OpenCode v2](examples/opencode-v2.json): entries live under `mcp.servers`.

Use the executable directly to keep stdout reserved for MCP. `structuredContent` contains full results; text content is a short summary to avoid duplicated output.

## Disk files

The tools use the disk's WebDAV storage (`/api/platform-storage/desks/{disk}/dav/project/`) with the same key. `sync_files`:

- compares each local file with the disk by size, then by the server's SHA-256 checksum; only new and changed files are sent, and nothing is deleted;
- uploads new files and creates folders without asking; if existing files would be replaced, it uploads nothing and returns `confirm_required` with the whole plan, to be approved once and repeated with `confirm:true`; `dry_run:true` only previews;
- uploads each file to a temporary file in `.rolos-temp/`, in 4 MB chunks (the server rejects single requests above about 9 MB), then moves it into place and verifies the checksum, so a failed upload never leaves a half-written file;
- skips `.git`, `node_modules`, `.env`, `.venv`, `__pycache__`, `.DS_Store`, symlinks, files over 100 MB, and any `exclude` patterns;
- reports a conflict, and does nothing, when a file would replace a folder or the other way round;
- stops starting new files after about 25 seconds and returns `in_progress`; repeating the same call continues, because finished files compare as unchanged.

A local folder's contents go into `remote_path`; a single file keeps its name. `local_path` must be absolute.

`move_path` takes every rename/move for a request as `moves: [{from, to}]`. Without `confirm` it returns `confirm_required` with the moves and any that cannot be done (missing source, taken destination, folder into itself); with `confirm:true` it performs them (WebDAV `MOVE` with `Overwrite: F`). It never overwrites; the destination's parent folder must already exist.

`delete_path` takes every path for a request as `paths`. Without `confirm` it returns `confirm_required` with what would go (folders with file and subfolder counts); with `confirm:true` it deletes. Paths inside a folder that is also listed are covered by that folder. Folders go with all their contents and there is no undo. The disk root cannot be deleted.

Builds: the build context is the folder containing the Dockerfile (verified live, 28 Oct 2026), so a Dockerfile that builds locally in its folder builds the same way on the platform. Every build gets its own image name in the UI style `<service>-v<N>` (or the requested `build_image` name, versioned if already taken).

Confirmation policy: creating folders and uploading new files never ask. Replacing, renaming or deleting asks once per request for the whole list.

A desk nobody opened recently has its file storage stopped (`filesystem.status: not_started` on the desk; WebDAV answers 502, then 503 while starting). Every file tool and the Dockerfile preflight check this first. If storage is stopped, the MCP starts it with `POST /desks/{id}/filesystem` (what opening the desk in the browser does) and waits up to 45 s; it took about 27-33 s live. If it is still starting, the tool returns `not_ready` with nothing changed, and the same call can be repeated.

Storage under load: the gateway answers 502/503/504 now and then. Requests that are safe to repeat are retried three times with backoff (MOVE and DELETE are not; after a failed MOVE the checksum tells whether the file landed). A file whose checksum still fails is left for the next call (`in_progress`) instead of failing the whole sync. Files this MCP process uploaded or checked are remembered, so a repeated sync does not checksum them again while their size and server time are unchanged. Storage requests run 4 at a time; each call uploads for up to 45 s. A build's `local_path` upload leaves out files matched by the folder's `.dockerignore` (not used when it has `!` exceptions).

## Verification

```sh
npm run check
npm test
npm run format:check
```

Tests build the server first, use a local HTTP simulator and SDK stdio client, and verify background execution without progress calls, public/internal links, recovery, partial overrides, native statuses and secret redaction. Tests never mutate live Constructor resources. Logs, readiness checks, registry imports and rollback remain outside the prototype.
