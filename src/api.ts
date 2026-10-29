import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BASE_URL, type Config } from "./config.js";
import {
  claims,
  readSession,
  saveSession,
  sessionHost,
  setCookies,
} from "./session.js";
import { withLock } from "./store.js";
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public apiCode?: number,
  ) {
    super(message);
  }
}
export const segment = (s: string) => encodeURIComponent(s);
/** `exp` (seconds) of the ap_access_token JWT, if readable. */
export function expiry(cookie: string): number | undefined {
  const token = /(?:^|;\s*)ap_access_token=([^;\s]+)/.exec(cookie)?.[1];
  const exp = claims(token)?.exp;
  return typeof exp === "number" ? exp : undefined;
}
/** Renew the access token when it has less than this left (it lasts an hour). */
const RENEW_MS = 10 * 60000;
export class PlatformApi {
  private readonly deadline = new AsyncLocalStorage<number>();
  constructor(readonly config: Config) {}
  /** End of the current call's time budget (epoch ms); Infinity outside one. */
  deadlineMs() {
    return this.deadline.getStore() ?? Infinity;
  }
  withBudget<T>(milliseconds: number, fn: () => Promise<T>): Promise<T> {
    return this.deadline.run(Date.now() + milliseconds, fn);
  }
  /** How to supply a fresh token, with the exact file this MCP reads. */
  authHelp(what = "Not signed in to Constructor.") {
    const to = this.config.cookieFile;
    return `${what} ${
      this.signingIn
        ? "A sign-in window is already open: ask the user to finish signing in there, then call sign_in to confirm."
        : "Tell the user a sign-in window is about to open, then call the sign_in tool: the user signs in in a separate Chrome window that closes by itself, and the MCP renews the session automatically for up to 14 days."
    } Without a desktop browser, the user runs: npx -y -p constructor-research-mcp constructor-research-set-token <file with a copied cURL> --to ${to}. Then repeat the same call.`;
  }
  /**
   * Works with the Constructor the saved session belongs to; without one, with the host of the
   * last desk link the user gave, or the default. CONSTRUCTOR_BASE_URL fixes it instead.
   */
  async followSession() {
    if (this.config.baseUrlFixed) return;
    const host = await sessionHost(this.config.cookieFile);
    this.config.baseUrl = host ?? this.aimed ?? DEFAULT_BASE_URL;
  }
  /** The host of a desk link given while nobody is signed in: sign_in opens there. */
  aimed?: string;
  /** Set while the sign_in tool's window is open. */
  signingIn = false;
  /**
   * Time left on the saved credentials: the login session when it can be renewed
   * (`max_slt`, the latest renewal the server allows), else the access token.
   */
  async authLeft(): Promise<
    { minutes: number; renewable: boolean } | undefined
  > {
    const saved = await readSession(this.config.cookieFile);
    const access = claims(saved.get("ap_access_token"));
    const renewable = saved.has("ap_refresh_token");
    const end = renewable ? access?.max_slt : access?.exp;
    if (renewable && end === undefined) return undefined;
    if (typeof end !== "number") return undefined;
    return { minutes: (end * 1000 - Date.now()) / 60000, renewable };
  }
  private renewing?: Promise<string>;
  /** The Cookie header for a request: only the access token, renewed first when it runs low. */
  private async cookie() {
    let saved: Map<string, string>;
    try {
      saved = await readSession(this.config.cookieFile);
    } catch {
      saved = new Map();
    }
    let token = saved.get("ap_access_token");
    const exp = expiry(`ap_access_token=${token}`);
    // Never send one Constructor's session to another.
    const owner = await sessionHost(this.config.cookieFile);
    if (owner && owner !== this.config.baseUrl)
      throw new ToolError(
        "needs_auth",
        this.authHelp(
          `${this.config.cookieFile} holds a session for ${owner}, but this MCP works with ${this.config.baseUrl}.`,
        ),
      );
    if (
      saved.has("ap_refresh_token") &&
      (!token || (exp !== undefined && exp * 1000 - Date.now() < RENEW_MS))
    )
      token = await (this.renewing ??= this.renew().finally(
        () => (this.renewing = undefined),
      ));
    else if (!token) throw new ToolError("needs_auth", this.authHelp());
    else if (exp !== undefined && exp * 1000 <= Date.now())
      throw new ToolError(
        "needs_auth",
        this.authHelp(
          `Token expired at ${new Date(exp * 1000).toISOString().slice(11, 16)} UTC.`,
        ),
      );
    return `ap_access_token=${token}`;
  }
  /**
   * Trades the refresh token for new tokens and saves them before anything else. A refresh
   * token works once, so several MCP processes sharing the file renew under one lock, and
   * a process that waited uses the tokens another one just saved.
   */
  private renew() {
    const file = this.config.cookieFile;
    return withLock(
      file + ".lock",
      async () => {
        const saved = await readSession(file);
        const token = saved.get("ap_access_token");
        const exp = expiry(`ap_access_token=${token}`);
        const valid = !!token && (exp === undefined || exp * 1000 > Date.now());
        const refresh = saved.get("ap_refresh_token");
        if (
          !refresh ||
          (exp !== undefined && exp * 1000 - Date.now() >= RENEW_MS)
        )
          return this.usable(token, valid);
        let response: Response;
        try {
          response = await fetch(
            this.config.baseUrl + this.config.apiPath + "/auth/session",
            {
              // Without an access token the server must renew; the browser does the same.
              headers: {
                Cookie: `ap_refresh_token=${refresh}`,
                Accept: "application/json",
              },
              redirect: "manual",
              signal: AbortSignal.timeout(this.config.requestTimeoutMs),
            },
          );
        } catch {
          if (valid) return token!;
          throw new ToolError(
            "connection_error",
            "Could not reach Constructor to renew the session; repeat the same call.",
          );
        }
        await response.body?.cancel();
        const fresh = setCookies(response);
        if (fresh.has("ap_access_token") && fresh.has("ap_refresh_token")) {
          await saveSession(file, new Map([...saved, ...fresh]));
          return fresh.get("ap_access_token")!;
        }
        if (response.status === 401) {
          // The refresh token is spent; drop it so the file behaves like a plain token.
          saved.delete("ap_refresh_token");
          await saveSession(file, saved);
          if (valid) return token!;
          throw new ToolError(
            "needs_auth",
            this.authHelp(
              "The saved login session can no longer be renewed: its refresh token was already used (a browser holding the same session renews it too) or the session reached its 14-day limit.",
            ),
          );
        }
        if (valid) return token!;
        throw new ToolError(
          "connection_error",
          `Constructor answered HTTP ${response.status} without new tokens while renewing the session; repeat the same call.`,
        );
      },
      15000,
      () =>
        new ToolError(
          "busy",
          `Another process is renewing the session (${file}.lock); repeat the same call.`,
        ),
    );
  }
  private usable(token: string | undefined, valid: boolean) {
    if (valid) return token!;
    throw new ToolError(
      "needs_auth",
      this.authHelp(token ? "Token expired." : undefined),
    );
  }
  /**
   * WebDAV request to a disk's project folder; callers interpret statuses other than 401.
   * The storage gateway answers 502/503/504 now and then under load; requests that are
   * safe to repeat (all but MOVE and DELETE) are retried a few times with backoff.
   */
  async storage(
    method: string,
    desk: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {},
  ) {
    const cookie = await this.cookie();
    const retries = ["MOVE", "DELETE"].includes(method)
      ? []
      : this.storageRetryMs;
    for (let attempt = 0; ; attempt++) {
      const remaining = (this.deadline.getStore() ?? Infinity) - Date.now();
      if (remaining <= 0)
        throw new ToolError(
          "connection_error",
          "Operation time budget exhausted; repeat the same call to continue.",
        );
      const wait = retries[attempt];
      const again = wait !== undefined && wait < remaining - 1000;
      let response: Response;
      try {
        response = await fetch(
          this.config.baseUrl + this.davRoot(desk) + path,
          {
            method,
            headers: { Cookie: cookie, ...init.headers },
            body: init.body,
            redirect: "manual",
            signal: AbortSignal.timeout(
              Math.max(1, Math.floor(Math.min(60000, remaining))),
            ),
          },
        );
      } catch {
        if (again) {
          await delay(wait);
          continue;
        }
        throw new ToolError(
          "connection_error",
          "Storage connection failed or timed out. Repeating the same call is safe.",
        );
      }
      if ([502, 503, 504].includes(response.status) && again) {
        await response.body?.cancel();
        await delay(wait);
        continue;
      }
      if (response.status === 401)
        throw new ToolError(
          "needs_auth",
          this.authHelp("Constructor rejected the token (expired or invalid)."),
          401,
        );
      return response;
    }
  }
  /**
   * Opens a build-log stream. It stays open while the build runs; the caller reads the
   * body and aborts through `signal`. 401 becomes needs_auth; other statuses are returned.
   */
  async stream(path: string, signal: AbortSignal) {
    const cookie = await this.cookie();
    let response: Response;
    try {
      response = await fetch(
        this.config.baseUrl +
          (this.config.keeperPath ?? "/api/platform-keeper") +
          path,
        {
          headers: { Cookie: cookie, Accept: "text/event-stream" },
          redirect: "manual",
          signal,
        },
      );
    } catch {
      throw new ToolError(
        "connection_error",
        "Build log connection failed or timed out.",
      );
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new ToolError(
        "needs_auth",
        this.authHelp("Constructor rejected the token (expired or invalid)."),
        401,
      );
    }
    return response;
  }
  /** Backoff before each storage retry; tests shorten it. */
  storageRetryMs = [1000, 2000, 4000];
  /** Server-side path of a disk's project folder, used for WebDAV Destination headers. */
  davRoot(desk: string) {
    return `${this.config.storagePath ?? "/api/platform-storage"}/desks/${segment(desk)}/dav/project/`;
  }
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const cookie = await this.cookie();
    const remaining = (this.deadline.getStore() ?? Infinity) - Date.now();
    if (remaining <= 0)
      throw new ToolError(
        "connection_error",
        "Operation time budget exhausted before sending the next request; resume with get_deployment.",
      );
    let response: Response;
    try {
      response = await fetch(this.config.baseUrl + this.config.apiPath + path, {
        method,
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.floor(Math.min(this.config.requestTimeoutMs, remaining)),
          ),
        ),
      });
    } catch {
      throw new ToolError(
        method === "GET" ? "connection_error" : "uncertain_outcome",
        method === "GET"
          ? "API connection failed or timed out; retry the read."
          : "The API request may have been applied. Inspect resources before retrying this mutation.",
      );
    }
    if (response.status === 401)
      throw new ToolError(
        "needs_auth",
        this.authHelp("Constructor rejected the token (expired or invalid)."),
        401,
      );
    if (!response.ok) {
      if (method !== "GET" && response.status >= 500)
        throw new ToolError(
          "uncertain_outcome",
          `Constructor API returned HTTP ${response.status}. The mutation may have been applied; inspect resources before retrying.`,
          response.status,
        );
      let apiCode: number | undefined;
      try {
        const d = (await response.json()) as any;
        if (typeof d?.details?.error_code === "number")
          apiCode = d.details.error_code;
      } catch {
        /* Error bodies can contain secrets; never echo them. */
      }
      throw new ToolError(
        "api_error",
        `Constructor API returned HTTP ${response.status}${apiCode ? ` (error ${apiCode})` : ""}.`,
        response.status,
        apiCode,
      );
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ToolError(
        method === "GET" ? "invalid_response" : "uncertain_outcome",
        "API returned an invalid response. Inspect resources before retrying a mutation.",
      );
    }
  }
}
