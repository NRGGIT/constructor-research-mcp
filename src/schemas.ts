import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9_-]{4,128}$/);
const name = z.string().min(1).max(128);
const serviceName = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use a lowercase DNS label (letters, numbers, hyphens; max 63 characters).",
  );
const storage = z
  .number()
  .int()
  .min(10)
  .max(1000)
  .optional()
  .describe(
    "Omit to use the API default (50 GB). Overrides must be 10–1000 GB.",
  );
const dockerfile = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) => !s.split("/").includes("..") && !/[\x00-\x1f]/.test(s),
    "Use a disk-relative Dockerfile path without parent traversal.",
  );
const remotePath = z
  .string()
  .max(4096)
  .refine(
    (s) =>
      !s.split("/").some((x) => x === ".." || x === ".") &&
      !/[\x00-\x1f\\]/.test(s),
    "Use a disk-relative path without '.', '..' or control characters.",
  );
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.startsWith("/"), "Use an absolute local path.");
const build = z
  .strictObject({
    desk_id: id.optional(),
    dockerfile: dockerfile
      .optional()
      .describe(
        "Disk path of the Dockerfile. With local_path: path inside that folder (default Dockerfile).",
      ),
    local_path: localPath
      .optional()
      .describe(
        "Local folder with the source and Dockerfile. The MCP uploads it to the disk first (new files without asking; replacing files needs confirm=true), then builds. Files matched by the folder's .dockerignore are not uploaded. A large folder may take several calls: on in_progress repeat the same deploy/update call.",
      ),
    remote_path: remotePath
      .optional()
      .describe(
        "Disk folder for local_path; defaults to the local folder's name.",
      ),
    name: name.optional(),
    ephemeral_build_disk_size_gb: storage,
  })
  .refine(
    (b) => !!b.dockerfile || !!b.local_path,
    "build needs dockerfile, or local_path with the Dockerfile inside it.",
  )
  .refine(
    (b) => !b.remote_path || !!b.local_path,
    "remote_path is only used with local_path.",
  );
const wait = z
  .number()
  .min(0)
  .max(20)
  .default(20)
  .describe(
    "Wait up to this many seconds for completion; execution continues in the MCP after the response.",
  );
const requestId = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "Optional retry key. Omit it: the MCP generates deployment IDs automatically.",
  );
export const buildInput = z.strictObject({
  project_id: id,
  desk_id: id,
  dockerfile,
  name,
  ephemeral_build_disk_size_gb: storage,
  request_id: requestId,
  wait_seconds: wait,
});
export const listInput = z.strictObject({
  project_id: id,
  desk_id: id.optional(),
  detailed: z.boolean().default(false),
});
const port = z.strictObject({
  id: id.optional(),
  number: z.number().int().min(1).max(65535),
  expose_to_internet: z.boolean(),
});
const ports = z
  .array(port)
  .refine(
    (p) => p.filter((x) => x.expose_to_internet).length <= 1,
    "Only one public port per service.",
  )
  .refine(
    (p) => new Set(p.map((x) => x.number)).size === p.length,
    "Port numbers must be unique.",
  );
const volume = z
  .strictObject({
    id: id.optional(),
    name,
    mount_point: z.string().startsWith("/"),
    size_gb: z.number().int().min(10).max(2000),
  })
  .describe(
    "Persistent disk for this service only (see the volume rules). Changing name, mount_point or size_gb wipes it. On update, omit volumes to keep them; a supplied list replaces the current one.",
  );
const reference = z
  .strictObject({
    service: serviceName,
    exposure: z.enum(["internal", "public"]).default("internal"),
    port: z.number().int().min(1).max(65535).optional(),
    scheme: z
      .enum(["http", "https"])
      .optional()
      .describe(
        "Internal only: prefix added to the address. Omit it to get a bare host:port (for gRPC, databases, Temporal and similar); set http for an HTTP URL.",
      ),
  })
  .describe(
    "Resolved by the MCP into the other service's address. internal: <host>:<port> inside the app (port required), e.g. svc-api.app-1234abcd.svc.cluster.local:7233, or http://... when scheme is set. public: the service's https URL.",
  )
  .refine(
    (r) => r.exposure === "public" || r.port !== undefined,
    "Internal references require a port.",
  )
  .refine(
    (r) =>
      r.exposure !== "public" || r.scheme === undefined || r.scheme === "https",
    "Public references use HTTPS.",
  );
export const serviceInput = z
  .strictObject({
    name: serviceName,
    service_id: id.optional(),
    image_id: id.optional(),
    build: build.optional(),
    hardware: z
      .strictObject({
        cpu: z.number().positive().max(256).optional(),
        ram_gb: z.number().positive().max(4096).optional(),
        gpu: z.boolean().optional(),
      })
      .optional()
      .describe(
        "Omit this: the default hardware is used, and existing services keep theirs. Set it only when the app clearly cannot run on the default (needs a GPU, or loads large models/datasets into memory). Values are minimums; the smallest available option that meets them is chosen. get_deployment with desk_url lists hardware_options.",
      ),
    ports: ports.optional(),
    volumes: z.array(volume).max(3).optional(),
    environment_variables: z
      .record(z.string().min(1), z.union([z.string(), reference]))
      .optional()
      .describe(
        "Plain strings, or {service, port[, scheme]} to point at another service of the same app; never localhost.",
      ),
    depends_on: z.array(serviceName).optional(),
  })
  .refine(
    (s) => !(s.image_id && s.build),
    "Choose image_id or build, not both.",
  );
export const deskUrl = z
  .string()
  .max(2048)
  .describe(
    "Link to the Constructor desk the user copied from the browser, e.g. https://constructor.app/research/projects/<project>/desks/<desk>/viewer/file. Supplies project_id and desk_id; ask the user for it instead of choosing a project or desk yourself.",
  );
const deploymentShape = {
  project_id: id.optional(),
  desk_url: deskUrl
    .optional()
    .describe(
      "Desk link from the user: sets project_id and the desk for builds without desk_id.",
    ),
  project_name: name.optional(),
  application_name: name.optional(),
  services: z.array(serviceInput).min(1).optional(),
  files_uploaded: z.boolean().default(false),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Set after the user approved replacing existing disk files listed by a previous confirm_required response.",
    ),
  confirm_volume_wipe: z
    .boolean()
    .default(false)
    .describe(
      "Set only after the user approved losing the data in the volumes listed by a previous confirm_required response.",
    ),
  request_id: requestId,
  wait_seconds: wait,
  deployment_id: z.string().uuid().optional(),
};
export const deployInput = z
  .strictObject(deploymentShape)
  .refine(
    (x) => !!x.deployment_id || (!!x.application_name && !!x.services),
    "New deployments require application_name and services. To resume, provide deployment_id and optional service overrides.",
  );
export const updateInput = z
  .strictObject({ ...deploymentShape, application_id: id.optional() })
  .refine(
    (x) =>
      !!x.deployment_id ||
      ((!!x.project_id || !!x.desk_url) && !!x.application_id && !!x.services),
    "Updates require desk_url or project_id, plus application_id and services, or deployment_id to resume.",
  );
export const lifecycleInput = z.strictObject({
  project_id: id,
  application_id: id,
  service_names: z.array(serviceName).min(1).optional(),
  wait_seconds: wait,
});
export const getInput = z
  .strictObject({
    deployment_id: z.string().uuid().optional(),
    project_id: id.optional(),
    desk_url: deskUrl
      .optional()
      .describe(
        "Desk link from the user; selects its project for the project view.",
      ),
    application_id: id.optional(),
    files_uploaded: z.boolean().optional(),
    resume: z.boolean().default(true),
    wait_seconds: wait,
  })
  .refine(
    (x) => !x.application_id || !!x.project_id || !!x.desk_url,
    "application_id requires desk_url or project_id.",
  )
  .refine(
    (x) => x.resume || x.files_uploaded === undefined,
    "files_uploaded cannot be set in observation mode.",
  );
export const logsInput = z
  .strictObject({
    image_id: id
      .optional()
      .describe(
        "Image (build) ID: failure.image_id, or an image from get_deployment/list_images.",
      ),
    service_id: id
      .optional()
      .describe("Service ID from get_deployment (services[].id)."),
    deployment_id: z
      .string()
      .uuid()
      .optional()
      .describe("All builds and services this deployment started."),
    lines: z
      .number()
      .int()
      .min(10)
      .max(50)
      .default(20)
      .describe("How many of the last log lines to return."),
  })
  .refine(
    (x) =>
      [x.image_id, x.service_id, x.deployment_id].filter(Boolean).length === 1,
    "Pass one of image_id, service_id or deployment_id.",
  );
export type ServiceInput = z.infer<typeof serviceInput>;
export type DeploymentInput =
  z.infer<typeof deployInput> | z.infer<typeof updateInput>;
export const listFilesInput = z.strictObject({
  project_id: id,
  desk_id: id,
  path: remotePath.default("").describe("Folder on the disk; '' is the root."),
  recursive: z.boolean().default(false),
  max_entries: z.number().int().min(1).max(5000).default(500),
});
const requiredPath = remotePath.refine(
  (s) => s.replace(/\//g, "") !== "",
  "A path below the disk root is required.",
);
export const createFolderInput = z.strictObject({
  project_id: id,
  desk_id: id,
  path: requiredPath.describe(
    "Folder to create; missing parent folders are created too.",
  ),
});
const confirm = z
  .boolean()
  .default(false)
  .describe(
    "false (default) returns the full list for the user to approve once; true performs it.",
  );
export const movePathInput = z.strictObject({
  project_id: id,
  desk_id: id,
  moves: z
    .array(
      z.strictObject({
        from: requiredPath.describe("Existing file or folder."),
        to: requiredPath.describe(
          "New path. Its parent folder must exist; an existing target is never overwritten.",
        ),
      }),
    )
    .min(1)
    .max(100)
    .describe("All renames/moves for this request, approved together."),
  confirm,
});
export const deletePathInput = z.strictObject({
  project_id: id,
  desk_id: id,
  paths: z
    .array(requiredPath)
    .min(1)
    .max(100)
    .describe(
      "All files/folders to delete for this request, approved together. Folders are deleted with all contents.",
    ),
  confirm,
});
export const syncFilesInput = z.strictObject({
  project_id: id,
  desk_id: id,
  local_path: localPath.describe(
    "Absolute local file or folder. A folder's contents go into remote_path.",
  ),
  remote_path: remotePath
    .default("")
    .describe("Destination folder on the disk; '' is the root."),
  exclude: z
    .array(z.string().min(1).max(256))
    .max(100)
    .default([])
    .describe(
      "Extra names or '*' patterns to skip, matched against file names and relative paths.",
    ),
  dry_run: z
    .boolean()
    .default(false)
    .describe("true only reports the plan, without uploading."),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Needed only when existing files would be replaced: the first call returns the list for the user to approve once; repeat with confirm=true.",
    ),
});

export const signInInput = z.strictObject({
  url: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Any link to the user's Constructor: a desk link, or just its address, e.g. https://acme.constructor.app. The user signs in there and the MCP works there afterwards, replacing any earlier sign-in. Pass it when the user names their Constructor or gives a link; omit it to sign in where the MCP works now (https://constructor.app unless the user signed in elsewhere).",
    ),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(25)
    .default(20)
    .describe("How long to wait for the user to finish signing in."),
  force: z
    .boolean()
    .default(false)
    .describe(
      "Open the window even though a renewable session is saved (to switch account).",
    ),
});
