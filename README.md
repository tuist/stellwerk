# Stellwerk 🚦

> Self-hostable, pluggable compute orchestrator. Ephemeral CI runners for any git forge.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tuist/stellwerk)

A small Hono-based control plane that watches a git forge for queued CI jobs and spawns short-lived self-hosted runners. Stateless. Webhook-driven. Runs on Cloudflare Workers, Node, Bun, Deno, or in Docker from the same source.

## ✨ Status

v0.1 alpha: GitHub Actions, GitLab CI, and Codeberg Actions on Fly Machines or a self-hosted Docker agent.

## 🚀 Quick Start

```sh
# 1. Install Stellwerk.
git clone https://github.com/tuist/stellwerk.git && cd stellwerk
mise install
aube install

# 2. Deploy the control plane to Cloudflare Workers.
aube run deploy

# 3. Push secrets.
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY     # paste the PEM
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put FLY_API_TOKEN

# 4. Configure the Fly app used for runner machines.
#    Stellwerk creates Machines in this app as queued jobs arrive.
#    The Machines auto-destroy after the runner exits.
#    Set FLY_APP=my-runners in wrangler.toml [vars] or as a secret.

# 5. Create the GitHub App from docs/github-app-manifest.json.
#    Set the webhook URL to https://<your-worker>/webhook/github,
#    set its secret to GITHUB_WEBHOOK_SECRET, and install it on repos.

# 6. Use the runner in a workflow.
#    runs-on: [self-hosted, stellwerk]
```

First job picks up in ~2s.

## 🏃 Runner Behavior

Each queued job with matching labels gets its own runner. With `EXECUTOR=fly`, Stellwerk creates a Fly Machine inside `FLY_APP`; the runner registers, runs one job, exits, and the Machine is destroyed automatically. With `EXECUTOR=docker-agent`, Stellwerk asks the configured agent to start the runner container.

## ⚙️ Configuration

All configuration is environment-driven. On Cloudflare these are `vars` + `secrets`; on Node they're regular env vars.

| Var                       | Required when           | Purpose                                       |
| ------------------------- | ----------------------- | --------------------------------------------- |
| `EXECUTOR`                | always (default `fly`)  | `fly` \| `docker-agent`                       |
| `RUNNER_LABELS`           | optional                | Comma-separated labels every job must include |
| `GITHUB_APP_ID`           | GitHub forge            | App ID                                        |
| `GITHUB_APP_PRIVATE_KEY`  | GitHub forge            | PEM (PKCS#1 or PKCS#8)                        |
| `GITHUB_WEBHOOK_SECRET`   | GitHub forge            | Webhook HMAC secret                           |
| `GITLAB_ACCESS_TOKEN`     | GitLab forge            | Token with `manage_runner` scope              |
| `GITLAB_WEBHOOK_SECRET`   | GitLab forge            | Webhook signing or secret token               |
| `GITLAB_BASE_URL`         | optional                | GitLab instance URL (default `gitlab.com`)    |
| `GITLAB_RUNNER_TAGS`      | optional                | Runner tags (defaults to `RUNNER_LABELS`)     |
| `CODEBERG_ACCESS_TOKEN`   | Codeberg forge          | Token for repo runner registration tokens     |
| `CODEBERG_RUNNER_REGISTRATION_TOKEN` | Codeberg forge | Static runner registration token alternative |
| `CODEBERG_WEBHOOK_SECRET` | Codeberg forge          | Forgejo webhook secret                        |
| `CODEBERG_SERVER_URL`     | optional                | Forgejo server URL (default Codeberg)         |
| `FLY_API_TOKEN`           | `EXECUTOR=fly`          | Fly Machines API token                        |
| `FLY_APP`                 | `EXECUTOR=fly`          | Fly app used for runner machines              |
| `FLY_REGION`              | optional                | Fly region (defaults to app default)          |
| `AGENT_URL`               | `EXECUTOR=docker-agent` | URL of `stellwerk-agent`                      |
| `AGENT_TOKEN`             | `EXECUTOR=docker-agent` | Bearer token for the agent                    |

## 🧭 Running Modes

```sh
# Cloudflare Workers (recommended)
aube run dev:cf
aube run deploy

# Node / VPS
aube run dev:node
# or in production:
node --import tsx/esm src/server.node.ts
```

## 📄 License

MPL-2.0.
