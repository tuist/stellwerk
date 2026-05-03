#!/usr/bin/env sh
set -eu

: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"

FORGEJO_URL="${RUNNER_FORGE_URL:-$(printf '%s' "${RUNNER_REPO_URL}" | sed -E 's#^(https?://[^/]+).*#\1#')}"
NAME="stellwerk-${RUNNER_JOB_ID:-$(hostname)}-$$"
DEFAULT_IMAGE="${CODEBERG_DEFAULT_JOB_IMAGE:-docker://node:20-bookworm}"
LABELS="${RUNNER_LABELS:-docker}"

format_labels() {
  printf '%s' "${LABELS}" | tr ',' '\n' | while IFS= read -r label; do
    label="$(printf '%s' "${label}" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"
    [ -n "${label}" ] || continue
    case "${label}" in
      *:*) printf '%s\n' "${label}" ;;
      *) printf '%s:%s\n' "${label}" "${DEFAULT_IMAGE}" ;;
    esac
  done | paste -sd, -
}

RUNNER_LABELS_FORMATTED="$(format_labels)"

forgejo-runner register \
  --instance "${FORGEJO_URL}" \
  --labels "${RUNNER_LABELS_FORMATTED}" \
  --name "${NAME}" \
  --token "${RUNNER_TOKEN}" \
  --no-interactive

exec forgejo-runner one-job
