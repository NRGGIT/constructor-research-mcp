# Working on this repository

Constructor Research MCP: a local MCP server that lets coding agents deploy whole
applications to Constructor Research through its public API.

- **What the agent sees** (tools, inputs, outputs): `README.md`.
- **How it works inside** (parts, request flow, state, recovery, logs): `docs/how-it-works.md`.
  Read it before changing `src/`.
- **Installing for users:** `INSTALL.md`.

## Layout

- `src/` — TypeScript sources (Node 22+, ES modules). Entry points: `server.ts` (the MCP and
  `install`), `wait.ts` (wait command and hooks), `set-key.ts` (save the key).
- `test/` — `node:test` suites; `test/platform.ts` is the fake Constructor they all use.
- `examples/` — client settings and hook snippets shipped with the package.
- `dist/` — build output (`npm run build`); not edited by hand.

## Commands

```sh
npm ci
npm run check         # tsc --noEmit
npm run format:check  # prettier
npm test              # builds, then runs all tests against the fake Constructor
```

All three must pass before a commit; `npm publish` runs them again (`prepublishOnly`).

## Rules for changes

- **Never handle the access key in the open.** It must not reach tool output, error
  messages, logs, command lines, agent settings or test snapshots. Do not echo Constructor's
  error bodies.
- **Every change to Constructor goes through `DeploymentEngine.mutate`**, so it is written
  down before and after (crash safety). Do not call `api.request` for a mutation inside an
  operation directly.
- **Steps must be idempotent.** `advance` may run again after a crash or from another
  process; check what already exists before creating it.
- **State is shared between processes.** Read and write operations only under
  `store.exclusive`; keep the lock for seconds, not for a whole build.
- **Tool descriptions and messages are product text.** Agents act on them literally. Keep
  them short, concrete, and say what to do next.
- **Test against the fake, extend the fake.** When Constructor behaves in a new way, teach
  `test/platform.ts` that behaviour first, then fix the code; a regression test should fail
  without the fix.
- Update `README.md` (behaviour) and `docs/how-it-works.md` (internals) in the same change.

## Releasing

1. Bump `version` in `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`)
   and add a one-line note at the top of `README.md`.
2. Commit on a branch, merge into `main`, push.
3. Publish: `npm publish` from a machine signed in to npm, or push a tag `vX.Y.Z`, which
   the `publish` GitHub workflow releases (a `-beta` tag goes to the `beta` dist-tag).
4. Check: `npm view constructor-research-mcp dist-tags --prefer-online`.
