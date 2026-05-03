# Codeberg Setup

Codeberg runs Forgejo Actions. Stellwerk listens for Forgejo `workflow_job` webhooks and starts a one-job Forgejo runner.

## Runner token

Use one of these token modes:

- Set `CODEBERG_ACCESS_TOKEN` so Stellwerk can request a repository runner registration token from the Forgejo API.
- Or set `CODEBERG_RUNNER_REGISTRATION_TOKEN` to a static runner registration token copied from the Codeberg Actions runner settings UI.

## Webhook

Create a Forgejo webhook:

- URL: `https://<your-stellwerk-host>/webhook/codeberg`
- Trigger: Workflow job events
- Secret: set the same value in `CODEBERG_WEBHOOK_SECRET`

## Labels

Codeberg workflow job labels come from `runs-on`. The bundled runner image maps each plain label to `docker://node:20-bookworm` by default before calling `forgejo-runner one-job`.

To use another default job image, publish a custom `runner-codeberg` image with `CODEBERG_DEFAULT_JOB_IMAGE` set or override the image in your executor configuration.

For a self-hosted Forgejo instance, set:

```sh
CODEBERG_SERVER_URL=https://forgejo.example.com
CODEBERG_API_BASE_URL=https://forgejo.example.com/api/v1
```
