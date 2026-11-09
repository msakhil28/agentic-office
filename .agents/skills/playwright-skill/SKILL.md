---
name: playwright-skill
description: Run a browser smoke test of a local application with the project’s Playwright setup or an available browser tool.
license: MIT
metadata:
  office-compatibility: Requires an installed Playwright browser or another authorized browser tool for UI checks.
  version: "1.0"
  reference: "https://playwright.dev/agent-cli/skills"
---

Start the dev server with the project’s documented command if needed. Confirm the exact local URL, then exercise the acceptance path in a fresh browser context. Use existing Playwright tests or the installed Playwright CLI when available. Check the installed CLI’s help for commands that vary by version. An authorized browser tool can also exercise the same flow.

Assert visible behavior after each meaningful action. Capture the failing step, expected and actual results, and relevant console or network errors. Include evidence paths in the report and stop any server or browser session you started.

If the environment lacks browser access, report the UI checks as blocked and label any HTTP checks separately.
