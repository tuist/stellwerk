# Kubernetes executor

Set `EXECUTOR=kubernetes` when you already have a cluster and want Stellwerk to create one Kubernetes Job per queued CI job.

Required:

```sh
K8S_API_SERVER=https://...
K8S_NAMESPACE=ci-runners
K8S_BEARER_TOKEN=...
```

Optional:

```sh
K8S_SERVICE_ACCOUNT=stellwerk-runner
K8S_IMAGE_PULL_SECRET=ghcr
K8S_JOB_PREFIX=stellwerk
K8S_CACHE_CLAIM_PREFIX=stellwerk-cache
K8S_TTL_SECONDS_AFTER_FINISHED=600
K8S_CPU_REQUEST=2
K8S_MEMORY_REQUEST=4Gi
K8S_CPU_LIMIT=4
K8S_MEMORY_LIMIT=8Gi
```

The bearer token needs permission to create Secrets and Jobs in the namespace, and to delete those resources if `destroyRunner` is called.

Volume mapping:

- `scratch` becomes `emptyDir`.
- `cache` becomes a PVC named from `K8S_CACHE_CLAIM_PREFIX`, scope, and key.
- `persistent` mounts an existing PVC by `id`.

Use a `ReadWriteMany` storage class when multiple runners need shared writable state. Otherwise use `rw-exclusive` or read-only mounts.
