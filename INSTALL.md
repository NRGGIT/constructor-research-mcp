# Install the Constructor Research MCP

The MCP lets Claude Code, Codex or OpenCode deploy apps to Constructor Research: constructor.app, or your organisation's Constructor, such as acme.constructor.app. It runs on your machine as a local MCP server, installed from npm, and works with your personal Constructor access key.

## What you need

- Node.js 22 or later ([nodejs.org](https://nodejs.org), or `nvm install 22`)
- a personal access key (`rk-…`) for your Constructor
- macOS, Windows or Linux

## 1. Add it to your tool

**Claude Code**: run once:

```sh
claude mcp add --scope user constructor-research -- npx -y constructor-research-mcp@beta
```

On Windows (not WSL), use this instead:

```bat
claude mcp add --scope user constructor-research -- cmd /c npx -y constructor-research-mcp@beta
```

**Codex**: run once:

```sh
codex mcp add constructor-research -- npx -y constructor-research-mcp@beta
```

The first start downloads the package and can exceed Codex's 10-second start limit. If Codex reports a timeout, restart it once, or add `startup_timeout_sec = 60` under `[mcp_servers.constructor-research]` in `~/.codex/config.toml`. The full entry, if you prefer to write it by hand:

```toml
[mcp_servers.constructor-research]
command = "npx"
args = ["-y", "constructor-research-mcp@beta"]
startup_timeout_sec = 60
tool_timeout_sec = 30
```

**OpenCode**: run once; it adds the entry to your OpenCode config and keeps what is already there. Check your version with `opencode --version`. OpenCode 2.x:

```sh
opencode mcp add --global constructor-research -- npx -y constructor-research-mcp@beta
```

Without `--global`, OpenCode 2.x adds it to the current folder's project config instead. OpenCode 1.x has no `--global` and writes to your user config when run outside a project:

```sh
opencode mcp add constructor-research -- npx -y constructor-research-mcp@beta
```

Or add it by hand to `~/.config/opencode/opencode.json` (or a project's `opencode.json`). This is the 1.x layout; in 2.x the entry goes one level deeper, under `mcp.servers`, as in [examples/opencode-v2.json](examples/opencode-v2.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "constructor-research": {
      "type": "local",
      "command": ["npx", "-y", "constructor-research-mcp@beta"]
    }
  }
}
```

Do not put the key in these settings unless you have to; the next step saves it where every tool finds it.

## 2. Save your access key

In a terminal, run this with your Constructor's address and paste the key when asked (it is not shown):

```sh
npx -y -p constructor-research-mcp@beta constructor-research-set-key https://acme.constructor.app
```

It checks the key with Constructor and saves it, with that address, to `~/.config/constructor-research/access-key.json` (readable only by you). Claude Code, Codex and OpenCode all use this one key, and the MCP works with that Constructor. To switch Constructor or replace a revoked key, run it again. Never paste the key into the chat.

Then restart the tool, or run `/mcp` in Claude Code, so it starts the MCP. The first start downloads it and can take a minute.

## 3. Optional: get told when a deployment finishes

Builds can take many minutes. These add-ons wake the agent when a deployment it started finishes:

- Claude Code: merge [examples/claude-hooks.json](examples/claude-hooks.json) into `~/.claude/settings.json`.
- Codex: copy [examples/codex-hooks.json](examples/codex-hooks.json) to `~/.codex/hooks.json`, then trust it in `/hooks`.
- OpenCode: copy [examples/opencode-plugin.js](examples/opencode-plugin.js) to `~/.config/opencode/plugins/`.

## Update

Restart the tool (or `/mcp` in Claude Code): `@beta` fetches the newest beta on start. Your key is kept.

## Troubleshooting

**The tool does not list `constructor-research`.** Check that `npx -v` works in a terminal. If you use nvm, your tool may not see it: put the full path to `npx` in the settings instead of `npx`. To find it on macOS or Linux:

```sh
which npx
```

**A tool returns `needs_key`.** No key is saved, or Constructor rejected it (revoked or expired). Save a new one with the command in step 2.

**`set-key` says the address answered an HTTP error.** That Constructor may not have the public API yet, or you are off the VPN it needs.

**Check the MCP on its own.** Run the MCP Inspector, then turn on the server's toggle and open Tools:

```sh
npx @modelcontextprotocol/inspector@2.11.0 -- npx -y constructor-research-mcp@beta
```

## Uninstall

Remove `constructor-research` from your tool's settings. In Claude Code:

```sh
claude mcp remove constructor-research --scope user
```

To remove your data too, delete the saved key and deployment progress:

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
