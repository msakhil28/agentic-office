---
name: implementation-planning
description: Turn approved requirements into a sequenced delivery plan with owners, dependencies, and observable completion criteria.
license: MIT
metadata:
  version: "1.0"
  reference: "https://github.com/github/awesome-copilot/blob/main/docs/README.skills.md"
---

Check open work and the roster before proposing tasks. Use the existing task IDs when new work depends on work already underway.

Plan from the acceptance criteria. Give each step an owner, a concrete artifact or outcome, and the prerequisite keys the owner needs. Separate steps that can run concurrently from steps that touch the same files or consume the same outputs.

For a build, place independent QA after all builders. Define what would trigger a fix and retest. Include a release readiness step when requested and identify any decision that requires the owner.
