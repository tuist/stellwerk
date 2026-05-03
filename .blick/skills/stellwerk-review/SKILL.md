---
name: stellwerk-review
description: Project-specific PR-review rules for the tuist/stellwerk repository (TypeScript, Hono, Cloudflare Workers + Node). Focuses on the things only this repo knows — runtime portability, Web-Crypto-only policy, the Forge / Executor contracts, the webhook handler invariant, and test isolation.
---

# Stellwerk Review

This skill is intentionally narrow. **Generic TypeScript style, formatting, naming, and import-order hygiene are out of scope** — those belong to the language tooling. Focus on the rules below; they catch real bugs and protect the load-bearing properties of this codebase.

For each finding, cite `path:line` and quote the relevant snippet.

---

## 1. Runtime portability — no `node:*` outside `src/server.node.ts`

The control plane must run on Cloudflare Workers. Workers does not expose Node built-ins (`node:crypto`, `node:fs`, `node:buffer`, etc.). The Node runtime adapter lives in a single file and is the only place a `node:*` import is allowed.

### Flag (Severity: high)

- A `node:*` import (or an unprefixed Node built-in such as `crypto`, `fs`, `buffer`, `os`, `path`) introduced anywhere under `src/` other than `src/server.node.ts`.
- A new dependency in `package.json` whose README/types declare it as Node-only (e.g. `jsonwebtoken`, `@octokit/auth-app`, `node-forge`, `axios` with the http/https adapter, `crypto-js`, `bcrypt`).

### Do not flag

- `node:*` imports inside `src/server.node.ts` itself.
- Dev dependencies used only by tests / build (`tsx`, `vitest`, `@types/node`, `wrangler`).

---

## 2. Web Crypto only — no third-party crypto libs

Stellwerk hand-rolls JWT signing and HMAC verification on `crypto.subtle` so the same source runs on Workers, Node 20+, Bun, and Deno. Replacing those with a library is a regression of the portability contract.

### Flag (Severity: high)

- Any new dependency that wraps a crypto primitive: `jsonwebtoken`, `jose`, `node-jose`, `crypto-js`, `tweetnacl` (etc.) added in a runtime path. (`jose` would in fact run on Workers, but we still don't want to import it — keep the helpers in `src/util/`.)
- Bypassing `verifyHmacSha256Hex` / `signJwtRs256` / `importRsaPrivateKey` and inlining a different HMAC or JWT path.

### Do not flag

- New helpers added under `src/util/` that themselves call `crypto.subtle` directly.

---

## 3. Webhook handler invariant — verify, then parse, then filter, then mint, then spawn

The order in `src/app.ts` is load-bearing. Any new forge route or refactor must preserve it.

### Flag (Severity: critical)

- A new webhook route that calls `parseJobEvent`, hits the forge API, or otherwise inspects the body **before** `verifyWebhook` returns true. Even if the call appears side-effect-free, this leaks parsing oracles to unauthenticated callers.
- A new webhook route that calls `mintRunnerToken` before label filtering. Token minting hits the forge's API; jobs we wouldn't accept must not consume that quota.
- A new webhook route that consumes the request body via `c.req.json()` instead of `c.req.text()`. HMAC verification operates on the exact bytes — JSON re-serialization breaks the signature.

### Do not flag

- The existing `app.ts` handler unchanged by the diff.
- A handler that returns `200 {ignored: true}` for unknown / non-target event kinds. That is the desired response — a non-2xx makes the forge re-deliver.

---

## 4. `Forge` and `Executor` contracts

`Forge` (`src/forge.ts`) and `Executor` (`src/executor.ts`) are the two extension points. New implementations must preserve their shape.

### Flag (Severity: high)

- A new `Forge` implementation missing `kind`, `verifyWebhook`, `parseJobEvent`, or `mintRunnerToken`.
- A new `Executor` implementation missing `spawnRunner` or `destroyRunner`.
- A `parseJobEvent` that returns a `JobEvent` for an action other than `'queued' | 'in_progress' | 'completed'`. Other actions (e.g. GitHub's `'waiting'`) must return `null`; downstream code branches on this set.
- An `Executor.spawnRunner` that doesn't pass `RUNNER_TOKEN`, `RUNNER_REPO_URL`, and `RUNNER_LABELS` into the runner VM's environment. The entrypoint scripts in `runner-images/*/entrypoint.sh` rely on those names.

### Flag (Severity: medium)

- A new forge that doesn't add a corresponding `runner-images/<forge>/` directory. The Fly + docker-agent executors derive the image name from `opts.forge`; an unmatched forge will spawn a non-existent image at runtime.

---

## 5. Configuration — env-namespaced, no globals

Wiring lives in `src/config.ts` and threads through `createApp({...})`. There is no module-level config object by design.

### Flag (Severity: medium)

- A `process.env.X` or `globalThis.env.X` read introduced **outside** `src/config.ts` or `src/server.node.ts`. The Workers env is a function argument, not a global; reading it elsewhere will throw or silently return undefined depending on runtime.
- A new env var that doesn't follow the `<FORGE>_*` or `<EXECUTOR>_*` namespace convention used by `RawEnv`.

---

## 6. Tests must not mutate global state

Vitest parallelizes test files (and within a file). Cross-test coupling produces flakes that are painful to track down.

### Flag (Severity: high)

- A test that mutates `process.env` (assignment or `vi.stubEnv` without an `unstubEnvs` cleanup, then a sibling test that reads from `process.env`).
- A module-level `vi.mock('some-module', ...)` placed in a test file (these leak to every test in the file regardless of order).
- A shared, mutable in-memory fixture imported across multiple test files.
- A new `beforeEach` / `afterEach` that exists _only_ to reset state that the test itself created — the fix is to pass that state as an argument instead.

### Do not flag

- `vi.fn()` mocks scoped to a single `it(...)` block.
- Fixtures defined inside the test file as local `const`s.

---

## 7. Logging — use the injected `log`, not `console`

`AppDeps.log` is injectable so tests can silence output and so future deployments can wire structured logging.

### Flag (Severity: low)

- A new `console.log` / `console.error` call inside `src/app.ts` or any forge / executor that has access to a logger. Use the injected `log(msg, fields)` instead.

### Do not flag

- `console.log` inside the Node entry (`src/server.node.ts`) for boot diagnostics.
- `console.log` inside tests for debugging (review, but not a finding).

---

## 8. Don't edit `SPEC.md` casually

`SPEC.md` is the source of truth for architectural decisions. Drive-by edits that change scope, goals/non-goals, or interfaces should land in their own PR with rationale.

### Flag (Severity: medium)

- A diff that modifies `SPEC.md` alongside an unrelated implementation change. Suggest splitting the edit into its own PR.
- A `SPEC.md` change to `§5` (interfaces) without a matching change to `src/forge.ts` or `src/executor.ts` (or vice versa). The two must move together.

---

## Out of scope (handled elsewhere — do not flag)

- Import ordering, line length, semicolons, trailing commas — formatter concerns.
- TS strict-mode complaints — `tsc --noEmit` runs in CI.
- Generic naming bikeshedding (`opts` vs `options`, `id` vs `Id`, etc.).
- Test-file naming (`.test.ts` vs `.spec.ts`) — Vitest accepts the configured pattern.

## Before submitting findings

For each finding, confirm:

1. The `path:line` is real and the snippet appears in the diff.
2. The category above is one of 1–8; if it isn't, downgrade to a question (`uncertain: ...`) rather than asserting a finding.
3. The severity is set: **critical** (auth bypass / signature bypass / breaking the webhook invariant), **high** (likely correctness / portability bug), **medium** (compliance / consistency gap), **low** (nice-to-have).
