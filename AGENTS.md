# AGENTS.md

Guidance for AI agents working in this repository.

The full architectural picture is in [`SPEC.md`](./SPEC.md). Read it first when in doubt.

## What this is

Stellwerk is a small, runtime-agnostic control plane (Hono) that orchestrates ephemeral CI runners across pluggable git forges (`Forge`) and pluggable compute backends (`Executor`). v0.1 ships GitHub on Fly Machines or a Docker agent. The same source must run on Cloudflare Workers, Node, Bun, and Deno.

## Repository map

- `src/` — control plane source.
  - `app.ts` — Hono app factory (`createApp(deps)`); injectable for tests.
  - `config.ts` — env → `AppDeps` wiring.
  - `index.ts` — Cloudflare Workers entry.
  - `server.node.ts` — Node entry (`@hono/node-server`).
  - `forge.ts` / `executor.ts` — public interfaces.
  - `forges/` — forge implementations (one file per forge).
  - `executors/` — compute backends.
  - `util/` — base64url, hex, HMAC verify, RS256 JWT — Web-Crypto only.
- `runner-images/` — per-forge Docker images for the runner VM.
- `test/` — vitest tests. Test files are colocated by concern, not by source path.
- `docs/` — setup docs and the GitHub App manifest.

## Code style

- Default to no comments. Add one only when the _why_ is non-obvious; never explain _what_.
- TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`. Imports use the `.ts` extension (`allowImportingTsExtensions`).
- Prefer narrow, dependency-injected interfaces over module-level singletons. The Hono app and forges/executors are constructed from explicit deps so tests can mock them.
- No `node:*` imports outside `src/server.node.ts`. The Workers entry must remain portable.
- No `jsonwebtoken`, `@octokit/*`, or any other crypto library. Use `crypto.subtle` and the helpers in `src/util/`. This is what keeps the Workers deployment story working.
- Errors at system boundaries (forge/executor calls) should bubble up; the Hono layer turns them into `502` JSON responses with structured logs. Don't swallow.

## Toolchain

- Tools (Node, aube) are pinned in `mise.toml`. Run `mise install` once, then everything is on `PATH`.
- Node deps are managed with [aube](https://aube.en.dev) — use `aube ci` (CI), `aube install`, `aube add <pkg>`, `aube run <script>`. Do not invoke `npm` / `pnpm` / `yarn` directly. The lockfile is `aube-lock.yaml`.
- Common scripts: `aube run typecheck`, `aube run test`, `aube run format`, `aube run format:check`.

## Testing

- Use **Vitest** (`aube run test`).
- **Tests must not mutate global state.** No process-level env mutation, no module-level mocks that leak across files, no shared in-memory singletons. The vitest runner parallelizes test files (and may parallelize within a file); any cross-test coupling produces flakes that are painful to track down. Pass dependencies into `createApp({ forges, executor, ... })` and into forge/executor constructors instead.
- For HTTP code, mock the forge and executor using plain object literals (see `test/app.test.ts`). Don't spin up real servers or hit real GitHub.
- For crypto, use `crypto.subtle.generateKey` to make a test key inside the test rather than committing fixtures.
- Don't add `beforeEach` / `afterEach` cleanup hooks for state that shouldn't have existed in the first place — fix the test instead.

## Webhook handler invariants

These are the rules `src/app.ts` enforces; preserve them when adding a new forge:

1. Read the raw body **before** any other processing — signature verification operates on the exact bytes the forge sent.
2. Verify the signature _first_. Reject with `401` on failure.
3. Parse the event _after_ verifying. A failed parse returns `200 {ignored: true}` (some forges send pings / unsupported event kinds; replying with anything other than 2xx makes them re-deliver).
4. Filter by required labels before minting a token. Token-minting calls the forge API, so we don't want to do it for jobs we wouldn't accept.
5. Mint the runner registration token, then call the executor. Both can fail; both produce structured log lines and `502`.

## Adding a forge

1. Add `src/forges/<name>.ts` exporting a class that `implements Forge`.
2. Wire it into `src/config.ts` behind its own env vars (`<NAME>_*` namespace).
3. Add a runner image at `runner-images/<name>/`.
4. Add tests under `test/<name>-forge.test.ts`.
5. Document the per-forge setup at `docs/setup/<name>.md`.

## Adding an executor

1. Add `src/executors/<name>.ts` implementing `Executor`.
2. Wire it into `src/config.ts` under a new `EXECUTOR=<name>` value.
3. The runner image to use is derived from `opts.forge` — keep that contract.

## Commits and PRs

Conventional commits. Suggested scopes:

- `forge` — changes to the `Forge` interface or any forge implementation.
- `executor` — changes to `Executor` or any executor implementation.
- `app` — changes to the Hono app / routing / config.
- `runner` — changes to runner images.
- `docs` — README, SPEC, setup docs.
- `ci` — workflows, blick.

Examples:

- `feat(forge): add GitlabForge`
- `feat(executor): add HetznerCloudExecutor`
- `fix(app): verify signature before parsing body`

## Things not to do

- Don't add Node-specific deps to packages used by the Workers entry.
- Don't introduce a process-level config singleton; keep wiring explicit.
- Don't write CHANGELOG entries by hand (we will adopt an automated tool).
- Don't bypass `verifyWebhook` "just for local dev" — use a real webhook secret.
