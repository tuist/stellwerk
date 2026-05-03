#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"

GITLAB_URL="${RUNNER_FORGE_URL:-$(printf '%s' "${RUNNER_REPO_URL}" | sed -E 's#^(https?://[^/]+).*#\1#')}"
NAME="stellwerk-${RUNNER_JOB_ID:-$(hostname)}-$$"
CONFIG="${GITLAB_RUNNER_CONFIG:-/etc/gitlab-runner/config.toml}"
EXECUTOR="${GITLAB_RUNNER_EXECUTOR:-shell}"

mkdir -p "$(dirname "${CONFIG}")" /builds

register_args=(
  --non-interactive
  --url "${GITLAB_URL}"
  --token "${RUNNER_TOKEN}"
  --executor "${EXECUTOR}"
  --name "${NAME}"
  --config "${CONFIG}"
)

if [[ "${EXECUTOR}" == "docker" ]]; then
  register_args+=(--docker-image "${GITLAB_DOCKER_IMAGE:-alpine:latest}")
fi

gitlab-runner register "${register_args[@]}"

set +e
gitlab-runner run \
  --working-directory /builds \
  --config "${CONFIG}" \
  --max-builds "${GITLAB_RUNNER_MAX_BUILDS:-1}" \
  --wait-timeout "${GITLAB_RUNNER_WAIT_TIMEOUT:-600}"
status=$?

gitlab-runner unregister --url "${GITLAB_URL}" --token "${RUNNER_TOKEN}" --config "${CONFIG}" || true
curl -fsS -X DELETE "${GITLAB_URL}/api/v4/runners" --form "token=${RUNNER_TOKEN}" >/dev/null || true

exit "${status}"
