import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** The cookies the MCP keeps: the access token for requests, the refresh token to renew it. */
export const SESSION_COOKIES = [
  "ap_access_token",
  "ap_id_token",
  "ap_refresh_token",
] as const;

/** Claims of a JWT, or undefined when it is not one. */
export function claims(jwt?: string): Record<string, any> | undefined {
  try {
    return JSON.parse(Buffer.from(jwt!.split(".")[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

/** Session cookies found in a Cookie header, a cURL, a Set-Cookie list or a bare JWT. */
export function sessionCookies(text: string) {
  const found = new Map<string, string>();
  for (const name of SESSION_COOKIES) {
    const value = [
      ...text.matchAll(new RegExp(`(?:^|[\\s;'"])${name}=([\\w.~+/=-]+)`, "g")),
    ].at(-1)?.[1];
    if (value) found.set(name, value);
  }
  const bare = /^\s*(ey[\w-]+\.[\w-]+\.[\w-]+)\s*$/.exec(text)?.[1];
  if (bare && !found.size) found.set("ap_access_token", bare);
  return found;
}

/** Index of the line holding the tokens in a cookie file, or -1. */
const cookieLine = (lines: string[]) =>
  lines.findIndex((l) =>
    /^\s*(Cookie:\s*)?(ey[\w-]+\.|.*\bap_(access|refresh)_token=)/.test(l),
  );

/** The session saved in a cookie file; only its cookie line is read. */
export async function readSession(file: string) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const line = lines[cookieLine(lines)] ?? "";
  if (/[\x00-\x1f]/.test(line)) return new Map<string, string>();
  return sessionCookies(line.trim().replace(/^Cookie:\s*/i, ""));
}

/** The line naming the Constructor the session belongs to. */
const HOST = /^host=(\S+)\s*$/;

/**
 * The Constructor (an origin) a saved session belongs to: its host line, written at sign-in,
 * or else the issuer of its access token. Undefined when nothing is saved.
 */
export async function sessionHost(file: string) {
  let lines: string[];
  try {
    lines = (await readFile(file, "utf8")).split(/\r?\n/);
  } catch {
    return undefined;
  }
  const named = lines.map((l) => HOST.exec(l)?.[1]).find(Boolean);
  const line = lines[cookieLine(lines)] ?? "";
  const issuer = claims(
    sessionCookies(line.replace(/^\s*Cookie:\s*/i, "")).get("ap_access_token"),
  )?.iss;
  try {
    return new URL(named ?? issuer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the cookie line of a file with these cookies, keeping its other lines, and with
 * `host` its host line. Written to a temporary file and renamed, mode 600, so a reader never
 * sees half a token and a crash never loses the session.
 */
export async function saveSession(
  file: string,
  cookies: Map<string, string>,
  host?: string,
) {
  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf8")).split(/\r?\n/);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const line = SESSION_COOKIES.filter((n) => cookies.get(n))
    .map((n) => `${n}=${cookies.get(n)}`)
    .join("; ");
  const i = cookieLine(lines);
  if (i >= 0) lines[i] = line;
  else lines.unshift(line);
  if (host) {
    lines = lines.filter((l) => !HOST.test(l));
    lines.splice(lines.indexOf(line) + 1, 0, `host=${host}`);
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, lines.join("\n").replace(/\n*$/, "\n"), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(tmp, file);
}

/** New session cookies from a response's Set-Cookie headers. */
export function setCookies(response: Response) {
  return sessionCookies(
    response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  );
}
