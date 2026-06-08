---
name: Bug Report
about: Report a bug or unexpected behavior
title: '[Bug] '
labels: bug
assignees: ''
---

## Describe the Bug
A clear and concise description of what the bug is.

## Steps to Reproduce
1. Set `MODEL` to `...`
2. Send request to `POST /v1/messages` with `...`
3. See error `...`

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happened. Include the full error message/stack trace.

## Configuration
- **Provider / Base URL:** (e.g. `https://api.moonshot.cn/v1`)
- **Model mapping in use:** (paste from `/admin/api/models/mappings`)
- **Client model requested:** (e.g. `claude-opus-4-5-20251101`)
- **Resolved model:** (shown in admin dashboard or logs)
- **Gateway version:** (from `/health` endpoint)

## Environment
- **OS:** (e.g. Ubuntu 22.04, Windows 11, macOS 14)
- **Node.js version:** (run `node --version`)
- **Deployment:** (local / Docker / PM2 / other)

## Logs
```
Paste relevant log output here (check server.log or console output)
```

## Additional Context
Any other context about the problem here.
