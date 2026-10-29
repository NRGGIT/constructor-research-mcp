import { z } from "zod";
import { ToolError } from "./api.js";
import { id, deskUrl } from "./schemas.js";

/** Where a tool acts: a desk (project + desk), a project only, or a deployment-shaped input whose schema already allows a missing project_id. */
export type Scope = "desk" | "project" | "deploy";

/** Tool-facing schema: the engine schema plus desk_url, with the IDs it supplies made optional. */
export function located(
  schema: z.ZodObject<any>,
  scope: Exclude<Scope, "deploy">,
) {
  return schema
    .extend({
      project_id: id.optional(),
      ...("desk_id" in schema.shape ? { desk_id: id.optional() } : {}),
      desk_url: deskUrl.optional(),
    })
    .refine(
      (x: any) =>
        !!x.desk_url ||
        (!!x.project_id &&
          (scope !== "desk" ||
            !!x.desk_id ||
            schema.shape.desk_id.safeParse(undefined).success)),
      scope === "desk"
        ? "Provide desk_url (the desk link from the browser) or project_id and desk_id."
        : "Provide desk_url (the desk link from the browser) or project_id.",
    );
}

function bad(code: string, message: string): never {
  throw new ToolError(code, message);
}

/** Project and desk IDs from a desk link; the host must be the Constructor this MCP uses. */
export function parseDeskUrl(link: string, baseUrl: string, fixed = false) {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    bad("invalid_input", "desk_url is not a valid link.");
  }
  const m = url.pathname.match(
    /\/projects\/([a-zA-Z0-9_-]{4,128})\/desks\/([a-zA-Z0-9_-]{4,128})(?:\/|$)/,
  );
  if (!m)
    bad(
      "invalid_input",
      "desk_url must contain /projects/<project>/desks/<desk>. Ask the user to open the desk in Constructor and copy the address bar.",
    );
  const base = new URL(baseUrl).origin;
  if (url.origin !== base)
    bad(
      "wrong_environment",
      fixed
        ? `The link is for ${url.origin}, but this MCP is fixed to ${base} by CONSTRUCTOR_BASE_URL. Ask the user for a link from ${base}.`
        : `The link is for ${url.origin}, but the user is signed in to ${base}. If they work on ${url.origin}, tell them a sign-in window is about to open, then call sign_in with url set to this link; that replaces the sign-in to ${base}.`,
    );
  return { project_id: m[1], desk_id: m[2] };
}

/** Replace desk_url with the IDs it carries; explicit IDs must agree with it. */
export function resolveDeskUrl(
  args: any,
  baseUrl: string,
  scope: Scope,
  fixed = false,
) {
  if (!args?.desk_url) return args;
  const { desk_url, ...rest } = args;
  const at = parseDeskUrl(desk_url, baseUrl, fixed);
  if (rest.project_id && rest.project_id !== at.project_id)
    bad("invalid_input", "project_id does not match the project in desk_url.");
  rest.project_id = at.project_id;
  if (scope === "desk") {
    if (rest.desk_id && rest.desk_id !== at.desk_id)
      bad("invalid_input", "desk_id does not match the desk in desk_url.");
    rest.desk_id = at.desk_id;
  }
  if (scope === "deploy" && rest.services)
    rest.services = rest.services.map((s: any) =>
      s.build && !s.build.desk_id
        ? { ...s, build: { ...s.build, desk_id: at.desk_id } }
        : s,
    );
  return rest;
}
