# Stellwerk 🚦

> Self-hostable, pluggable compute orchestrator. Ephemeral CI runners for any git forge.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tuist/stellwerk)

A small Hono-based control plane that watches a git forge for queued CI jobs and spawns short-lived self-hosted runners. Stateless. Webhook-driven. Runs on Cloudflare Workers, Node, Bun, Deno, or in Docker from the same source.

## ✨ Status

v0.1 alpha: GitHub Actions, GitLab CI, and Codeberg Actions on Fly Machines, a self-hosted Docker agent, Kubernetes, AWS ECS, or GCP Batch.

## 🚀 Deploy to Cloudflare

The fastest path is the Deploy to Cloudflare button above. The default deployment is GitHub Actions on Fly Machines.

Before deploying:

1. Create the Fly app that will hold runner Machines. The default `wrangler.toml` uses `FLY_APP=stellwerk-runners`; change that var if your Fly app uses another name.
2. Create the GitHub App from `docs/github-app-manifest.json`. Set its webhook URL to `https://<your-worker>.<your-subdomain>.workers.dev/webhook/github`, set a random webhook secret, install it on the repos, and generate a private key.
3. Click **Deploy to Cloudflare** and provide the prompted Worker secrets from `.dev.vars.example`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `FLY_API_TOKEN`.

Then use the runner in a workflow:

```yaml
runs-on: [self-hosted, stellwerk]
```

First job picks up in ~2s.

### Manual deploy

```sh
git clone https://github.com/tuist/stellwerk.git && cd stellwerk
mise install
aube install

wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put FLY_API_TOKEN

aube run deploy
```

## 🏃 Runner Behavior

Each queued job with matching labels gets its own runner. With `EXECUTOR=fly`, Stellwerk creates a Fly Machine inside `FLY_APP`; the runner registers, runs one job, exits, and the Machine is destroyed automatically. With `EXECUTOR=docker-agent`, Stellwerk asks the configured agent to start the runner container. With `EXECUTOR=kubernetes`, `EXECUTOR=aws-ecs`, or `EXECUTOR=gcp-batch`, Stellwerk creates one provider-native job/task and lets the provider clean up the compute when the runner exits.

## ⚙️ Configuration

All configuration is environment-driven. On Cloudflare these are `vars` + `secrets`; on Node they're regular env vars.

| Var                       | Required when           | Purpose                                       |
| ------------------------- | ----------------------- | --------------------------------------------- |
| `EXECUTOR`                | always (default `fly`)  | `fly` \| `docker-agent` \| `kubernetes` \| `aws-ecs` \| `gcp-batch` |
| `RUNNER_LABELS`           | optional                | Comma-separated labels every job must include |
| `RUNNER_IMAGE_NAMESPACE`  | optional                | Image namespace for `runner-<forge>:latest`   |
| `RUNNER_VOLUMES`          | optional                | JSON array of scratch/cache/persistent mounts |
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

Executor-specific variables:

- `EXECUTOR=kubernetes`: `K8S_API_SERVER`, `K8S_NAMESPACE`, `K8S_BEARER_TOKEN`; optional `K8S_SERVICE_ACCOUNT`, `K8S_IMAGE_PULL_SECRET`, `K8S_JOB_PREFIX`, `K8S_CACHE_CLAIM_PREFIX`, `K8S_TTL_SECONDS_AFTER_FINISHED`, `K8S_CPU_REQUEST`, `K8S_MEMORY_REQUEST`, `K8S_CPU_LIMIT`, `K8S_MEMORY_LIMIT`.
- `EXECUTOR=aws-ecs`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ECS_CLUSTER`, `AWS_ECS_SUBNETS`, `AWS_ECS_EXECUTION_ROLE_ARN`; optional `AWS_SESSION_TOKEN`, `AWS_ECS_SECURITY_GROUPS`, `AWS_ECS_ASSIGN_PUBLIC_IP`, `AWS_ECS_TASK_ROLE_ARN`, `AWS_ECS_FAMILY_PREFIX`, `AWS_ECS_LAUNCH_TYPE`, `AWS_ECS_PLATFORM_VERSION`, `AWS_ECS_CPU`, `AWS_ECS_MEMORY_MB`, `AWS_ECS_LOG_GROUP`, `AWS_ECS_LOG_STREAM_PREFIX`, `AWS_ECS_EBS_VOLUME_ROLE_ARN`.
- `EXECUTOR=gcp-batch`: `GCP_PROJECT`, `GCP_LOCATION`, plus either `GCP_ACCESS_TOKEN` or `GCP_SERVICE_ACCOUNT_EMAIL` + `GCP_SERVICE_ACCOUNT_PRIVATE_KEY`; optional `GCP_BATCH_RUNTIME_SERVICE_ACCOUNT_EMAIL`, `GCP_BATCH_NETWORK`, `GCP_BATCH_SUBNETWORK`, `GCP_BATCH_NO_EXTERNAL_IP`, `GCP_BATCH_MACHINE_TYPE`, `GCP_BATCH_PROVISIONING_MODEL`, `GCP_BATCH_CPU_MILLI`, `GCP_BATCH_MEMORY_MIB`, `GCP_BATCH_BOOT_DISK_MIB`, `GCP_BATCH_JOB_PREFIX`, `GCP_BATCH_CACHE_GCS_BUCKET`.

## 🧱 Volumes

`RUNNER_VOLUMES` is a JSON array. Volumes are opt-in because shared writable state weakens the default fresh-runner security model.

```json
[
  { "kind": "scratch", "name": "work", "mountPath": "/work", "sizeGb": 20 },
  { "kind": "cache", "name": "npm", "mountPath": "/cache/npm", "key": "npm", "scope": "repo" },
  { "kind": "persistent", "name": "shared", "mountPath": "/mnt/shared", "id": "shared-pvc", "mode": "ro" }
]
```

Provider mapping:

- Fly supports one `persistent` Fly volume per Machine. `cache` is rejected because Fly volumes are host-local and not shared.
- Docker agent receives the volume list unchanged so the agent can map it to local Docker volumes, bind mounts, or NFS.
- Kubernetes maps `scratch` to `emptyDir`, `cache` to a stable PVC name, and `persistent` to an existing PVC.
- AWS ECS registers a task definition per spawn so it can use the right runner image. `scratch` and non-EFS persistent mounts use configured-at-launch EBS volumes; `persistent.id` values beginning with `fs-` map to EFS.
- GCP Batch maps `scratch` to a new persistent disk, `cache` to GCS FUSE using `GCP_BATCH_CACHE_GCS_BUCKET`, and `persistent` to an existing persistent disk, `gcs://...`, or `nfs://server/path`.

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
