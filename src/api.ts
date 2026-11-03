import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BASE_URL, VERSION, type Config } from "./config.js";
import { readKeyFile } from "./key.js";
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
/** A key as Constructor shows it, with or without the "Bearer " the header adds. */
export function cleanKey(raw: string | undefined) {
  const key = raw?.trim().replace(/^Bearer\s+/i, "");
  // Printable ASCII only: anything else could not travel in a header.
  return key && /^[\x21-\x7e]{8,512}$/.test(key) ? key : undefined;
}
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
  /** How the user supplies a key; the key itself never passes through the chat. */
  keyHelp(what = "No Constructor access key is set.") {
    return `${what} The MCP needs the user's personal access key (rk-…) for ${this.config.baseUrl}. Ask the user to run this in a terminal and paste the key when asked: npx -y -p constructor-research-mcp@${VERSION} constructor-research-set-key ${this.config.baseUrl} (or to set CONSTRUCTOR_ACCESS_KEY and CONSTRUCTOR_BASE_URL in the MCP settings). Never ask the user to paste the key into the chat. Then repeat the same call.`;
  }
  /**
   * Works with the Constructor the saved key belongs to, unless CONSTRUCTOR_BASE_URL fixes it.
   * Read before every tool call, so a key saved meanwhile is used without a restart.
   */
  async refresh() {
    if (this.config.baseUrlFixed || this.config.accessKey) return;
    const saved = await readKeyFile(this.config.keyFile).catch(() => undefined);
    this.config.baseUrl = saved?.url ?? DEFAULT_BASE_URL;
  }
  /** The access-key header for a request. */
  private async auth() {
    let key = this.config.accessKey;
    if (key === undefined) {
      let saved;
      try {
        saved = await readKeyFile(this.config.keyFile);
      } catch (err: any) {
        throw new ToolError(
          "needs_key",
          this.keyHelp(
            `${this.config.keyFile} could not be read (${err?.message ?? "invalid"}).`,
          ),
        );
      }
      if (!saved) throw new ToolError("needs_key", this.keyHelp());
      // Never send one Constructor's key to another.
      if (saved.url !== this.config.baseUrl)
        throw new ToolError(
          "needs_key",
          this.keyHelp(
            `The saved key belongs to ${saved.url}, but this MCP works with ${this.config.baseUrl}.`,
          ),
        );
      key = saved.key;
    }
    const clean = cleanKey(key);
    if (!clean)
      throw new ToolError(
        "needs_key",
        this.keyHelp("The access key is not in a valid format."),
      );
    return { "X-Research-AccessKey": `Bearer ${clean}` };
  }
  private rejected() {
    return new ToolError(
      "needs_key",
      this.keyHelp(
        "Constructor rejected the access key (revoked, expired or for another Constructor).",
      ),
      401,
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
    const auth = await this.auth();
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
            headers: { ...auth, ...init.headers },
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
      if (response.status === 401) {
        await response.body?.cancel();
        throw this.rejected();
      }
      return response;
    }
  }
  /**
   * Opens a build-log stream. It stays open while the build runs; the caller reads the
   * body and aborts through `signal`. 401 becomes needs_key; other statuses are returned.
   */
  async stream(path: string, signal: AbortSignal) {
    const auth = await this.auth();
    let response: Response;
    try {
      response = await fetch(
        this.config.baseUrl +
          (this.config.keeperPath ?? "/api/platform-keeper") +
          path,
        {
          headers: { ...auth, Accept: "text/event-stream" },
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
      throw this.rejected();
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
    const auth = await this.auth();
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
          ...auth,
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
    if (response.status === 401) {
      await response.body?.cancel();
      throw this.rejected();
    }
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
