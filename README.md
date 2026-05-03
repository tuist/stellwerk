# Stellwerk 🚦

> [!NOTE]
> Self-hostable, pluggable compute orchestrator. Ephemeral CI runners for any git forge today. Sandbox API for AI agents on the roadmap. Deploy to Cloudflare in five minutes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tuist/stellwerk)

A small Hono-based control plane that provisions ephemeral compute on demand. The executor abstraction is workload-agnostic — the same primitive that boots a CI runner can boot a sandbox for an AI agent — so Stellwerk is a general orchestrator with CI as its first shipped use case. Stateless. Webhook-driven. Runs on Cloudflare Workers, Node, Bun, Deno, or in Docker from the same source.

**Today (v0.1):** CI runner orchestrator. Watches a git forge for queued jobs and spawns short-lived self-hosted runners on Fly Machines, a Docker agent, Kubernetes, AWS ECS, or GCP Batch.

**Next:** sandbox API for AI agents, reusing the same forges-and-executors plumbing. See [`SPEC.md`](./SPEC.md) for the full direction.

## 🚀 Deploy to Cloudflare

The fastest path is the **Deploy to Cloudflare** button above. The button reads `wrangler.toml`, which ships with a working default (GitHub forge on Fly Machines) so the deploy flow has something to prompt for. Any forge + executor combination is supported — see [Configuration](#-configuration) for the variables each one needs, and edit `wrangler.toml` (`[vars]` and `[secrets].required`) before clicking the button if you want a different combination.

Before deploying:

1. Provision the compute backend for your chosen executor (Fly app, Docker agent endpoint, Kubernetes namespace, ECS cluster, GCP Batch project, …).
2. Configure your forge (GitHub App, GitLab token, or Codeberg token) and point its webhook at `https://<your-worker>.<your-subdomain>.workers.dev/webhook/<forge>`. For GitHub specifically, you can create the App from `docs/github-app-manifest.json`.
3. Click **Deploy to Cloudflare** and provide the prompted Worker secrets matching the forge + executor variables in `wrangler.toml`.

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

# Push the secrets your forge + executor combination requires.
# Defaults shown below — adjust for GitLab/Codeberg or a non-Fly executor.
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

### Common

| Var                      | Required when          | Purpose                                       |
| ------------------------ | ---------------------- | --------------------------------------------- |
| `EXECUTOR`               | always (default `fly`) | One of the executors below                    |
| `RUNNER_LABELS`          | optional               | Comma-separated labels every job must include |
| `RUNNER_IMAGE_NAMESPACE` | optional               | Image namespace for `runner-<forge>:latest`   |
| `RUNNER_VOLUMES`         | optional               | JSON array of scratch/cache/persistent mounts |

### Forges

Stellwerk enables a forge whenever the variables below are present, so one deployment can serve multiple forges at once.

#### GitHub

| Var                      | Required | Purpose                |
| ------------------------ | -------- | ---------------------- |
| `GITHUB_APP_ID`          | yes      | App ID                 |
| `GITHUB_APP_PRIVATE_KEY` | yes      | PEM (PKCS#1 or PKCS#8) |
| `GITHUB_WEBHOOK_SECRET`  | yes      | Webhook HMAC secret    |

#### GitLab

| Var                     | Required | Purpose                                    |
| ----------------------- | -------- | ------------------------------------------ |
| `GITLAB_ACCESS_TOKEN`   | yes      | Token with `manage_runner` scope           |
| `GITLAB_WEBHOOK_SECRET` | yes      | Webhook signing or secret token            |
| `GITLAB_BASE_URL`       | optional | GitLab instance URL (default `gitlab.com`) |
| `GITLAB_RUNNER_TAGS`    | optional | Runner tags (defaults to `RUNNER_LABELS`)  |

#### Codeberg

`CODEBERG_ACCESS_TOKEN` and `CODEBERG_RUNNER_REGISTRATION_TOKEN` are alternatives — set one or the other.

| Var                                  | Required | Purpose                                      |
| ------------------------------------ | -------- | -------------------------------------------- |
| `CODEBERG_ACCESS_TOKEN`              | one of   | Token for repo runner registration tokens    |
| `CODEBERG_RUNNER_REGISTRATION_TOKEN` | one of   | Static runner registration token alternative |
| `CODEBERG_WEBHOOK_SECRET`            | yes      | Forgejo webhook secret                       |
| `CODEBERG_SERVER_URL`                | optional | Forgejo server URL (default Codeberg)        |

### Executors

Pick one with `EXECUTOR=<name>`. Each executor reads its own variables.

#### `fly` (default)

Environment:

| Var             | Required | Purpose                              |
| --------------- | -------- | ------------------------------------ |
| `FLY_API_TOKEN` | yes      | Fly Machines API token               |
| `FLY_APP`       | yes      | Fly app used for runner machines     |
| `FLY_REGION`    | optional | Fly region (defaults to app default) |

Volumes: one `persistent` Fly volume per Machine. `cache` is rejected because Fly volumes are host-local and not shared.

#### `docker-agent`

Environment:

| Var           | Required | Purpose                    |
| ------------- | -------- | -------------------------- |
| `AGENT_URL`   | yes      | URL of `stellwerk-agent`   |
| `AGENT_TOKEN` | yes      | Bearer token for the agent |

Volumes: the volume list is forwarded to the agent unchanged so it can map entries to local Docker volumes, bind mounts, or NFS.

#### `kubernetes`

Environment:

| Var                              | Required | Purpose                                  |
| -------------------------------- | -------- | ---------------------------------------- |
| `K8S_API_SERVER`                 | yes      | API server URL                           |
| `K8S_NAMESPACE`                  | yes      | Namespace for runner Jobs                |
| `K8S_BEARER_TOKEN`               | yes      | Service account token                    |
| `K8S_SERVICE_ACCOUNT`            | optional | Service account assigned to runner pods  |
| `K8S_IMAGE_PULL_SECRET`          | optional | Image pull secret name                   |
| `K8S_JOB_PREFIX`                 | optional | Prefix for created Job names             |
| `K8S_CACHE_CLAIM_PREFIX`         | optional | Prefix for cache PVCs                    |
| `K8S_TTL_SECONDS_AFTER_FINISHED` | optional | TTL applied to finished Jobs             |
| `K8S_CPU_REQUEST`                | optional | CPU request for runner container         |
| `K8S_MEMORY_REQUEST`             | optional | Memory request for runner container      |
| `K8S_CPU_LIMIT`                  | optional | CPU limit for runner container           |
| `K8S_MEMORY_LIMIT`               | optional | Memory limit for runner container        |

Volumes: `scratch` → `emptyDir`, `cache` → a stable PVC name (using `K8S_CACHE_CLAIM_PREFIX`), `persistent` → an existing PVC referenced by `id`.

#### `aws-ecs`

Environment:

| Var                           | Required | Purpose                                 |
| ----------------------------- | -------- | --------------------------------------- |
| `AWS_REGION`                  | yes      | AWS region                              |
| `AWS_ACCESS_KEY_ID`           | yes      | Access key                              |
| `AWS_SECRET_ACCESS_KEY`       | yes      | Secret key                              |
| `AWS_ECS_CLUSTER`             | yes      | ECS cluster name                        |
| `AWS_ECS_SUBNETS`             | yes      | Subnets for tasks                       |
| `AWS_ECS_EXECUTION_ROLE_ARN`  | yes      | Task execution role ARN                 |
| `AWS_SESSION_TOKEN`           | optional | Session token for temporary credentials |
| `AWS_ECS_SECURITY_GROUPS`     | optional | Security groups for tasks               |
| `AWS_ECS_ASSIGN_PUBLIC_IP`    | optional | Assign a public IP to tasks             |
| `AWS_ECS_TASK_ROLE_ARN`       | optional | Task role ARN                           |
| `AWS_ECS_FAMILY_PREFIX`       | optional | Prefix for task definition family names |
| `AWS_ECS_LAUNCH_TYPE`         | optional | `FARGATE` or `EC2`                      |
| `AWS_ECS_PLATFORM_VERSION`    | optional | Fargate platform version                |
| `AWS_ECS_CPU`                 | optional | Task CPU units                          |
| `AWS_ECS_MEMORY_MB`           | optional | Task memory in MB                       |
| `AWS_ECS_LOG_GROUP`           | optional | CloudWatch log group                    |
| `AWS_ECS_LOG_STREAM_PREFIX`   | optional | Log stream prefix                       |
| `AWS_ECS_EBS_VOLUME_ROLE_ARN` | optional | Role ARN for EBS volume management      |

Volumes: a task definition is registered per spawn so it can use the right runner image. `scratch` and non-EFS `persistent` mounts use configured-at-launch EBS volumes; `persistent.id` values beginning with `fs-` map to EFS.

#### `gcp-batch`

`GCP_PROJECT` and `GCP_LOCATION` are always required. Authenticate with either `GCP_ACCESS_TOKEN`, or `GCP_SERVICE_ACCOUNT_EMAIL` + `GCP_SERVICE_ACCOUNT_PRIVATE_KEY`.

Environment:

| Var                                       | Required | Purpose                                      |
| ----------------------------------------- | -------- | -------------------------------------------- |
| `GCP_PROJECT`                             | yes      | GCP project ID                               |
| `GCP_LOCATION`                            | yes      | Batch location/region                        |
| `GCP_ACCESS_TOKEN`                        | one of   | OAuth access token                           |
| `GCP_SERVICE_ACCOUNT_EMAIL`               | one of   | Service account email (with private key)     |
| `GCP_SERVICE_ACCOUNT_PRIVATE_KEY`         | one of   | Service account private key (with email)     |
| `GCP_BATCH_RUNTIME_SERVICE_ACCOUNT_EMAIL` | optional | Service account assigned to runner VMs       |
| `GCP_BATCH_NETWORK`                       | optional | VPC network                                  |
| `GCP_BATCH_SUBNETWORK`                    | optional | Subnetwork                                   |
| `GCP_BATCH_NO_EXTERNAL_IP`                | optional | Disable external IP on runner VMs            |
| `GCP_BATCH_MACHINE_TYPE`                  | optional | Compute machine type                         |
| `GCP_BATCH_PROVISIONING_MODEL`            | optional | `STANDARD` or `SPOT`                         |
| `GCP_BATCH_CPU_MILLI`                     | optional | CPU in milliCPU                              |
| `GCP_BATCH_MEMORY_MIB`                    | optional | Memory in MiB                                |
| `GCP_BATCH_BOOT_DISK_MIB`                 | optional | Boot disk size in MiB                        |
| `GCP_BATCH_JOB_PREFIX`                    | optional | Prefix for created job names                 |
| `GCP_BATCH_CACHE_GCS_BUCKET`              | optional | GCS bucket used for `cache` volumes via FUSE |

Volumes: `scratch` → a new persistent disk, `cache` → GCS FUSE using `GCP_BATCH_CACHE_GCS_BUCKET`, `persistent` → an existing persistent disk, `gcs://...`, or `nfs://server/path`.

## 🧱 Volumes

`RUNNER_VOLUMES` is a JSON array shared across all executors. Volumes are opt-in because shared writable state weakens the default fresh-runner security model. See each executor above for how the kinds are mapped.

```json
[
  { "kind": "scratch", "name": "work", "mountPath": "/work", "sizeGb": 20 },
  { "kind": "cache", "name": "npm", "mountPath": "/cache/npm", "key": "npm", "scope": "repo" },
  { "kind": "persistent", "name": "shared", "mountPath": "/mnt/shared", "id": "shared-pvc", "mode": "ro" }
]
```

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
