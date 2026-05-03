# GitLab Setup

## GitLab token

Create a project, group, or personal access token that can call the runners API with the `manage_runner` scope. Set it as:

```sh
GITLAB_ACCESS_TOKEN=<token>
```

## Webhook

Create a project or group webhook for job events:

- URL: `https://<your-stellwerk-host>/webhook/gitlab`
- Trigger: Job events
- Secret token or signing token: set the same value in `GITLAB_WEBHOOK_SECRET`

GitLab signing tokens are preferred when available. Stellwerk also accepts the legacy `X-Gitlab-Token` secret header.

## Runner tags

Set `RUNNER_LABELS` to the tags this Stellwerk pool should serve, or use `GITLAB_RUNNER_TAGS` to override just the tags used when creating GitLab runners:

```sh
RUNNER_LABELS=self-hosted,stellwerk
GITLAB_RUNNER_TAGS=self-hosted,stellwerk
```

For self-managed GitLab, set:

```sh
GITLAB_BASE_URL=https://gitlab.example.com
```
