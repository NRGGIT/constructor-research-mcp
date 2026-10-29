# Constructor Research MCP

Local stdio MCP for Codex CLI, Claude Code and OpenCode. Submit the whole application once; the MCP builds images, connects services, configures them and starts them. The agent supplies missing configuration and reports the result.

## Install

You need Node.js 22+. Then add the MCP to your tool.

**Claude Code**

```sh
claude mcp add --scope user constructor-research -- npx -y constructor-research-mcp@latest
```

**Codex**

```sh
codex mcp add constructor-research -- npx -y constructor-research-mcp@latest
```

**OpenCode 2.x**

```sh
opencode mcp add --global constructor-research -- npx -y constructor-research-mcp@latest
```

**OpenCode 1.x** (no `--global` there):

```sh
opencode mcp add constructor-research -- npx -y constructor-research-mcp@latest
```

Then restart the tool and ask the agent anything about Constructor; it signs you in through the `sign_in` tool on first use. Windows notes, the optional wake-up hooks and troubleshooting are in [INSTALL.md](INSTALL.md). Restarting the tool picks up a new version.

## Authentication and connection

Each harness signs in once and keeps its own Constructor session; nothing is stored centrally and nothing goes in the MCP settings. When a tool returns `needs_auth`, the agent tells the user a sign-in window is about to open and calls `sign_in`:

1. The MCP opens a separate browser window (Chrome, Edge, Chromium or Brave, on macOS, Windows or Linux; `CONSTRUCTOR_BROWSER` names another executable) with a fresh temporary profile at the Constructor sign-in page.
2. The user signs in. The MCP reads the session cookies, closes the window itself and deletes the profile.
3. It saves `ap_access_token`, `ap_id_token` and `ap_refresh_token` to that harness's session file and answers `signed_in`. No token is ever returned or printed.

The MCP works with one Constructor at a time: the one the user signed in to, recorded as a `host=` line in the session file. Before the first sign-in it is `https://constructor.app`, or the host of a desk link the user gave. For another Constructor (for example `https://acme.constructor.app`), the agent passes any link from it as `sign_in`'s `url`; the new sign-in replaces the old one, and the MCP works there from then on. A desk link from a different Constructor than the signed-in one returns `wrong_environment`, which tells the agent to sign in there with that link.

`sign_in` waits up to `wait_seconds` (default 20, so it stays within short harness tool timeouts); while the user is still signing in it returns `sign_in_pending`, and calling it again waits on the same window. With a renewable session already saved it answers `signed_in` without opening anything (`force=true` signs in again).

The harness is recognised from the client name in the MCP handshake; its session file is `~/.config/constructor-research/sessions/<harness>.txt` (`claude-code`, `codex`, `opencode`; another client gets its own name), mode 600. Separate windows matter because a refresh token works once: two holders of one session would log each other out by renewing. Several sessions of the same harness share its file safely (below).

The access token lasts an hour. When it has under 10 minutes left, the next request first renews it: `GET /auth/session` with only the refresh token, which answers with new tokens that are saved at once. Renewal runs under `<session file>.lock`, so processes sharing a file renew once and the others use the saved tokens. Requests send only the access token, so the gateway never renews behind the MCP's back. The server allows renewal until the `max_slt` claim, 14 days after sign-in; from a day before that, every response carries `auth_warning` asking the agent to have the user sign in again. If the refresh token was already used elsewhere, it is dropped and, once the access token expires, `needs_auth` explains why. A session is never sent to a Constructor other than the one it was signed in to.

The same sign-in from a terminal (use `codex` or `opencode` in place of `claude-code`, or `--to <file>`; `--url` names a Constructor other than constructor.app):

```sh
npx -y -p constructor-research-mcp constructor-research-login --for claude-code
npx -y -p constructor-research-mcp constructor-research-login --url https://acme.constructor.app --for claude-code
```

On a machine without a screen (Linux without `DISPLAY`/`WAYLAND_DISPLAY`), `sign_in` says so; save a session from a copied cURL (DevTools → Network → Copy as cURL) instead:

```sh
npx -y -p constructor-research-mcp constructor-research-set-token capture.txt --for codex
```

The session belongs to the Constructor the cURL was sent to. It keeps the refresh token when the cURL has one (and warns that the browser it came from shares that session), and prints the expiry, never a token. A plain access token, without a refresh token, cannot be renewed and expires after an hour: under 3 minutes left, operations that change anything are refused (`get_deployment` still works); under 10 minutes every response carries `auth_warning`, and `deploy_app`/`update_app`/`build_image` warn from 40 minutes, because a build can outlast the token.

`CONSTRUCTOR_COOKIE_FILE` pins one session file for every harness instead (for scripts and tests). Every request rereads the session file, so a new sign-in needs no restart.

| Variable                            | Default                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `CONSTRUCTOR_BASE_URL`              | unset: the signed-in Constructor, else `https://constructor.app`; set, it fixes the host |
| `CONSTRUCTOR_API_PATH`              | `/api/platform-account`                                                                  |
| `CONSTRUCTOR_STORAGE_PATH`          | `/api/platform-storage`                                                                  |
| `CONSTRUCTOR_COOKIE_FILE`           | unset: `~/.config/constructor-research/sessions/<harness>.txt`                           |
| `CONSTRUCTOR_BROWSER`               | first Chrome, Edge, Chromium or Brave found                                              |
| `CONSTRUCTOR_STATE_DIR`             | `~/.local/state/constructor-research-mcp`                                                |
| `CONSTRUCTOR_UPLOAD_SETTLE_SECONDS` | `30`                                                                                     |
| `CONSTRUCTOR_READINESS_SECONDS`     | `60`                                                                                     |

HTTPS is required except on localhost. API-key authentication is not implemented yet.

## Fourteen tools

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
| `sign_in`                | Open a sign-in window for the user when a tool returns `needs_auth`.                |
| `create_folder`          | Create a disk folder, including missing parents.                                    |
| `sync_files`             | Upload new and changed files; asks once before replacing existing files.            |
| `move_path`              | Rename or move files/folders in one batch, approved once; never overwrites.         |
| `delete_path`            | Delete files/folders in one batch; reports first, deletes only with `confirm:true`. |

No special clone/new-instance workflow is implemented. The fourteen tools use the same standard MCP transport across harnesses.

## Where to act: the desk link

The agent does not choose a project or desk. It asks the user for the desk link: open the desk in Constructor and copy the browser address, for example

```text
https://constructor.app/research/projects/<project_id>/desks/<desk_id>/viewer/file
```

Every tool accepts it as `desk_url`, in place of `project_id`/`desk_id`. Anything after `/desks/<desk_id>` is ignored. The link's host must be the signed-in Constructor; a link from another one returns `wrong_environment` (see sign-in above). Explicit IDs, if also sent, must agree with the link. In `deploy_app`/`update_app`, builds without their own `desk_id` use the link's desk; `start_app`/`stop_app` and `get_deployment` take only the project from it.

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

Replace a service's `build` with `"image_id":"IMAGE_ID"` to skip building. `list_images` returns compact records with `not_started`, `snapshot_creation`, `in_progress`, `done` or `error`; `detailed:true` returns full records.

- Build storage is omitted by default, using the API's documented **50 GB** default. Explicit `ephemeral_build_disk_size_gb` overrides must be **10–1000 GB**.
- Each service can have multiple ports (1–65535), with at most **one public port**. That port must match where the container listens.
- Hardware: omit it. New services get the smallest available non-GPU option; existing services keep theirs. Only when the app needs more, pass minimums `hardware: {cpu, ram_gb, gpu}`; the MCP picks the smallest available option that meets them (GPU options only when `gpu:true`). `get_deployment` with `desk_url` lists `hardware_options` as plain specs (CPU, RAM, GPU), without names or IDs.
- Up to three volumes, each 10–2000 GB, with a mount path.
- Service names are lowercase DNS labels, max 63 characters.

## Missing prerequisites

- **No/expired token:** `needs_auth` with the file and format to use (see Authentication). Replace the token, then check the same deployment again.
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

Progress and sanitized results are checkpointed. Configuration secrets remain in owner-only local checkpoint files (`0600`, directory `0700`); tool responses return environment-variable names, never values. Cookies are not checkpointed. Do not commit credentials or state.

Checkpoints are bound to the API endpoint. A shared state directory coordinates local harnesses. `resume:false` on `get_deployment` observes without scheduling execution or confirming uploads; already running background work is not paused.

Terminal states: `built`, `started`, `stopped`, `failed`, `needs_reconciliation`, `superseded`. A new `update_app`, `start_app` or `stop_app` for an application ends that application's unfinished deployments as `superseded`, so an older one cannot apply its images after the newer one; its builds keep running on Constructor but are not used. The new result lists them in `replaced`, with the services they were changing that the new update leaves out. User-action pauses: `needs_auth`, `needs_upload`. Other statuses indicate background progress. An executor stops after one hour rather than retrying forever.

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

Builds can run for many minutes. The MCP keeps executing in the background, but an agent that has ended its turn is not told when they finish. `dist/wait.js` (bin `constructor-research-wait`) blocks until the given deployments, or all in-progress ones when no ID is given, finish, and prints one line each: status, message, services with public URLs, next step. Exit codes: `0` finished, `2` needs the user (failed, token, upload, volume confirmation), `3` still running at `--max-minutes` (default 60), `4` nothing in progress.

```sh
npx -y -p constructor-research-mcp constructor-research-wait <deployment_id>
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

The tools use the disk's WebDAV storage (`/api/platform-storage/desks/{disk}/dav/project/`) with the same cookie. `sync_files`:

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
