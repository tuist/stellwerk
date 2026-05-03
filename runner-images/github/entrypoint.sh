#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"

LABELS="${RUNNER_LABELS:-self-hosted,stellwerk}"
NAME="stellwerk-${RUNNER_JOB_ID:-$(hostname)}-$$"

cd "${RUNNER_HOME:-/runner}"

./config.sh \
    --unattended \
    --ephemeral \
    --disableupdate \
    --replace \
    --url "${RUNNER_REPO_URL}" \
    --token "${RUNNER_TOKEN}" \
    --labels "${LABELS}" \
    --name "${NAME}"

exec ./run.sh
