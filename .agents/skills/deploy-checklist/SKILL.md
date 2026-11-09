---
name: deploy-checklist
description: Review release readiness and prepare a rollout plan with verification signals and a rollback path.
license: MIT
metadata:
  version: "1.0"
  reference: "https://github.com/github/awesome-copilot/blob/main/docs/README.skills.md"
---

Identify the exact revision, artifact, target environment, and evidence from CI and QA. Separate checks you observed from checks still pending.

For each risky change, specify a preflight check, a post-release signal, and a condition that triggers rollback. Check whether migrations or data changes make rollback unsafe and record any recovery prerequisite.

Report ready, blocked, or ready with conditions. Treat deployment and publication as separate actions that require the task’s release authorization.
