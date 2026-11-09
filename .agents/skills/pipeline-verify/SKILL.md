---
name: pipeline-verify
description: Verify handoffs among requirements, implementation, QA evidence, and release artifacts before advancing a delivery step.
license: MIT
metadata:
  version: "1.0"
---

Trace each required outcome to the relevant artifact and verification result. Check that the result refers to the same revision, environment, and configuration as the artifact it claims to cover.

Flag gaps with the affected criterion, evidence examined, owner, and smallest action needed to clear the gap. Distinguish missing evidence from observed failures. Leave rollout decisions to the release task.
