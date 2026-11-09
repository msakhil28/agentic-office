---
name: testing-strategy
description: Choose test coverage based on change risk, acceptance criteria, and available tooling.
license: MIT
metadata:
  version: "1.0"
---

List the behaviors and boundaries the change can break. Put each check at the cheapest level that can reliably prove it, and reserve end-to-end checks for interactions and integration seams. Specify fixtures, expected results, and any gaps that require manual verification.
