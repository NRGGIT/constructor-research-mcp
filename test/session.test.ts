import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { platform, jwt, P, D } from "./platform.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlatformApi } from "../src/api.js";
import { findBrowser } from "../src/signin.js";
import { saveSession, sessionHost } from "../src/session.js";

// A refresh token works once (seen live, 29 Oct 2026): the MCP must
// save every renewal at once and never renew the same token twice.

test("a token running low is renewed with the refresh token and saved; requests carry only the access token", async () => {
  const f = await platform();
  try {
    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(5)}; ap_refresh_token=refresh-0\nBASE_URL=x\n`,
    );
    await f.api.request("GET", "/auth/session");
    assert.equal(f.db.renewals, 1);
    const saved = await readFile(f.config.cookieFile, "utf8");
    assert.match(
      saved,
      /^ap_access_token=ey[^;]+; ap_id_token=id-1; ap_refresh_token=refresh-1\nBASE_URL=x\n$/,
    );
    assert.equal((await stat(f.config.cookieFile)).mode & 0o777, 0o600);
    assert.equal(f.db.cookies.at(-2), "ap_refresh_token=refresh-0");
    assert.match(f.db.cookies.at(-1), /^ap_access_token=[^;]+$/);
    // Fresh for another hour: no renewal.
    await f.api.request("GET", "/auth/session");
    assert.equal(f.db.renewals, 1);
    const left = await f.api.authLeft();
    assert.equal(left?.renewable, true);
    assert.ok(left!.minutes > 13 * 24 * 60);
  } finally {
    await f.close();
  }
});

test("processes sharing the cookie file renew once", async () => {
  const f = await platform();
  try {
    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(-5)}; ap_refresh_token=refresh-0`,
    );
    const other = new PlatformApi(f.config);
    await Promise.all([
      f.api.request("GET", "/auth/session"),
      f.api.request("GET", "/auth/session"),
      other.request("GET", "/auth/session"),
      other.request("GET", "/auth/session"),
    ]);
    assert.equal(f.db.renewals, 1);
  } finally {
    await f.close();
  }
});

test("a spent refresh token is dropped; with an expired token the user is asked to sign in", async () => {
  const f = await platform();
  try {
    f.db.refresh = "used-by-the-browser";
    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(5)}; ap_refresh_token=refresh-0`,
    );
    // Still valid: the call goes through and the file falls back to a plain token.
    await f.api.request("GET", "/auth/session");
    assert.doesNotMatch(
      await readFile(f.config.cookieFile, "utf8"),
      /ap_refresh_token/,
    );
    assert.equal((await f.api.authLeft())?.renewable, false);

    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(-1)}; ap_refresh_token=refresh-0`,
    );
    await assert.rejects(
      f.api.request("GET", "/auth/session"),
      (e: any) =>
        e.code === "needs_auth" &&
        /can no longer be renewed.*call the sign_in tool/.test(e.message),
    );
    assert.equal(f.db.renewals, 0);
  } finally {
    await f.close();
  }
});

test("a session from another environment is never sent", async () => {
  const f = await platform();
  try {
    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(60, { iss: "https://constructor.app/idp" })}; ap_refresh_token=refresh-0`,
    );
    const before = f.db.requests.length;
    await assert.rejects(
      f.api.request("GET", "/auth/session"),
      (e: any) =>
        e.code === "needs_auth" &&
        e.message.includes(
          `holds a session for https://constructor.app, but this MCP works with ${f.config.baseUrl}`,
        ),
    );
    assert.equal(f.db.requests.length, before);
    // Its own environment's session goes through.
    await writeFile(
      f.config.cookieFile,
      `ap_access_token=${jwt(60, { iss: f.config.baseUrl + "/idp" })}`,
    );
    await f.api.request("GET", "/auth/session");
  } finally {
    await f.close();
  }
});

const chrome = findBrowser();

test(
  "the login command saves the session from a separate browser and never prints it",
  { skip: !chrome && "no Chrome" },
  async () => {
    const access = jwt(60, { max_slt: Math.floor(Date.now() / 1000) + 86400 });
    const sessionCookies: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/research/") {
        // Signing in ends on a page that sets the session cookies.
        res.setHeader("set-cookie", [
          `ap_access_token=${access}; Path=/; HttpOnly`,
          "ap_id_token=id-token; Path=/; HttpOnly",
          "ap_refresh_token=refresh-token; Path=/; HttpOnly",
        ]);
        res.end("<h1>Constructor</h1>");
      } else if (req.url === "/api/platform-account/auth/session") {
        sessionCookies.push(req.headers.cookie ?? "");
        res.setHeader("content-type", "application/json");
        res.end("{}");
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const dir = await mkdtemp(join(tmpdir(), "constructor-login-test-"));
    const file = join(dir, "login-cookie");
    await writeFile(file, "BASE_URL=x\n");
    try {
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "../dist/login.js"), "--to", file],
        {
          env: {
            PATH: process.env.PATH!,
            CONSTRUCTOR_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}`,
            CONSTRUCTOR_BROWSER: chrome,
            CONSTRUCTOR_LOGIN_HEADLESS: "1",
          },
        },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const code = await new Promise((r) => child.on("exit", r));
      assert.equal(code, 0, out);
      assert.match(
        out,
        /Signed in to http:\/\/127\.0\.0\.1:\d+\. Session saved to .*renews it automatically until/,
      );
      assert.ok(!out.includes(access) && !out.includes("refresh-token"));
      assert.equal(
        await readFile(file, "utf8"),
        `ap_access_token=${access}; ap_id_token=id-token; ap_refresh_token=refresh-token\nhost=http://127.0.0.1:${(server.address() as any).port}\nBASE_URL=x\n`,
      );
      // The check after sign-in sends no refresh token, so nothing is renewed.
      assert.deepEqual(sessionCookies, [`ap_access_token=${access}`]);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

/** The MCP as a harness starts it: no cookie file configured, so the session is per harness. */
async function harness(f: any, home: string, name: string, fixed = true) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "../dist/server.js")],
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      ...(fixed ? { CONSTRUCTOR_BASE_URL: f.config.baseUrl } : {}),
      CONSTRUCTOR_STATE_DIR: f.config.stateDir,
      CONSTRUCTOR_BROWSER: chrome ?? "/nonexistent",
      CONSTRUCTOR_LOGIN_HEADLESS: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test(
  "each harness signs in through sign_in and keeps its own session",
  { skip: !chrome && "no Chrome" },
  async () => {
    const f = await platform();
    const home = await mkdtemp(join(tmpdir(), "constructor-home-"));
    const codex = await harness(f, home, "codex-mcp-client");
    const claude = await harness(f, home, "claude-code");
    const call = (c: Client, name: string, args: any = {}) =>
      c.callTool({ name, arguments: args }) as Promise<any>;
    const sessions = join(home, ".config/constructor-research/sessions");
    try {
      const before = await call(codex, "list_files", {
        project_id: P,
        desk_id: D,
      });
      assert.equal(before.structuredContent.status, "needs_auth");
      assert.match(before.structuredContent.message, /call the sign_in tool/);
      assert.ok(
        before.structuredContent.message.includes(join(sessions, "codex.txt")),
      );

      let r = await call(codex, "sign_in", { wait_seconds: 0 });
      assert.equal(r.structuredContent.status, "sign_in_pending");
      for (let i = 0; i < 10 && r.structuredContent.status !== "signed_in"; i++)
        r = await call(codex, "sign_in", { wait_seconds: 5 });
      assert.equal(r.structuredContent.status, "signed_in", JSON.stringify(r));
      assert.match(
        r.structuredContent.message,
        /renews it automatically until/,
      );
      assert.ok(!JSON.stringify(r).includes("refresh-0"));
      assert.match(
        await readFile(join(sessions, "codex.txt"), "utf8"),
        /ap_refresh_token=refresh-0/,
      );
      const after = await call(codex, "list_files", {
        project_id: P,
        desk_id: D,
      });
      assert.notEqual(after.structuredContent.status, "needs_auth");
      // Already signed in: no new window.
      const again = await call(codex, "sign_in");
      assert.match(again.structuredContent.message, /Already signed in/);

      // Claude Code has no session of its own yet.
      const other = await call(claude, "list_files", {
        project_id: P,
        desk_id: D,
      });
      assert.equal(other.structuredContent.status, "needs_auth");
      assert.ok(
        other.structuredContent.message.includes(
          join(sessions, "claude-code.txt"),
        ),
      );
    } finally {
      await codex.close();
      await claude.close();
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "the user signs in to any Constructor by link, and the MCP works there afterwards",
  { skip: !chrome && "no Chrome" },
  async () => {
    const f = await platform();
    const home = await mkdtemp(join(tmpdir(), "constructor-home-"));
    // No CONSTRUCTOR_BASE_URL: the host comes from the user's link and the session.
    const codex = await harness(f, home, "codex-mcp-client", false);
    const call = (c: Client, name: string, args: any = {}) =>
      c.callTool({ name, arguments: args }) as Promise<any>;
    const desk_url = `${f.config.baseUrl}/research/projects/${P}/desks/${D}`;
    const file = join(home, ".config/constructor-research/sessions/codex.txt");
    try {
      // Not signed in: the desk link says where sign_in opens.
      const before = await call(codex, "list_files", { desk_url });
      assert.equal(before.structuredContent.status, "needs_auth");
      let r = await call(codex, "sign_in", { wait_seconds: 0 });
      assert.match(r.structuredContent.message, new RegExp(f.config.baseUrl));
      for (let i = 0; i < 10 && r.structuredContent.status !== "signed_in"; i++)
        r = await call(codex, "sign_in", { wait_seconds: 5 });
      assert.equal(r.structuredContent.status, "signed_in", JSON.stringify(r));
      assert.equal(r.structuredContent.host, f.config.baseUrl);
      assert.match(
        await readFile(file, "utf8"),
        new RegExp(`\\nhost=${f.config.baseUrl}\\n`),
      );
      const after = await call(codex, "list_files", { desk_url });
      assert.notEqual(after.structuredContent.status, "needs_auth");
      assert.notEqual(after.structuredContent.status, "wrong_environment");

      // A link from another Constructor: sign in there with that link.
      const other = await call(codex, "list_files", {
        desk_url: `https://constructor.app/research/projects/${P}/desks/${D}`,
      });
      assert.equal(other.structuredContent.status, "wrong_environment");
      assert.match(
        other.structuredContent.message,
        /call sign_in with url set to this link/,
      );
      // A new MCP process finds the host in the session.
      await codex.close();
      const again = await harness(f, home, "codex-mcp-client", false);
      try {
        const r2 = await call(again, "list_files", { desk_url });
        assert.notEqual(r2.structuredContent.status, "needs_auth");
        assert.notEqual(r2.structuredContent.status, "wrong_environment");
        const bad = await call(again, "sign_in", { url: "http://example.com" });
        assert.equal(bad.structuredContent.status, "invalid_input");
      } finally {
        await again.close();
      }
    } finally {
      await codex.close().catch(() => {});
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("a session names its Constructor: the host line, else the token's issuer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "constructor-host-"));
  const file = join(dir, "session");
  try {
    assert.equal(await sessionHost(file), undefined);
    await writeFile(
      file,
      `ap_access_token=${jwt(60, { iss: "https://learn.constructor.university/idp" })}\n`,
    );
    assert.equal(
      await sessionHost(file),
      "https://learn.constructor.university",
    );
    await saveSession(
      file,
      new Map([
        ["ap_access_token", jwt(60, { iss: "https://idp.example.com" })],
      ]),
      "https://learn.constructor.university",
    );
    assert.match(
      await readFile(file, "utf8"),
      /^ap_access_token=\S+\nhost=https:\/\/learn\.constructor\.university\n$/,
    );
    assert.equal(
      await sessionHost(file),
      "https://learn.constructor.university",
    );
    // Renewal keeps the host line.
    await saveSession(file, new Map([["ap_access_token", "ey.x.y"]]));
    assert.equal(
      await sessionHost(file),
      "https://learn.constructor.university",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
