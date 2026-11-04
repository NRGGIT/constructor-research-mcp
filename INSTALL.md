# Install the Constructor Research MCP

The MCP lets Claude Code, Codex or OpenCode deploy apps to Constructor Research: constructor.app, or your organisation's Constructor, such as acme.constructor.app. It runs on your machine as a local MCP server, installed from npm, and works with your personal Constructor access key.

## What you need

- Node.js 22 or later ([nodejs.org](https://nodejs.org), or `nvm install 22`)
- a personal access key (`rk-…`) for your Constructor
- macOS, Windows or Linux

## 1. Add it to your tool, with your key

The key is required: the MCP does nothing without it. The address is `https://constructor.app`; if your organisation has its own Constructor, use its address instead (e.g. `https://acme.constructor.app`). Replace `rk-your-key` with your key.

**Claude Code**: run once:

```sh
claude mcp add --scope user constructor-research \
  -e CONSTRUCTOR_BASE_URL=https://constructor.app \
  -e CONSTRUCTOR_ACCESS_KEY=rk-your-key \
  -- npx -y constructor-research-mcp@latest
```

On Windows (not WSL), use this instead:

```bat
claude mcp add --scope user constructor-research -e CONSTRUCTOR_BASE_URL=https://constructor.app -e CONSTRUCTOR_ACCESS_KEY=rk-your-key -- cmd /c npx -y constructor-research-mcp@latest
```

**Codex**: run once:

```sh
codex mcp add constructor-research \
  --env CONSTRUCTOR_BASE_URL=https://constructor.app \
  --env CONSTRUCTOR_ACCESS_KEY=rk-your-key \
  -- npx -y constructor-research-mcp@latest
```

The first start downloads the package and can exceed Codex's 10-second start limit. If Codex reports a timeout, restart it once, or add `startup_timeout_sec = 60` under `[mcp_servers.constructor-research]` in `~/.codex/config.toml`. The full entry, if you prefer to write it by hand:

```toml
[mcp_servers.constructor-research]
command = "npx"
args = ["-y", "constructor-research-mcp@latest"]
startup_timeout_sec = 60
tool_timeout_sec = 30

[mcp_servers.constructor-research.env]
CONSTRUCTOR_BASE_URL = "https://constructor.app"
CONSTRUCTOR_ACCESS_KEY = "rk-your-key"
```

**OpenCode**: add the entry to `~/.config/opencode/opencode.json` (or a project's `opencode.json`), keeping what is already there. Check your version with `opencode --version`. OpenCode 1.x:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "constructor-research": {
      "type": "local",
      "command": ["npx", "-y", "constructor-research-mcp@latest"],
      "environment": {
        "CONSTRUCTOR_BASE_URL": "https://constructor.app",
        "CONSTRUCTOR_ACCESS_KEY": "rk-your-key"
      }
    }
  }
}
```

In 2.x the entry goes one level deeper, under `mcp.servers`, as in [examples/opencode-v2.json](examples/opencode-v2.json), with the same `environment`.

Then restart the tool, or run `/mcp` in Claude Code, so it starts the MCP. The first start downloads it and can take a minute.

## 2. Or keep the key out of the tool's settings

Step 1 stores the key in the tool's settings file (`~/.claude.json`, `~/.codex/config.toml`, `opencode.json`). To avoid that, add the MCP without the two variables (`claude mcp add --scope user constructor-research -- npx -y constructor-research-mcp@latest`, and the same for Codex and OpenCode) and save the key in a terminal; it asks for the key without showing it:

```sh
npx -y -p constructor-research-mcp@latest constructor-research-set-key https://constructor.app
```

It checks the key with Constructor and saves it, with that address, to `~/.config/constructor-research/access-key.json` (readable only by you). Claude Code, Codex, OpenCode and the wait hooks all use this one file, and a new key needs no restart. To switch Constructor or replace a revoked key, run it again. A key set in the tool's settings wins over the file. Never paste the key into the chat.

## 3. Recommended: wait for builds

Builds take minutes, and some agents (Codex in particular) end their turn before a build finishes, so the user has to ask again. The wait hook keeps the agent on it until the deployment ends. One command adds it, leaving your other settings and hooks as they are:

```sh
npx -y -p constructor-research-mcp@latest constructor-research-wait --install codex        # ~/.codex/hooks.json
npx -y -p constructor-research-mcp@latest constructor-research-wait --install claude-code  # ~/.claude/settings.json
```

Restart the tool; in Codex, trust the new hook in `/hooks`. The hook only watches the deployments the MCP runs, so it works with the key in the MCP settings too. By hand: merge [examples/codex-hooks.json](examples/codex-hooks.json) or [examples/claude-hooks.json](examples/claude-hooks.json). OpenCode: copy [examples/opencode-plugin.js](examples/opencode-plugin.js) to `~/.config/opencode/plugins/`.

## Update

Restart the tool (or `/mcp` in Claude Code): `@latest` fetches the newest version on start. Your key is kept.

## Troubleshooting

**The tool does not list `constructor-research`.** Check that `npx -v` works in a terminal. If you use nvm, your tool may not see it: put the full path to `npx` in the settings instead of `npx`. To find it on macOS or Linux:

```sh
which npx
```

**A tool returns `needs_key`.** No key is saved, or Constructor rejected it (revoked or expired). Save a new one with the command in step 2.

**`set-key` says the address answered an HTTP error.** That Constructor may not have the public API yet, or you are off the VPN it needs.

**Check the MCP on its own.** Run the MCP Inspector, then turn on the server's toggle and open Tools:

```sh
npx @modelcontextprotocol/inspector@2.11.0 -- npx -y constructor-research-mcp@latest
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
