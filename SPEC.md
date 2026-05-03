# Stellwerk

> Self-hostable, pluggable compute orchestrator. Ephemeral CI runners for any git forge today. Sandbox API for AI workflows on the roadmap. Deploy to Cloudflare in five minutes.

## 1. What this is

Stellwerk is a small control plane that provisions ephemeral compute on demand. v0.1 ships as a CI runner orchestrator: it watches a git forge for queued jobs and spawns short-lived self-hosted runners. It is webhook-driven, stateless, and deployable as a single Cloudflare Worker — but the same code also runs on Node, Bun, Deno, or in a Docker container, because the whole thing is built on [Hono](https://hono.dev).

The architecture is structured around a pluggable `Executor` abstraction. Because the executor is workload-agnostic — booting a VM with a runner binary is the same primitive as booting a VM with a sandbox runtime — the same compute primitive will later power a generic sandbox API for AI workflows. See §16 for the post-v1 direction.

Two things are pluggable today:

- **The forge.** GitHub Actions is the v0.1 target. GitLab CI and Gitea Actions are on the roadmap.
- **The compute backend.** Fly Machines for zero-infra, a Docker agent for BYO VPS, more on the roadmap.

The metaphor: a *Stellwerk* is a railway interlocking signal box. It doesn't run the trains — it routes them. And it doesn't care which railway operator owns the train, or whether the train is a CI job or a sandbox request.

## 2. Why this exists

CI providers' hosted runners are convenient but expensive at scale and resource-limited. The alternatives today are:

- **Pay a runner-as-a-service company** (RunsOn, Blacksmith, Ubicloud, Namespace) — fast, but you're back to per-minute fees.
- **Use the official Kubernetes operators** ([actions-runner-controller](https://github.com/actions/actions-runner-controller) for GitHub, GitLab Runner Helm chart, Gitea act_runner Helm chart) — open-source and battle-tested, but each requires a Kubernetes cluster, which is itself a self-hosting burden.
- **Roll your own per-forge** — works, but everyone reinvents the same webhook-handler / token-minter / VM-spawner.

Stellwerk targets the gap: a Kubernetes-free runner orchestrator that ships with five-minute setup and is structured so adding a new forge or a new compute backend is a small change to one file each.

## 3. Goals and non-goals

### Goals

- **Five-minute setup.** Clone, set secrets, deploy, configure webhook on the forge side, done.
- **Zero infra requirement.** With Fly + Cloudflare, the user never SSHes into anything.
- **Forge-agnostic architecture.** New forges plug in via a `Forge` interface (~3 methods).
- **Pluggable executors.** New compute backends plug in via an `Executor` interface (~2 methods).
- **Runtime-agnostic control plane.** Same source runs on Cloudflare Workers, Node, Bun, Deno, Docker. No `node:` imports, no platform-specific crypto.
- **Sub-2-second job pickup** (with warm pool enabled).
- **Ephemeral runners by default.** Each job gets a fresh VM/container; no state leaks; no cleanup logic.

### Non-goals

- **Not a Kubernetes operator.** If users want K8s, they should use the official chart for their forge.
- **Not a multi-tenant SaaS.** Each user deploys their own Stellwerk.
- **Not (yet) a code-execution sandbox.** v0.1–v0.3 is CI-runner only. The generic sandbox API for AI workflows is the v1 direction (§16). It shares executors with the CI runner story but ships as a separate module on the same codebase, with its own SDK and docs.
- **Not a workflow engine.** The forge is the workflow engine. We just provide runners.
- **Not for agent-pull-only forges.** Woodpecker CI and Drone CI use long-lived agents that connect to their server; they don't fit our spawn-on-demand model. Use their native agents directly.

## 4. Architecture

```
Git forge              Stellwerk (Hono)              Executor backend
─────────              ────────────────              ────────────────

job queued    ────►   POST /webhook/:forge
                      │
                      ├─ forge.verifyWebhook()
                      ├─ forge.parseJobEvent()
                      ├─ filter by labels
                      ├─ forge.mintRunnerToken()
                      │
                      └─ executor.spawnRunner({...})  ──►  boot VM/container
                                                            with forge-specific
                                                            runner binary +
                                                            registration token

                                                            runner registers,
                                                            picks up job, runs
                                                            ephemerally, exits,
                                                            VM auto-destroys

job completed ────►   POST /webhook/:forge
                      └─ no-op (ephemeral runners self-deregister)
```

Three moving parts:

1. **Control plane** (this repo). A Hono app exposing a webhook endpoint per forge. Stateless. Deployable as a Cloudflare Worker, a Node process, or a Docker container.
2. **Forge integration.** Either an app the user installs (GitHub Apps), a project/group webhook with an access token (GitLab, Gitea), or similar. This is what gives Stellwerk permission to mint runner tokens.
3. **Runner image(s).** Per-forge Docker images containing the appropriate runner binary, configured to run a single job and exit.

## 5. Components

### 5.1 Control plane (`src/index.ts`)

Hono app. One webhook route per forge: `POST /webhook/github`, `POST /webhook/gitlab`, `POST /webhook/gitea`. Each route resolves the right `Forge` implementation, calls `verifyWebhook()` and `parseJobEvent()`, then on a queued job mints a token and calls the configured executor.

Label filtering: `RUNNER_LABELS` env var is a comma-separated list. Only jobs whose `runs-on` (GitHub/Gitea) or `tags` (GitLab) include all configured labels get a runner. This lets multiple Stellwerk pools serve the same repo with different runner classes (e.g. one pool for `linux-x64-fast`, another for `gpu`).

### 5.2 Forge interface (`src/forge.ts`)

```ts
export interface Forge {
  /** Verify webhook authenticity from headers + raw body. */
  verifyWebhook(secret: string, body: string, headers: Headers): Promise<boolean>

  /** Parse a raw webhook payload into a normalized event, or null to ignore. */
  parseJobEvent(body: string, headers: Headers): JobEvent | null

  /** Mint a single-use, short-TTL runner registration token for the job's scope. */
  mintRunnerToken(scope: JobScope): Promise<string>
}

export interface JobEvent {
  action: 'queued' | 'in_progress' | 'completed'
  jobId: string
  scope: JobScope
  labels: string[]
  repoUrl: string
}

export interface JobScope {
  forge: 'github' | 'gitlab' | 'gitea'
  installationId?: string  // GitHub: app installation ID
  projectId?: string       // GitLab: project ID
  repoFullName?: string    // GitHub/Gitea: "owner/repo"
}
```

The forge translates platform-specific webhooks and auth flows into this normalized shape. Everything downstream of `parseJobEvent` is forge-agnostic.

### 5.3 Forge implementations

#### `GithubForge` — v0.1, ships first
- Webhook event: `workflow_job`.
- Auth: GitHub App. JWT (RS256) → installation access token → runner registration token.
- Runner binary: `actions-runner`, with `--ephemeral` flag.
- Setup: user creates a GitHub App via the [App Manifest one-click flow](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app-from-a-manifest).

#### `GitlabForge` — planned, v0.2
- Webhook event: Job Hook (`object_kind: "build"`).
- Auth: a Project Access Token or Group Access Token. No JWT dance — much simpler than GitHub.
- Runner binary: `gitlab-runner`, configured with `--max-builds 1` (GitLab's equivalent of ephemeral).
- Setup: user creates an access token in GitLab UI, configures the project/group webhook URL.

#### `GiteaForge` — planned, v0.3
- Webhook event: `workflow_job` (Gitea explicitly mirrors GitHub Actions semantics).
- Auth: Personal Access Token (Gitea has no app concept).
- Runner binary: `act_runner`, the Gitea fork of actions-runner.
- Should be the easiest second forge to add — much can be reused from `GithubForge`.

#### `BitbucketForge` — someday, low priority
- Bitbucket has self-hosted runners with their own binary and OAuth flow. Add if requested.

#### Not on roadmap
- **Woodpecker CI / Drone CI** — agent-pull model, no benefit from Stellwerk's spawn-on-demand approach.
- **Forgejo** — code-compatible with Gitea; `GiteaForge` should "just work."

### 5.4 Executor interface (`src/executor.ts`)

```ts
export interface Executor {
  spawnRunner(opts: SpawnOpts): Promise<string>  // returns provider-specific runner ID
  destroyRunner(id: string): Promise<void>
}

export interface SpawnOpts {
  registrationToken: string
  repoUrl: string
  labels: string[]
  jobId: string
  forge: 'github' | 'gitlab' | 'gitea'  // determines which runner image to boot
}
```

The executor receives everything it needs to boot a runner. It does not care about webhooks or token lifecycles. It does need the forge value to pick the right runner image.

### 5.5 Executor backends

#### `FlyExecutor`
- Calls `POST /v1/apps/{app}/machines` on the Fly Machines API.
- `auto_destroy: true` so the VM deletes itself when the runner exits.
- Picks the runner image based on `opts.forge` (resolves to `runner-github`, `runner-gitlab`, or `runner-gitea`).
- Default size: shared-cpu-1x, 2 vCPU, 2 GB RAM. Configurable.
- Cold-start: ~1–3s. Pay-per-second.

#### `DockerAgentExecutor`
- Talks to a small daemon (`stellwerk-agent`) running on the user's VPS or homelab.
- Agent dials OUT to the control plane on a WebSocket, so the user never opens an inbound port.
- Cold-start: <1s (image cached locally).
- v0 may use plain HTTP with bearer auth before introducing WebSockets.

#### Future
- `HetznerCloudExecutor`, `Ec2Executor`, `GceExecutor`, `KubernetesExecutor`. ~30 lines each.

### 5.6 Runner images

One image per forge:

- `ghcr.io/stellwerk/runner-github:latest` — `actions-runner` + ephemeral entrypoint.
- `ghcr.io/stellwerk/runner-gitea:latest` — `act_runner` + single-job entrypoint.
- `ghcr.io/stellwerk/runner-gitlab:latest` — `gitlab-runner` + `--max-builds 1`.

Variants per image: `latest` (Ubuntu, ~1.5 GB), `slim` (Alpine, ~400 MB), `dind` (with Docker-in-Docker; requires privileged mode on Fly).

Each image ships with a small entrypoint script that reads `RUNNER_TOKEN`, `RUNNER_REPO_URL`, and `RUNNER_LABELS` from the environment, registers the runner, runs one job, and exits.

### 5.7 GitHub App (forge-specific setup)

For the v0.1 GitHub forge, the user creates a GitHub App in their org. Required:

- **Permissions:** Repo `Actions: read`, `Administration: write`, `Metadata: read`.
- **Events:** `workflow_job`.
- **Webhook URL:** `https://stellwerk.{user}.workers.dev/webhook/github`.
- **Webhook secret:** Random string, also set as `GITHUB_WEBHOOK_SECRET` in Stellwerk.

We ship a GitHub App Manifest JSON so the user clicks once and the app is created with the right permissions and URLs pre-filled.

Per-forge equivalents (GitLab Project Access Token setup, Gitea PAT setup) will be documented in `docs/setup/{forge}.md` as each forge ships.

## 6. Deployment targets

The portability story rests on two facts: (a) Hono is runtime-agnostic, (b) the control plane only uses standard Web APIs (`fetch`, `crypto.subtle`, `atob`, `btoa`, `TextEncoder`).

### 6.1 Cloudflare Workers (recommended)
```sh
wrangler deploy
```
Free tier handles ~100k webhook deliveries/day. No cold-start latency for the webhook itself.

### 6.2 Node / VPS
```sh
node --import tsx/esm src/server.node.ts
```
Same code, `@hono/node-server` adapter. Useful when running everything on one box.

### 6.3 Docker
```sh
docker run -d -p 8787:8787 --env-file .env ghcr.io/stellwerk/control-plane
```
Wraps the Node entry. Good for homelab / on-prem deployments behind a reverse proxy.

### 6.4 Bun / Deno
Trivial two-line entry files. Ship when someone asks.

## 7. End-user setup flow

For the v0.1 GitHub flavor:

```
1. Click "Install GitHub App" → choose repo/org.
2. Fork stellwerk-template; run: wrangler deploy
3. wrangler secret put GITHUB_APP_PRIVATE_KEY
   wrangler secret put GITHUB_WEBHOOK_SECRET
   wrangler secret put FLY_API_TOKEN
4. fly apps create my-runners
   fly deploy --image ghcr.io/stellwerk/runner-github:latest --no-deploy
5. Add `runs-on: [self-hosted, stellwerk]` to a workflow.

Done. First job picks up in ~2s.
```

GitLab and Gitea flows are analogous (replace step 1 with creating an access token, replace step 5 with the forge's runner-tag/labels syntax).

## 8. Key design decisions and rationale

### 8.1 Why pluggable forges
Most CI runner orchestrators are tied to one forge. Splitting forge-specific logic behind a 3-method interface means: (a) the same compute infrastructure can serve a team using both GitHub and GitLab, (b) adding a forge is a contained change, (c) the rest of the code never has to think about forge specifics. The cost is a layer of indirection — worth it given the goal of broad applicability.

### 8.2 Why pluggable executors
By keeping platform specifics behind a 2-method interface, we get multiple deployment stories without forking the codebase, easy testing (mock executor), and a natural extension point for the community to add backends.

### 8.3 Why Hono
Runs on every JS runtime with one source — lets us offer Cloudflare-first deployment without locking out Node / VPS users. Tiny (~14 KB), fast, well-typed. Healthy ecosystem of adapters.

### 8.4 Why Web Crypto only (no Node-specific deps)
The control plane signs JWTs and verifies HMAC signatures. Both can be done with `crypto.subtle`, available on Workers, Node 20+, Bun, Deno. Using `node:crypto` or `jsonwebtoken` would break Cloudflare deployment. Using `@octokit/auth-app` would too. We accept ~80 lines of hand-written JWT code as the cost of portability.

### 8.5 Why ephemeral runners
- Security: no state leaks between jobs from different workflows.
- Simplicity: no cleanup logic; runner deregisters itself.
- Aligns with how all three target forges' modern runner models work.
- Trade-off: every job pays the runner registration cost (~1s). Mitigated by warm pool (§9).

### 8.6 Why webhook-driven (vs polling)
Webhooks are simpler, lower-latency, and a natural fit for Workers (which are request-driven). Trade-off: webhooks can be lost. We add a periodic reconciliation cron (Cloudflare Cron Trigger) that polls the forge's API for queued jobs without runners — see §11.

### 8.7 Why label-matching
Lets the user run multiple Stellwerk pools in parallel — e.g. one for x86, one for ARM, one for GPU. Different pools can even use different forges or different executors.

## 9. Warm pool design (post-MVP)

Cold-start latency for the Fly executor is ~1–3s. Acceptable, but we can do better.

### Approach
Maintain N idle, pre-registered runners per pool. When a job arrives, the forge routes it to one of them immediately (no waiting for a VM to boot). Stellwerk asynchronously provisions a replacement.

### Implementation sketch
- Store warm pool state in Cloudflare KV (or SQLite in Node mode): `{ poolId: [runnerId, ...] }`.
- On `in_progress` event (a pool member got picked up), spawn a replacement.
- A Cron Trigger every minute reconciles: ensures `len(pool) >= warmCount`, prunes runners idle for >10 min.

### Cost model
Two warm runners on Fly ≈ ~$4/mo. Worth it if the user runs CI dozens of times per day.

This is the highest-leverage post-MVP feature.

## 10. Why Cloudflare Containers / Sandbox SDK is NOT a runner backend

Worth documenting so we don't get asked: Cloudflare Containers idle out after 10 minutes, are request-driven, have constrained Docker-in-Docker, and bill in a way that doesn't fit always-on agents. They're great for ephemeral compute sandboxes (LLM code execution, notebooks) but a poor fit for CI runners across any forge.

Note: Cloudflare Containers / Sandbox SDK is the *closest commercial reference* for §16 (Stellwerk's planned sandbox API). The relationship is "different vendors of the same idea" — Stellwerk's pitch in that space is self-hosted and executor-pluggable rather than Cloudflare-locked.

## 11. MVP scope (v0.1)

Ship-blockers:

- [x] Hono app with `POST /webhook/:forge` (skeleton, currently `/webhook` — needs route refactor).
- [x] Webhook signature verification (HMAC-SHA256).
- [x] GitHub App JWT + installation token + runner registration token (Web Crypto).
- [x] `Executor` interface + `FlyExecutor` + `DockerAgentExecutor` (HTTP variant).
- [x] Runtime adapters for Cloudflare and Node.
- [ ] **`Forge` interface refactor** — split current GitHub-specific code in `src/github.ts` behind the interface; rename to `src/forges/github.ts`.
- [ ] **Runner image** (`stellwerk/runner-github`) with ephemeral entrypoint.
- [ ] **Stellwerk agent daemon** (`stellwerk-agent`) for the docker-agent executor.
- [ ] **Reconciliation cron** — poll GitHub for queued jobs without runners, recover from missed webhooks.
- [ ] **README with five-step setup flow.**
- [ ] **GitHub App manifest** for one-click app creation.
- [ ] Basic structured logging.
- [ ] At least one e2e test against a real GitHub repo.

## 12. Roadmap

In rough priority order:

1. **`Forge` interface refactor** — prerequisite for everything multi-forge.
2. **Warm pool** (§9). Biggest UX win.
3. **`GiteaForge`** — easiest second forge, validates the abstraction.
4. **`GitlabForge`** — broader audience, simpler auth flow than GitHub.
5. **`HetznerCloudExecutor`** — cheapest option for users with steady load.
6. **Web dashboard** at `GET /` — list active runners, recent jobs, errors.
7. **Multi-pool support** — one Stellwerk deployment serving multiple label-pools with different executors and/or different forges.
8. **`KubernetesExecutor`** — for users who do have a cluster.
9. **`Ec2Executor` / `GceExecutor`.**
10. **WebSocket-based agent protocol** (replaces HTTP-polling agent).
11. **Runner image variants** (`slim`, `dind`, language-specific) per forge.
12. **ARM runners, GPU runners.**
13. **`BitbucketForge`** if requested.
14. **Per-repo / per-org rate limiting.**
15. **OpenTelemetry exporter.**

## 13. Repo layout

Current state:

```
stellwerk/
├── src/
│   ├── index.ts          # Hono app, webhook handler
│   ├── executor.ts       # Executor interface + Fly + DockerAgent impls
│   ├── github.ts         # GitHub-specific JWT + token minting (will move to forges/github.ts)
│   └── server.node.ts    # Node runtime adapter
├── wrangler.toml
├── package.json
└── SPEC.md
```

Planned:

```
stellwerk/
├── src/
│   ├── index.ts
│   ├── forge.ts                  # Forge interface + JobEvent / JobScope types
│   ├── forges/
│   │   ├── github.ts
│   │   ├── gitlab.ts             # v0.2
│   │   └── gitea.ts              # v0.3
│   ├── executor.ts
│   ├── executors/
│   │   ├── fly.ts
│   │   ├── docker-agent.ts
│   │   └── hetzner.ts            # later
│   └── server.node.ts
├── runner-images/
│   ├── github/
│   │   ├── Dockerfile
│   │   └── entrypoint.sh
│   ├── gitlab/
│   └── gitea/
├── agent/                        # the docker-agent daemon
│   ├── src/
│   ├── Dockerfile
│   └── README.md
├── examples/
│   ├── fly-setup/
│   └── workflow.yml
├── docs/
│   ├── setup/
│   │   ├── github.md
│   │   ├── gitlab.md
│   │   └── gitea.md
│   ├── github-app-manifest.json
│   └── architecture.md
└── README.md
```

## 14. Open questions

- **Persistence layer.** Pure webhook-driven mode with ephemeral runners needs none. Warm pool + reconciliation needs some — Workers KV on CF, SQLite for Node mode. Decide before warm-pool work.
- **Multi-forge in one deployment.** Should one Stellwerk instance handle webhooks from multiple forges simultaneously? Probably yes (it's stateless), and the per-forge route prefix (`/webhook/:forge`) supports it cleanly. Confirm during the forge refactor.
- **Per-forge config layout.** With multiple forges, environment variable namespacing matters: `GITHUB_APP_PRIVATE_KEY`, `GITLAB_ACCESS_TOKEN`, `GITEA_PAT`. Document the convention.
- **Runner image registry.** Ship our own (`ghcr.io/stellwerk/runner-*`) or document how users build their own? Probably ship our own for the happy path, document custom-image escape hatch.
- **Authentication on the agent endpoint.** Bearer token works for v0. mTLS for v1? Probably overkill for homelab.
- **What happens if a runner registration token is minted but the executor fails to spawn?** Tokens are single-use and short-TTL, so leakage isn't a concern. Should still log loudly and alert.
- **Workflow re-runs and matrix jobs.** Each job event is independent — matrix jobs each trigger their own webhook. Should "just work" but needs e2e testing per forge.
- **Cross-forge label conventions.** GitHub uses `runs-on: [a, b]`, GitLab uses `tags: [a, b]`. Document the mapping.

## 15. Glossary

- **Stellwerk** — German for railway interlocking signal box. The control tower that routes trains.
- **Forge** — A git hosting platform with built-in CI (GitHub, GitLab, Gitea, Bitbucket, Forgejo). Pluggable in Stellwerk via the `Forge` interface.
- **Runner** — A process that executes a CI job. In Stellwerk, always ephemeral and single-use.
- **Sandbox** — An ephemeral, session-based execution environment exposed to callers via the §16 sandbox API. Distinct from a runner: lives for a session, not a single job; driven by API calls, not by a forge.
- **Executor** — A pluggable backend that knows how to spawn ephemeral compute on a particular platform. Forge-agnostic *and* workload-agnostic — same primitive serves CI runners and sandboxes.
- **Dispatcher** — Umbrella term for whatever consumes inbound requests and turns them into spawn calls. Today: `Forge` (CI). Future: `SandboxApi` (§16). Both produce `SpawnOpts` for the executor.
- **Control plane** — The Hono app in this repo. Routes inbound requests through dispatchers to executors.
- **Runner registration token** — A single-use, short-TTL token issued by the forge that lets a runner register itself with a repo/project.
- **Warm pool** — A small set of idle pre-registered runners (or sandboxes) kept alive to reduce job-pickup latency.
- **ARC** — [actions-runner-controller](https://github.com/actions/actions-runner-controller). The Kubernetes-based GitHub-only predecessor that inspired this project.

## 16. Future direction: sandbox API for AI workflows

The `Executor` abstraction is forge-agnostic by design. It is also workload-agnostic — booting a VM with a runner binary is the same primitive as booting a VM with a sandbox runtime. v1 of Stellwerk extends the project to expose a second consumption surface: a REST + streaming API for ephemeral compute sandboxes, useful for AI agents, code-generation tools, notebooks, and any caller that wants to safely execute arbitrary code on demand.

This section captures the direction. **It is not v0.1 scope.** The CI runner story (§1–§15) ships first.

### 16.1 Why this fits

CI runners and AI sandboxes look similar (both are "ephemeral compute on demand") but their interaction patterns differ:

- **CI runner** — fire-and-forget. Webhook arrives, Stellwerk spawns a VM, the runner registers with the forge, the forge feeds it a job, it exits. Stellwerk never talks to the runner again. The forge owns the runner's lifecycle.
- **AI sandbox** — request/response, session-based. A caller wants to `exec("python script.py")` and get stdout back. They want to write files, list processes, maybe stream output, maybe expose a port. The sandbox lives for the duration of a session. Stellwerk owns the sandbox's lifecycle.

Same primitives underneath (boot a VM, run a process, tear it down), different shape on top. Reusing the executor layer captures all of the boot/teardown logic; only the upper layer changes.

### 16.2 Architecture

```
                      ┌─────────────────────────┐
                      │      Executor (Fly,     │
                      │      Docker agent,      │
                      │      Hetzner, ...)      │
                      └────────────┬────────────┘
                                   │ spawn / destroy
                ┌──────────────────┴──────────────────┐
                │                                     │
        ┌───────▼────────┐                  ┌─────────▼────────┐
        │  CI dispatcher │                  │ Sandbox dispatcher│
        │ (Forge: GitHub,│                  │   (REST/SSE API   │
        │  GitLab, Gitea)│                  │   for AI agents)  │
        └────────────────┘                  └──────────────────┘
```

Both modes share the executor. They differ in three ways:

- **Inbound surface.** CI: webhook receiver. Sandbox: REST API + streaming.
- **Lifecycle.** CI: short-lived, single-job, forge-driven. Sandbox: session-based, request/response, caller-driven.
- **Runner image.** CI: forge-specific runner binary. Sandbox: in-VM agent (`stellwerk-sandbox-runtime`) exposing exec / file / process operations.

### 16.3 Sandbox API surface

Modeled on E2B and Cloudflare Sandbox SDK so users porting from either have a familiar shape:

```
POST   /sandboxes                      → create sandbox, returns id and URL
POST   /sandboxes/:id/exec             → run command, returns stdout/stderr/exit
GET    /sandboxes/:id/exec/:execId     → SSE stream for long-running exec
POST   /sandboxes/:id/files            → write file
GET    /sandboxes/:id/files/:path      → read file
GET    /sandboxes/:id/processes        → list running processes
DELETE /sandboxes/:id/processes/:pid   → kill process
DELETE /sandboxes/:id                  → tear down
```

A small TypeScript SDK (`@stellwerk/sandbox`) wraps the API:

```ts
const sandbox = await stellwerk.sandboxes.create({ image: 'python-data' })
const result = await sandbox.exec('python -c "print(2+2)"')
// result.stdout === "4\n"
await sandbox.destroy()
```

### 16.4 In-VM runtime

Each sandbox VM runs a small daemon (`stellwerk-sandbox-runtime`) that:

- Listens on an internal HTTP port (private to the executor's network).
- Exposes exec / file / process operations.
- Authenticates requests via a per-sandbox token issued at creation time.

The control plane proxies API calls from the user to the in-VM daemon. On Fly Machines this uses Fly's private 6PN network. On the docker-agent path the host agent proxies. The daemon should be a single static binary (Go or Rust) so the sandbox image stays small.

### 16.5 What changes in the codebase

Minimal restructuring needed when v1 work begins:

- Promote the dispatcher concept: rename current `Forge` interface usage to fit under a shared `Dispatcher` umbrella, or keep `Forge` and `SandboxApi` as siblings — both produce `SpawnOpts` for the executor. (Decide during v0.4 prep.)
- Add `src/sandbox/` with the REST handlers and lifecycle manager.
- Add `runner-images/sandbox/` with the in-VM runtime image.
- **Persistence becomes mandatory** — sandboxes have meaningful state (which exist, who owns them, when to tear down). Workers KV on Cloudflare; SQLite on Node.
- **Auth becomes mandatory** for the public API surface. The CI side gets auth for free via webhook signatures; the sandbox API needs API keys / OIDC / something.

### 16.6 Packaging

To keep the user-facing pitch sharp per audience, ship as a small monorepo:

- `@stellwerk/runner-control` — the CI runner orchestrator (v0.1–v0.3).
- `@stellwerk/sandbox` — the sandbox API (v1.0+).
- `@stellwerk/executors` — the shared compute primitive (Fly, docker-agent, Hetzner, ...).

Each can be deployed standalone, or together in one Worker.

### 16.7 Two-stage rollout

- **Stage 1 (v0.1–v0.3):** ship the CI runner story exactly as specced in §1–§15. Validate the executor abstraction. Build a user base on a problem with a clear pitch.
- **Stage 2 (v1.0+):** add the sandbox surface as a second module sharing the executor core. Different docs, different SDK, optionally separate deployment.

This sequencing means we don't compromise Stage 1 for an unproven Stage 2, and Stage 2 launches with battle-tested executors.

### 16.8 Competitive landscape (sandbox side)

Worth being clear-eyed about:

- **E2B, Modal, Daytona** — well-funded, mature SDKs, hosted SaaS.
- **Cloudflare Sandbox SDK** — mature, but Cloudflare-locked.
- **Stellwerk's edge in this space:** self-hosted, executor-pluggable, runs the same control plane that already handles your CI. The pitch is *not* "fastest sandbox" or "cheapest sandbox" — it's "the sandbox you can run on your own infra, on the compute backend you already chose."

### 16.9 Open questions for Stage 2

- Snapshotting. Should sandboxes support pause/resume across requests? Useful for AI agents that come back to the same environment minutes later. Hard on Fly (would require Fly Machine `stop`/`start` semantics — possible but adds complexity).
- Filesystem persistence. Per-sandbox volumes vs ephemeral-only? Volumes mean billing complexity.
- Network egress controls. Sandbox users will absolutely want to allow/deny lists for outbound HTTP. Cloudflare Containers has this; we'd need to implement equivalent on each executor.
- Pricing/metering. If anyone runs Stellwerk as an internal service for their team, they may want per-tenant usage data. Out of scope for v1.0; design hooks now.

---

*Last updated: added §16 (sandbox direction). Update this file as decisions are made.*
