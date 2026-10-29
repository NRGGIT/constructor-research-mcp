// Sign in to Constructor in a separate Chrome window and save the session.
// The window uses a fresh temporary profile: a session nothing else holds, so the MCP can
// renew it without logging out the user's own browser (a refresh token works only once).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import { claims, saveSession, setCookies, SESSION_COOKIES } from "./session.js";

const SIGN_IN_MINUTES = 15;

export type SignInResult =
  | {
      status: "signed_in";
      message: string;
      session_file: string;
      host: string;
      until?: string;
    }
  | { status: "sign_in_failed"; message: string };

/** A Chromium-based browser on macOS, Windows or Linux; CONSTRUCTOR_BROWSER overrides. */
export function findBrowser() {
  if (process.env.CONSTRUCTOR_BROWSER)
    return existsSync(process.env.CONSTRUCTOR_BROWSER)
      ? process.env.CONSTRUCTOR_BROWSER
      : undefined;
  const env = process.env;
  const installed =
    process.platform === "win32"
      ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
          .filter((d): d is string => !!d)
          .flatMap((d) => [
            join(d, "Google", "Chrome", "Application", "chrome.exe"),
            join(d, "Microsoft", "Edge", "Application", "msedge.exe"),
            join(d, "Chromium", "Application", "chrome.exe"),
            join(
              d,
              "BraveSoftware",
              "Brave-Browser",
              "Application",
              "brave.exe",
            ),
          ])
      : process.platform === "darwin"
        ? [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
          ].flatMap((app) => [
            join("/Applications", app),
            join(homedir(), "Applications", app),
          ])
        : [];
  // Then the PATH, as Linux installs them (and any OS where the user put one there).
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
    "chrome",
    "msedge",
  ];
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE").split(";").filter(Boolean)
      : [""];
  const onPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) =>
      names.flatMap((n) => exts.map((e) => join(dir, n + e.toLowerCase()))),
    );
  return [...installed, ...onPath].find((c) => existsSync(c));
}

/** Minimal Chrome DevTools Protocol client over the browser's WebSocket. */
async function devtools(url: string) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("Could not connect to the browser."));
  });
  let id = 0;
  const waiting = new Map<number, (r: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  };
  return {
    send(method: string, params = {}) {
      return new Promise<any>((ok, fail) => {
        const n = ++id;
        waiting.set(n, (m) =>
          m.error ? fail(new Error(m.error.message)) : ok(m.result),
        );
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

/**
 * Opens the sign-in window, waits for the user to sign in (up to 15 min), saves the
 * session cookies to `file`, and closes the window at once. Never returns a token.
 * `opened` runs once the window is up.
 */
export async function signIn(
  config: Pick<Config, "baseUrl" | "apiPath" | "requestTimeoutMs">,
  file: string,
  opened: () => void = () => {},
): Promise<SignInResult> {
  const fallback = `save a session from a copied cURL instead: npx -y -p constructor-research-mcp constructor-research-set-token <file with the cURL> --to ${file}`;
  const headless = !!process.env.CONSTRUCTOR_LOGIN_HEADLESS;
  if (
    process.platform === "linux" &&
    !headless &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  )
    return {
      status: "sign_in_failed",
      message: `This machine has no screen to open a sign-in window on (no DISPLAY or WAYLAND_DISPLAY). Sign in where the MCP has a desktop, or ${fallback}.`,
    };
  const exe = findBrowser();
  if (!exe)
    return {
      status: "sign_in_failed",
      message: `No Chrome, Edge, Chromium or Brave found. Set CONSTRUCTOR_BROWSER in the MCP settings to the browser's executable, or ${fallback}.`,
    };
  const host = new URL(config.baseUrl).hostname;
  const profile = await mkdtemp(join(tmpdir(), "constructor-login-"));
  const chrome = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=http://127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      // Tests run the browser without a window.
      ...(headless ? ["--headless=new"] : []),
      "--new-window",
      `${config.baseUrl}/research/`,
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  chrome.on("exit", () => (exited = true));
  chrome.on("error", () => (exited = true));
  const failed = (message: string): SignInResult => ({
    status: "sign_in_failed",
    message,
  });
  try {
    let port: string | undefined, path: string | undefined;
    for (let i = 0; i < 300 && !port && !exited; i++) {
      try {
        [port, path] = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n");
      } catch {
        await delay(100);
      }
    }
    if (!port)
      return failed(`The browser did not start (${exe}); ${fallback}.`);
    const cdp = await devtools(`ws://127.0.0.1:${port}${path}`);
    opened();
    const session = async () => {
      const { cookies } = await cdp.send("Storage.getCookies");
      return new Map<string, string>(
        cookies
          .filter(
            (c: any) =>
              (SESSION_COOKIES as readonly string[]).includes(c.name) &&
              (c.domain.replace(/^\./, "") === host ||
                host.endsWith(
                  c.domain.startsWith(".") ? c.domain : "." + c.domain,
                )),
          )
          .map((c: any) => [c.name, c.value]),
      );
    };
    const deadline = Date.now() + SIGN_IN_MINUTES * 60000;
    let found: Map<string, string> | undefined;
    while (!exited && Date.now() < deadline) {
      const s = await session().catch(() => undefined);
      const exp = claims(s?.get("ap_access_token"))?.exp;
      if (s?.has("ap_refresh_token") && exp && exp * 1000 > Date.now()) {
        // The page may still be loading; read again once it settles, then close at once so
        // the window never renews this session itself.
        await delay(3000);
        found = (await session().catch(() => undefined)) ?? s;
        break;
      }
      await delay(1000);
    }
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    if (!found)
      return failed(
        exited
          ? "The window was closed before sign-in finished; nothing was saved."
          : `No sign-in within ${SIGN_IN_MINUTES} min; nothing was saved.`,
      );
    // Check the access token without sending the refresh token, so nothing is renewed.
    const response = await fetch(
      config.baseUrl + config.apiPath + "/auth/session",
      {
        headers: {
          Cookie: `ap_access_token=${found.get("ap_access_token")}`,
          Accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
    ).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.status === 401)
      return failed("Constructor rejected the new session; nothing was saved.");
    await saveSession(
      file,
      new Map([...found, ...(response ? setCookies(response) : [])]),
      config.baseUrl,
    );
    const end = claims(found.get("ap_access_token"))?.max_slt;
    const until = end
      ? new Date(end * 1000).toISOString().slice(0, 16).replace("T", " ") +
        " UTC"
      : undefined;
    return {
      status: "signed_in",
      message:
        `Signed in to ${config.baseUrl}. Session saved to ${file}` +
        (until ? `; the MCP renews it automatically until ${until}.` : "."),
      session_file: file,
      host: config.baseUrl,
      until,
    };
  } catch (e: any) {
    return failed(`Sign-in failed: ${e?.message ?? e}. Nothing was saved.`);
  } finally {
    if (!exited) {
      chrome.kill();
      for (let i = 0; i < 50 && !exited; i++) await delay(100);
      if (!exited) chrome.kill("SIGKILL"); // TerminateProcess on Windows
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
