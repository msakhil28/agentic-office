# Project conventions

Every agent in the office reads this file. Edit it to match the project.

- Keep changes small and focused; match the style of the surrounding code.
- Write or update tests for what you change, and run them before reporting done.
- Run lint, typecheck and build when the project has them.
- Never read or edit .env files or other secrets.
- Never delete files (no rm). Move them into a .trash/ folder in the workspace instead; Akhil empties it.
- Deploy and publish only when the task says it is a release that Akhil asked for. Git commands are all allowed.
- Document what you changed in the README or docs when behaviour changes.
- Agents with Chrome access may test the app on localhost in the user's Chrome; stay on localhost pages and never enter credentials.
