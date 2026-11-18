# How the Constructor Research MCP works

This is the inside view: what the parts are, how a request travels through them, and why
they are built that way. The README describes behaviour from the outside (tools, inputs,
outputs); read it for what the agent sees. This file is for whoever changes the code.

## The idea in one paragraph

An agent describes the **whole application** once (`deploy_app` / `update_app`). The MCP
turns that intent into a **saved operation** on the user's machine and executes it **in the
background**, step by step, against Constructor's public API. Every step that changes
something in Constructor is written down before and after it runs, so the work survives a
crash, a restart, or a second MCP process. The agent never performs steps itself; it only
submits intent and observes the result (`get_deployment`, the wait command, `get_logs`).

## Processes and entry points

Three programs ship in the package (`package.json` → `bin`):

| Program                        | File             | What it is                                                                               |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `constructor-research-mcp`     | `src/server.ts`  | The MCP server over stdio. Also `install` (setup wizard, `src/install.ts`).              |
| `constructor-research-wait`    | `src/wait.ts`    | Blocks until deployments finish; also the Stop hook for Claude Code, Codex and opencode. |
| `constructor-research-set-key` | `src/set-key.ts` | Reads the access key hidden from the terminal, checks it, saves it.                      |

Several of these can run at once on one machine (one MCP per agent window, plus wait
commands). They share nothing in memory. They share **the state directory** on disk, and a
lock file in it. That is the whole coordination model.

## Module map

| Module                    | Responsibility                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`               | Settings from environment variables (`configFromEnv`), the package version, the wait command line.                                                     |
| `desk.ts`                 | Detects that the MCP runs inside a Constructor desk (`ROLOS_*` / `RESEARCH_*` variables) and maps local paths to the desk's disk.                      |
| `key.ts`                  | The key file (`~/.config/constructor-research/access-key.json`, mode 600), checking a key, and choosing where requests go (`routeKey`).                |
| `api.ts`                  | `PlatformApi`: every HTTP request to Constructor. Adds the key header, picks the origin, enforces time budgets, turns HTTP failures into `ToolError`s. |
| `schemas.ts`              | Zod input schemas of all tools; these are also the tool descriptions the agent reads.                                                                  |
| `location.ts`             | `desk_url` → project and desk IDs; which Constructor a link may come from.                                                                             |
| `server.ts`               | Registers the fourteen tools, the agent instructions, desk defaults, external-image registration before a deployment.                                  |
| `runtime.ts`              | `DeploymentRuntime`: runs operations in the background and answers "wait up to N seconds".                                                             |
| `deployment.ts`           | `DeploymentEngine`: the deployment logic itself — one `advance` step at a time.                                                                        |
| `store.ts`                | `StateStore`: saved operations (one JSON file each), heartbeats, the cross-process lock.                                                               |
| `files.ts`                | `FileManager`: the desk disk over WebDAV — list, upload (sync), move, delete — and Dockerfile checks (lint, preflight).                                |
| `logs.ts`                 | `LogFollower`: follows live build and service logs and keeps the last lines on disk.                                                                   |
| `wait.ts`                 | The wait CLI and the client hooks that wake an agent when a deployment ends.                                                                           |
| `agents.ts`, `install.ts` | Finds coding agents on the machine and writes the MCP entry into each one's settings.                                                                  |

## Talking to Constructor (`api.ts`, `key.ts`)

- **Only the personal access key.** Every request carries `X-Research-AccessKey: Bearer rk-…`.
  There is no browser sign-in, no cookies, and redirects are never followed.
- **Where the key comes from:** `CONSTRUCTOR_ACCESS_KEY`, else the key file. The key file is
  re-read before every tool call, so a key saved meanwhile works without a restart.
- **Which Constructor:** `config.baseUrl` is the user's Constructor — `CONSTRUCTOR_BASE_URL`,
  else the key file's `url`, else the desk's server, else `https://constructor.app`. Links
  shown to the user and key help always use it.
- **Where requests go** (`PlatformApi.origin`): normally `baseUrl`. Inside a desk whose
  server (`ROLOS_API_SERVER`) differs from it, the MCP asks that server once whether it
  accepts the key; if yes, requests go there. The answer is cached per key and address pair.
  Setup (`install`, `set-key`) checks the key with both addresses.
- **Three API roots:** the account API (`/api/platform-account/v1`, JSON), desk storage
  (`/api/platform-storage/desks/{desk}/dav/project/`, WebDAV) and build/service logs
  (`/api/platform-keeper/...`, a live text stream).
- **Errors:** 401 → `needs_key` with instructions for the user (the key never goes through
  the chat). A failed GET → `connection_error` (safe to repeat). A failed or 5xx mutation →
  `uncertain_outcome` (it may have been applied; see reconciliation below). Constructor's
  own refusal reason (`detail.info.details`) is kept in `ToolError.reason` and shown only
  where it is known to be safe; error bodies are never echoed otherwise.
- **Time budgets:** each tool call runs inside `withBudget(ms)`. Requests shrink their
  timeout to what is left, so a slow API cannot make a call outlive the client's tool timeout.

## A deployment from start to finish

### 1. The tool call (`server.ts`)

1. `api.refresh()` re-reads the key file.
2. `desk_url` (or, inside a desk, the desk itself) becomes `project_id` / `desk_id`.
3. For `deploy_app` / `update_app`, services given as `image` (a registry reference) are
   resolved: an image the project already has (same reference, short form, name or ID) is
   reused; any other is added to the project as an **external image**
   (`POST /projects/{p}/images/external`). Deployment is switched on first, because
   Constructor adds external images only to a project with deployment on. A refusal comes
   back as `image_refused` with Constructor's reason, before anything else is created.
4. The call goes to `DeploymentRuntime`.

### 2. Submit (`runtime.ts` → `deployment.ts: submit`)

Under the store lock, the engine creates an **operation**: a JSON file
`<state dir>/<uuid>.json` holding the input, the status, and the IDs of everything it
creates (`desks`, `images`, `services`, `application_id`). The ID comes from `request_id`
when the agent gives one, so the same request twice is the same operation; reusing a
`request_id` with different arguments is refused.

An `update`, `start` or `stop` of an application first **supersedes** unfinished operations
of the same application, so an older one cannot apply its images after the newer one.

### 3. Execute in the background (`runtime.ts: run`)

The runtime calls `engine.get(resume)` in a loop. Each call takes the lock, loads the
operation, performs **one step** (`advance`), saves, and releases the lock. Between steps
that only wait (a build running), it sleeps 5 s. It writes a heartbeat file
(`<uuid>.alive`) so other processes can tell the operation is being worked on. One hour is
the limit.

The tool call itself only waits up to `wait_seconds` and returns a snapshot. If the
operation is not finished, the snapshot's `next_action` tells the agent to run the wait
command (or poll `get_deployment`).

### 4. The steps (`deployment.ts: advanceApp`)

Roughly in this order; each step is idempotent and skipped when already done:

1. **Prepare** — the project must exist and not be archived; deployment is switched on if
   off (only the owner may: `deployment_disabled` otherwise); the application is created.
2. **Confirm volumes** — removing or changing a volume wipes its data, so the operation stops
   as `confirm_required` until the agent repeats the call with `confirm_volume_wipe=true`.
3. **Sources** — services with `build` need a desk (the given one, the project's only one, or
   a new `<app>-source` desk). Local folders are uploaded (`sync`), or the operation pauses as
   `needs_upload` until the agent syncs and sets `files_uploaded=true`. Each Dockerfile is
   checked first (`preflight` / `lintDockerfile`): missing FROM/EXPOSE, port mismatch,
   localhost, scripts without chmod, nginx `listen [::]`.
4. **Build** — `POST /desks/{d}/images` per service with `build` (services with `image` or
   `image_id` skip this; a resumed operation keeps the builds it already finished). The
   MCP polls `build_status`, follows the build log, and retries a failed build once (the
   platform briefly reports `error` while it retries, so an error counts on the second
   sighting).
5. **Configure** — services are created or patched in dependency order. References between
   services (`{"service": "api", "port": 3000}`) are resolved to internal addresses
   (`svc-<name>.app-<id>.svc.cluster.local:<port>`) or public URLs.
6. **Start** — services are started; their logs are followed from the start.
7. **Verify** — public URLs are probed for up to `CONSTRUCTOR_READINESS_SECONDS` (60 s).
   A URL that does not answer is reported with the likely cause, using what the logs showed
   (a service that printed nothing usually crashes before its first line).
8. **Started** — the final status, with public URLs.

Builds (`build_image`) and `start_app` / `stop_app` have their own shorter sequences
(`advanceBuild`, `advanceLifecycle`).

### 5. Statuses

| Kind                                  | Statuses                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| In progress                           | `preparing`, `building`, `configuring`, `starting`, `waiting`, `verifying`                        |
| Paused, waiting for the user or agent | `needs_key`, `needs_upload`                                                                       |
| Final                                 | `started`, `stopped`, `built`, `failed`, `confirm_required`, `needs_reconciliation`, `superseded` |

A failed operation carries `failure`: the `stage` and `service` that failed, the Dockerfile,
and `log_tail` (the last log lines) when the MCP captured them.

## Deleting (`deployment.ts: deleteResources`)

One tool, `delete_resources`, covers applications, services and images, so the agent's tool
list stays short. It reads the project's applications and images, builds the list of what
would go (with public URLs and volumes), and returns it unless `confirm` is true. On
confirm it first marks unfinished operations of the affected applications `superseded`
under the store lock (their background loops stop at the next step), then deletes
services, applications and images in that order through `DELETE /services/{id}`,
`/applications/{id}` and `/images/{id}`. An image used by a service that stays is never
deleted. Deletes are not recorded as operations: each one is a single request, and an item
already gone (404, or 421 "not found") counts as done.

## Why it survives crashes (`store.ts`)

- **Write-ahead for every change.** `mutate()` saves `pending: {method, path}` before a
  request that changes Constructor, and clears it after the response. If the process dies
  in between, the next step finds `pending` and stops as `needs_reconciliation` instead of
  creating a second copy. The agent then inspects Constructor and starts a new request
  using the existing IDs.
- **Atomic saves.** Each save writes a temp file and renames it over the old one.
- **One lock for all processes.** `<state dir>/.lock` is created exclusively. A call waits
  up to 15 s for it, then answers `busy` ("repeat the same call"). A lock left by a process
  that no longer exists is broken safely.
- **Recovery on start.** A starting MCP resumes every unfinished operation it finds
  (`runtime.recover`). The wait command does the same for an operation nobody has advanced
  for a minute — so a deployment continues even if the agent window that started it closed.
- **Operations are bound to a Constructor.** Each saved operation records its endpoint;
  another Constructor's operation is refused (`endpoint_mismatch`).

## Logs (`logs.ts`)

Constructor serves logs **only live**: a build log while the build runs, a service log for its
current container. Each connection replays the log from the start, then streams. Nothing is
kept after the build ends or the container restarts.

So the MCP keeps them:

- It follows every build it starts until the build ends, and every service it starts or
  shows for two hours after that (or after the last `get_logs`).
- It keeps the last **2000 lines** of each in `<state dir>/logs/<build|service>-<id>.json`,
  saved every few seconds. Other MCP processes, the wait command and a restarted agent read
  the same files.
- Reconnects skip lines already kept (by timestamp). A new container is detected in the
  stream and marked `--- new container (restart N) ---`, with the old container's last lines
  above it.
- `watched` records when the MCP followed each log. A container that started and stopped
  while nobody followed left no lines — Constructor has none either.
- Rotation: files untouched for 14 days are deleted, and the oldest go first when all of
  them pass 100 MB. Logs being followed are never deleted.
- `get_logs` returns the last 10–500 lines (default 20); a failure puts the last 20 into
  `failure.log_tail`.

## Waiting and waking the agent (`wait.ts`)

An agent that ends its turn is not told when a build finishes. Two mechanisms cover it:

- **The wait command** blocks until the given (or all recent) deployments end and prints
  one line each. Exit codes: `0` done, `2` needs the user, `3` still running at the time
  limit, `4` nothing in progress. The tool results name this command in `next_action`.
- **Hooks** (added by `install`, or `constructor-research-wait --install codex|claude-code`):
  - Claude Code: a `PostToolUse` hook with `asyncRewake` waits for the deployment named in
    the tool result and wakes Claude with the outcome (exit 2).
  - Codex: a `Stop` hook waits for in-progress deployments, then continues the turn with the
    outcome.
  - opencode: the same through a plugin (`examples/opencode-plugin.js`).

  Either way the agent reports the result instead of ending its turn while a build runs.

## Inside a Constructor desk (`desk.ts`)

When `ROLOS_PROJECT_ID` and `ROLOS_DESK_ID` (or the `RESEARCH_*` names) are set, the MCP
runs inside that desk:

- `~/project` (or `CONSTRUCTOR_DESK_ROOT`) **is** the desk's disk. Files are edited in place;
  nothing is uploaded, and the file tools answer `local_desk` for this desk.
- Build, deploy, start, stop and image tools default to this desk and project.
- Requests may go to the desk's server rather than the user's address (see "Talking to
  Constructor").

`CONSTRUCTOR_LOCAL_DESK=0` turns this off.

## Desk files (`files.ts`)

The desk disk is reached over WebDAV. `sync_files` compares local files with the disk
(size, then checksum), uploads new and changed ones in parallel (4 at a time; each file goes to a temp name in
`.rolos-temp/` and is then moved into place; files over ~9 MB go in 4 MB ranged chunks),
and **asks once** before
replacing existing files (`confirm_required`). It honours `.dockerignore` and skips `.git`,
`node_modules`, `.env` and similar. Each call stops starting new uploads after 45 s so it
returns before the client's tool timeout; the agent repeats the call to continue. Moves and
deletes are batched and approved once; nothing is overwritten silently.

## Setup (`install.ts`, `agents.ts`)

`npx -y constructor-research-mcp@latest install` finds the coding agents on the machine
(Claude Code, Codex, OpenCode, Cursor, Cline, jcode, Gemini CLI), asks project or global, asks which
Constructor, checks and saves the key, and adds the MCP entry to each agent's settings. The
key is never written into an agent's settings or a command line. Changed settings files are
backed up first (with any key in them removed), and an entry is only written when the
parsed result shows nothing else changed.

## Security rules the code keeps

- The key never appears in tool output, logs, error messages, command lines or agent
  settings. Error bodies from Constructor are not echoed.
- One Constructor's saved key is never sent to an unrelated host. The only other address it
  goes to is the server named by the desk the MCP runs in.
- HTTPS everywhere except localhost (tests).
- State files and the key file are readable only by the user (mode 600, folders 700).
- Environment variable **values** of services are never returned, only their names.

## Tests

`npm test` runs everything against `test/platform.ts`, an in-process fake Constructor that
mimics the account API, WebDAV and the log streams, including their failure modes (401,
421 refusals, 502 bursts, dropped streams, restarted containers). Some tests start the real
server over stdio (`dist/server.js`), so `npm test` builds first. No test touches a real
Constructor.
