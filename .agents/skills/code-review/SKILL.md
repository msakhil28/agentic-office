---
name: code-review
description: Review a change for actionable correctness, security, and regression issues with concrete repro conditions.
license: MIT
metadata:
  version: "1.0"
  reference: "https://github.com/anthropics/knowledge-work-plugins#plugin-marketplace"
---

Start with the intended behavior and inspect changed callers, migrations, and failure paths. Check whether existing inputs, retries, and concurrent operations can leave inconsistent state.

Report each actionable issue with a file and line, triggering scenario, and user-visible impact. Order issues by severity. Call out verification gaps separately from demonstrated defects. Keep the review read-only unless the task also asks for fixes.
