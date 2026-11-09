---
name: chrome-browser
description: Use the Claude in Chrome extension for authorized local application testing when the hire has Chrome access.
license: MIT
metadata:
  office-compatibility: Requires Claude in Chrome and Chrome access enabled for this hire.
  version: "1.0"
  office-requires: claude-chrome
---

Use the browser access granted by the office to open a new test tab for the local app. Follow the task’s Chrome restrictions and check the actual user flow, console, and network results.

Record the URL, reproduction steps, expected and actual behavior, and relevant errors. Close the test tab when finished. If the extension cannot connect, report that browser testing is blocked.
