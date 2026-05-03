# GCP Batch executor

Set `EXECUTOR=gcp-batch` to run one GCP Batch container job per queued CI job.

Required:

```sh
GCP_PROJECT=my-project
GCP_LOCATION=us-central1
```

Authentication can use a short-lived access token:

```sh
GCP_ACCESS_TOKEN=...
```

Or a service account key:

```sh
GCP_SERVICE_ACCOUNT_EMAIL=stellwerk@my-project.iam.gserviceaccount.com
GCP_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
```

Optional:

```sh
GCP_BATCH_RUNTIME_SERVICE_ACCOUNT_EMAIL=runner@my-project.iam.gserviceaccount.com
GCP_BATCH_NETWORK=global/networks/default
GCP_BATCH_SUBNETWORK=regions/us-central1/subnetworks/default
GCP_BATCH_NO_EXTERNAL_IP=false
GCP_BATCH_MACHINE_TYPE=e2-standard-4
GCP_BATCH_PROVISIONING_MODEL=SPOT
GCP_BATCH_CPU_MILLI=2000
GCP_BATCH_MEMORY_MIB=4096
GCP_BATCH_BOOT_DISK_MIB=20000
GCP_BATCH_JOB_PREFIX=stellwerk
GCP_BATCH_CACHE_GCS_BUCKET=ci-cache
```

Volume mapping:

- `scratch` creates and mounts a new persistent disk for the job.
- `cache` mounts a GCS FUSE path under `GCP_BATCH_CACHE_GCS_BUCKET`.
- `persistent` mounts an existing persistent disk by `id`, a `gcs://bucket/path`, or an `nfs://server/path`.

Batch works well for normal containerized builds. For privileged Docker workflows, use a VM-native executor or a Kubernetes node pool that allows that workload.
