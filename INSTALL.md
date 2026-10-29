# Install the Constructor Research MCP

The MCP lets Claude Code, Codex or OpenCode deploy apps to Constructor Research: constructor.app, or your organisation's Constructor, such as learn.constructor.university. It runs on your machine as a local MCP server, installed from npm. Each tool signs in to Constructor once, with its own session.

## What you need

- Node.js 22 or later ([nodejs.org](https://nodejs.org), or `nvm install 22`)
- Chrome, Edge, Chromium or Brave, for signing in
- macOS, Windows or Linux

## 1. Add it to your tool

**Claude Code**: run once:

```sh
claude mcp add --scope user constructor-research -- npx -y constructor-research-mcp@latest
```

On Windows (not WSL), use this instead:

```bat
claude mcp add --scope user constructor-research -- cmd /c npx -y constructor-research-mcp@latest
```

**Codex**: run once:

```sh
codex mcp add constructor-research -- npx -y constructor-research-mcp@latest
```

The first start downloads the package and can exceed Codex's 10-second start limit. If Codex reports a timeout, restart it once, or add `startup_timeout_sec = 60` under `[mcp_servers.constructor-research]` in `~/.codex/config.toml`. The full entry, if you prefer to write it by hand:

```toml
[mcp_servers.constructor-research]
command = "npx"
args = ["-y", "constructor-research-mcp@latest"]
startup_timeout_sec = 60
tool_timeout_sec = 30
```

**OpenCode**: run once; it adds the entry to your OpenCode config and keeps what is already there. Check your version with `opencode --version`. OpenCode 2.x:

```sh
opencode mcp add --global constructor-research -- npx -y constructor-research-mcp@latest
```

Without `--global`, OpenCode 2.x adds it to the current folder's project config instead. OpenCode 1.x has no `--global` and writes to your user config when run outside a project:

```sh
opencode mcp add constructor-research -- npx -y constructor-research-mcp@latest
```

Or add it by hand to `~/.config/opencode/opencode.json` (or a project's `opencode.json`). This is the 1.x layout; in 2.x the entry goes one level deeper, under `mcp.servers`, as in [examples/opencode-v2.json](examples/opencode-v2.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "constructor-research": {
      "type": "local",
      "command": ["npx", "-y", "constructor-research-mcp@latest"]
    }
  }
}
```

Do not put a token or cookie file in these settings; sign-in is handled by the MCP.

## 2. Restart and sign in

1. Restart the tool, or run `/mcp` in Claude Code, so it starts the MCP. The first start downloads it and can take a minute.
2. Ask the agent to sign in. If your Constructor is not constructor.app, give its address, for example "sign in to Constructor at https://learn.constructor.university". A desk link from it works too.
3. The agent says a sign-in window will open and calls `sign_in`. A separate browser window opens at your Constructor's sign-in page.
4. Sign in. The window closes by itself.

The MCP then works with the Constructor you signed in to; to switch, ask the agent to sign in to the other one. The session is saved for that tool only, in `~/.config/constructor-research/sessions/<tool>.txt`, and renewed automatically for 14 days. A day before it ends, the agent asks you to sign in again.

## 3. Optional: get told when a deployment finishes

Builds can take many minutes. These add-ons wake the agent when a deployment it started finishes:

- Claude Code: merge [examples/claude-hooks.json](examples/claude-hooks.json) into `~/.claude/settings.json`.
- Codex: copy [examples/codex-hooks.json](examples/codex-hooks.json) to `~/.codex/hooks.json`, then trust it in `/hooks`.
- OpenCode: copy [examples/opencode-plugin.js](examples/opencode-plugin.js) to `~/.config/opencode/plugins/`.

## Update

Restart the tool (or `/mcp` in Claude Code): `@latest` fetches the newest version on start. Your sign-in is kept.

## Troubleshooting

**The tool does not list `constructor-research`.** Check that `npx -v` works in a terminal. If you use nvm, your tool may not see it: put the full path to `npx` in the settings instead of `npx`. To find it on macOS or Linux:

```sh
which npx
```

**`sign_in` says no browser was found.** Set `CONSTRUCTOR_BROWSER` in the MCP settings to the browser's executable.

**No screen (a remote Linux machine).** In the browser on your own machine, open Constructor, then DevTools → Network → right-click a request → Copy as cURL. Save it to a file and run (with `codex` or `opencode` in place of `claude-code` for those tools):

```sh
npx -y -p constructor-research-mcp constructor-research-set-token <file> --for claude-code
```

**Check the MCP on its own.** Run the MCP Inspector, then turn on the server's toggle and open Tools:

```sh
npx @modelcontextprotocol/inspector@2.11.0 -- npx -y constructor-research-mcp@latest
```

## Uninstall

Remove `constructor-research` from your tool's settings. In Claude Code:

```sh
claude mcp remove constructor-research --scope user
```

To remove your data too, delete the sign-in sessions and deployment progress:

```sh
rm -rf ~/.config/constructor-research ~/.local/state/constructor-research-mcp
```

## From source

To work on the MCP itself:

```sh
git clone https://github.com/NRGGIT/constructor-research-mcp.git
cd constructor-research-mcp
npm ci
npm run build
```

Then, still in that folder, register the built copy instead of the npm package (Claude Code shown; `$(pwd)` fills in the folder's path):

```sh
claude mcp add --scope user constructor-research -- node "$(pwd)/dist/server.js"
```

Do not run `dist/server.js` by hand: it waits silently for your tool to connect. `npm test` runs the tests.

See [README.md](README.md) for how the tools work.
