---
name: debug
description: Reproduce and isolate an application failure, implement a scoped fix, and verify the failure path.
license: MIT
metadata:
  version: "1.0"
  reference: "https://github.com/anthropics/knowledge-work-plugins#plugin-marketplace"
---

Capture the exact command or user action, environment, expected result, and first useful error. Reproduce with the smallest fixture that still fails. If the failure is intermittent, record how often it happens and what differs between runs.

Form a hypothesis and use a check that can rule it out. Trace the input and output across the first faulty boundary before changing code. Make the smallest correction and repeat the original repro plus a neighboring case. Report observed results and any remaining uncertainty.
