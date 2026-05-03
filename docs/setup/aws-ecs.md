# AWS ECS executor

Set `EXECUTOR=aws-ecs` to run one ECS task per queued CI job. Stellwerk registers a task definition for the selected runner image, then calls `RunTask`.

Required:

```sh
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_ECS_CLUSTER=ci
AWS_ECS_SUBNETS=subnet-aaa,subnet-bbb
AWS_ECS_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/ecsTaskExecutionRole
```

Optional:

```sh
AWS_SESSION_TOKEN=...
AWS_ECS_SECURITY_GROUPS=sg-aaa,sg-bbb
AWS_ECS_ASSIGN_PUBLIC_IP=true
AWS_ECS_TASK_ROLE_ARN=arn:aws:iam::123456789012:role/runnerTaskRole
AWS_ECS_FAMILY_PREFIX=stellwerk-runner
AWS_ECS_LAUNCH_TYPE=FARGATE
AWS_ECS_PLATFORM_VERSION=LATEST
AWS_ECS_CPU=2048
AWS_ECS_MEMORY_MB=4096
AWS_ECS_LOG_GROUP=/ecs/stellwerk-runners
AWS_ECS_LOG_STREAM_PREFIX=stellwerk
AWS_ECS_EBS_VOLUME_ROLE_ARN=arn:aws:iam::123456789012:role/ecsInfrastructureRole
```

Volume mapping:

- `scratch` uses a configured-at-launch ECS managed EBS volume and is deleted when the task stops.
- `persistent` with an `id` beginning with `fs-` uses EFS.
- Other `persistent` mounts use configured-at-launch EBS and are preserved when the task stops.

For Docker-in-Docker-heavy CI, prefer an EC2-backed ECS cluster over Fargate. Fargate is a good default for ordinary container jobs, but it does not provide privileged containers.
