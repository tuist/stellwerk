FROM ubuntu:24.04

ARG RUNNER_VERSION=2.321.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_ALLOW_RUNASROOT=1 \
    RUNNER_HOME=/runner

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git jq sudo unzip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 -s /bin/bash runner \
    && mkdir -p ${RUNNER_HOME} \
    && chown -R runner:runner ${RUNNER_HOME}

USER runner
WORKDIR ${RUNNER_HOME}

RUN ARCH="$([ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo x64)" \
    && curl -fsSL -o actions-runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz" \
    && tar xzf actions-runner.tar.gz \
    && rm actions-runner.tar.gz

USER root
RUN ./bin/installdependencies.sh
USER runner

COPY --chown=runner:runner entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
