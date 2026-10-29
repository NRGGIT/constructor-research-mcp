// Wakes the OpenCode agent when a Constructor deployment it started finishes.
// Copy to .opencode/plugins/ or ~/.config/opencode/plugins/.
import { spawn } from "node:child_process";

const WAIT = [
  "-y",
  "-p",
  "constructor-research-mcp",
  "constructor-research-wait",
];
// Any CONSTRUCTOR_* settings your MCP entry sets besides the defaults.
const ENV = {};
const TOOLS =
  /(deploy_app|update_app|build_image|start_app|stop_app|get_deployment)$/;

export const ConstructorDeployWait = async ({ client }) => ({
  "tool.execute.after": async (input, output) => {
    if (!TOOLS.test(input.tool)) return;
    const child = spawn("npx", [...WAIT, "--hook", "opencode"], {
      env: { ...process.env, ...ENV },
      shell: process.platform === "win32", // npx is npx.cmd there
      stdio: ["pipe", "ignore", "pipe"],
    });
    let text = "";
    child.stderr.on("data", (chunk) => (text += chunk));
    child.stdin.end(JSON.stringify({ tool_response: output.output ?? "" }));
    child.on("close", async (code) => {
      // Exit 2 carries the outcome; 0 means nothing was in progress (or another waiter has it).
      if (code !== 2 || !text.trim()) return;
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          parts: [
            {
              type: "text",
              text: `Constructor deployment update:\n${text.trim()}`,
            },
          ],
        },
      });
    });
  },
});
