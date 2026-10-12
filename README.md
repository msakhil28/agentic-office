# Agentic office

A local web app that runs an AI office. You talk to a **Boss** agent, the Boss delegates to agents you hire (Sales, Marketing, Engineering, QA, Product, Release…), and the agents do the work in a folder you choose. A 3D office shows who is working.

The Boss and every agent run on the **Claude CLI** or the **OpenAI Codex CLI**, which you choose per session.

```
 You ──chat──▶ Boss ──delegates──▶ Agents (Claude / Codex CLI) ──work in──▶ Workspace folder
  ▲                                   │
  └──── results, questions (Inbox) ◀──┘
```

## Quick start

**Requirements**

| Need | Notes |
|---|---|
| Node.js ≥ 23.6 | Runs the TypeScript server directly; no build step. |
| Claude CLI (`claude`) | Signed in. Used in Claude mode, which is the default. |
| Codex CLI (`codex`) | Optional. Signed in. Needed only for OpenAI mode. |

```bash
npm install
```

```bash
npm start
```

`npm start` runs on **port 8100** and prints a local URL (http://localhost:8100) and a phone URL. Open it and enter the 4-digit code (default **1234**). Then go to **Team**, and click the starter-office button to hire a Project Manager, Release, Sales, Marketing, Dev, QA, Product and Legal in one go. Then tell the Boss what you need.

## Tabs

| Tab | What it does |
|---|---|
| **Boss** | Chat with the Boss. It has no tools; it routes work by each agent's title and job description, then reports back. Shows the office floor plan, who is working or idle, an overview, and recent activity. The left sidebar has a « / » button that shrinks it to a slim bar for more room (remembered in the browser). |
| **Projects** | One card per goal the Project Manager planned: progress bar, cost, each step with its owner and status, and the manager's final report. |
| **Live** | One card per agent. Working agents show their task, a running timer and a live feed (files read/written, commands, notes). Idle agents show their last result; agents with waiting work show "queued" with what they wait on. Tool names are shown readably (e.g. "Chrome · javascript tool"). |
| **Files** | Read-only browser for the workspace (text, rendered Markdown, images). Can't leave the workspace folder. The list refreshes itself while agents work and marks files changed in the last 2 minutes as **new**. **Open** / **Run in browser** opens the file in your computer's default app (HTML opens in your browser) and **Reveal** shows it in Finder; both work only from the computer running the office and only for plain document types. Folders that are git repos show a badge (branch, ↑ahead ↓behind, changed count), and a Git card lists the changed files when you're inside a repo. |
| **Team** | Hire and fire agents (title, job, team). Pick a model for the Boss and for each agent. Pin skills to agents. |
| **Tasks** | Every delegated task with status, a collapsible result and cost. Filter by Active, Needs you, Done or Failed. Each agent runs one task at a time. |
| **Usage** | The latest 200 Boss and worker runs: tokens, cache, duration, resume and compaction details. |
| **Inbox** | Open questions grouped by task, with **Yes / No / Your call** quick replies; answered items collapse below. Everything that needs you: agent questions (answering resumes the agent) and items the Boss raises (decisions, approvals, things only you can do). Open items also appear in a panel on the right of the home (Boss) page, so you can answer them there. The tab badge and page title show the open count. |
| **Skills** | Skills installed for Claude (`~/.claude/skills` and plugins). |
| **Settings** | Choose Claude or OpenAI for this session, set a **budget cap**, pause all work, and turn on browser alerts. Saved on change; applies to new runs. |

## Talking to the office

| Feature | Behaviour |
|---|---|
| Templates | An empty chat offers Startup launch, Build a small app, Content plan and Fix a bug starters. A new office shows a one-click **Hire starter office** button. |
| `@Name` | Start a message with `@Dev fix the footer` to send it straight to that agent, skipping the Boss. Unknown names go to the Boss. |
| Pause all | The header link (and Settings) stops new tasks from starting; running ones finish. |
| Budget cap | Set a dollar cap in Settings. When tracked spend reaches it no new task starts and the Boss page shows a banner; raise or clear it to continue. |
| Alerts | Settings → Enable alerts shows a browser notification when an agent needs you or all work finishes, while the tab is hidden. |
| Deep links | `#Team`, `#Inbox` etc. work, including Back/Forward. |

## The 3D office

Above the Boss chat is a real-time 3D office (WebGL via [Three.js](https://threejs.org), served locally, so no internet is needed). **hide** collapses it to a one-line bar.

| Area | What's there |
|---|---|
| Boss's office | Glass-walled room with a walnut desk, red leather chair, guest chairs, bookshelf, sofa and rug. |
| Open plan | One cubicle per team, with partitions in the team's colour and a name plate. Monitors glow green while an agent works and amber when it needs you, and a speech bubble shows its latest step. |
| Lounge | Burger, pizza and noodle stalls, a vending machine, six dining tables, a coffee counter and a water cooler. |

| Control | Action |
|---|---|
| Drag | Rotate the camera. |
| Right-drag / two fingers | Pan. |
| **+** / **−** / **⟲** | Zoom in, zoom out, reset the view. |
| Click a person or name tag | Open the Live tab. |

Idle agents get up now and then and walk the corridor, through the doors, to a colleague's cubicle or the lounge. At the lounge they grab food, then either sit at a dining table to eat or carry it back and leave it on their desk for a while. When work arrives they head straight back to their desk. The animation pauses while the tab is hidden and respects reduced-motion settings. Browsers without WebGL2 get the flat pixel-art floor plan instead.

## How work flows

| Concept | Behaviour |
|---|---|
| Delegation | The Boss gets a focused snapshot of open and relevant tasks plus recent chat. It prefers direct workers for simple requests. |
| Results | Finished results appear in the Boss chat under the worker's name and stay in Tasks. The Boss is called again only for failures or decisions. |
| Dependencies | A task can wait on others (`blocked` until they finish). Prerequisite results are passed on, and dependents are cancelled if a prerequisite fails. The Boss is told once about the whole cancelled chain. |
| Managers | A **manager** agent (e.g. Project Manager) plans a goal into ordered subtasks (Product → Engineering → QA → Release), ending with a QA review. A **Release Manager** (team Release) owns CI/CD. |
| Long tasks | A worker can return a checkpoint; the app starts a fresh run with that handoff, up to three times. |
| Questions | A task waiting for input resumes its previous session when the provider is unchanged. After a provider switch it starts fresh with its original instructions plus your answer. |

## Sessions and workspace

| Feature | Behaviour |
|---|---|
| Sessions | The **Session** button switches offices or creates one. Each session has its own team, chat, tasks, Inbox, usage, provider and workspace. Work in other sessions keeps running, and the selected session is restored on restart. |
| Storage | The original office is `data/office.json`. Other sessions are in `data/sessions/`. |
| Workspace | The folder button picks where agents work, and the choice is saved. Running tasks finish in the folder they started in; new and queued tasks use the new folder. |
| Conventions | New workspaces get a `CLAUDE.md` of shared conventions, unless `CLAUDE.md` or `AGENTS.md` already exists. |
| Shared memory | Every workspace gets a `MEMORY.md`. Its newest ~2,000 characters go into each worker's prompt, and agents append short bullets for durable facts (decisions, URLs, commands, "don't do X"). Edit it any time; it's a plain file, so it also shows in the Files tab. |

## Models and providers

- **Claude** defaults to `claude-sonnet-5-5`. A blank OpenAI model uses your Codex CLI default.
- Each role can use its own model (e.g. Haiku for the Boss, Opus for Engineering). Each provider keeps its own choices, and an empty choice means the provider's default. Changes apply to the next run.
- The model list uses Claude CLI aliases. Set `ANTHROPIC_API_KEY` to load the full Anthropic model catalog.
- **Skills:** pin skills to an agent on the Team tab. The full text of each pinned skill (up to 15,000 characters) goes into that agent's prompt. Pinned skills work in Claude mode only; Codex picks from its own installed skills.

## What agents can do

| | Allowed | Denied |
|---|---|---|
| Web | Search and fetch (workers only) | — |
| Commands | `node npm npx pnpm yarn bun tsc python pytest pip make go cargo`, `curl nohup lsof kill pkill chmod ln tar zip unzip jq brew docker`, `mv cp touch find head tail wc sed sort diff ps pgrep sleep stat which date awk cut tr uniq xargs tee basename dirname du df open`, all `git` commands, Playwright via `npx`. Files are deleted by moving them into `.trash/` | `rm`, `sudo`. `ssh`, `scp`, `rsync`, `npm`/`pnpm`/`yarn publish`, `gh`, `vercel`, `netlify`, `fly`, `docker push` and similar deploy tools are denied except on release tasks |
| Files | Read and edit inside the workspace | Reading or editing `.env` |
| MCP | — | No MCP tools (see cost control) |

**Codex mode:** workers use Codex's `workspace-write` sandbox and the Boss runs `read-only`. Codex gets the same conventions as developer instructions. The app writes `.codex/rules/agent-office.rules` into the workspace to forbid `rm`, `sudo` and `git push`. Codex cannot do releases; use the Claude provider for those. Codex loads those rules only after you trust the workspace.

> **Note:** The `.env` and no-deploy rules are instructions, not filesystem access control. A shell script can get around command-prefix matching. Only run agents in folders you're comfortable with.

## Usage and limits

- The header shows your plan's **5-hour session and weekly limit left**, and when the session resets. It's read from the CLI's rate-limit events after each call, so it appears after the first call and covers your whole plan.
- **Tracked spend** is this app's own spend only. Claude reports dollar cost; Codex reports tokens but not cost.
- A compaction marked "not reported" means the CLI emitted no event, not that no compaction happened.

## Cost control (Claude)

| Measure | Effect |
|---|---|
| `--strict-mcp-config` with an empty config | Drops your connectors from every run (~73k tokens per Boss call, ~14k per worker call). |
| `--disable-slash-commands`; only pinned skills are inlined | Saves ~8k tokens per turn of skill listings. |
| `--exclude-dynamic-system-prompt-sections`, `--setting-sources project` | Smaller system prompt. |
| Explicit worker tool list | Bash, Read, Edit, Write, Glob, Grep, WebSearch, WebFetch. |
| `ENABLE_PROMPT_CACHING_1H=1` | Cache survives idle gaps (set it yourself to override). |
| Lean prompts | No teammate list for workers. Prerequisite results are clipped to 1,500 characters. Workers are told to batch tool calls and skip needless checks. |

Measured: Boss context ~75k → ~1.3k tokens, worker ~41k → ~9k per turn.

## Access code, phone and other devices

`npm start` listens on your network at port 8100 and prints a plain link (e.g. `http://192.168.1.20:8100/`). The **copy link** button in the header copies it too.

| | |
|---|---|
| New device | Any browser that hasn't unlocked yet, including this computer's, gets a code screen first. The default code is **1234**; set `OFFICE_PIN` to change it. |
| Remembered | After the right code, a signed cookie keeps that browser unlocked for a year, across server restarts. |
| Change the code | Restart with a new `OFFICE_PIN`. Every device is signed out and has to enter the new code. The signing secret lives in `data/auth-secret`; delete it to sign everyone out without changing the code. |
| Wrong guesses | After 5 wrong codes, that device's IP is locked out for 1 minute. Each further lockout doubles, up to 1 hour. |

- A 4-digit code is convenience, not strong security. Use it on a network you trust: the app runs agents on your machine.
- Use `HOST=127.0.0.1 npm start` to keep the app reachable from this computer only.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address. `127.0.0.1` keeps it local to this computer. |
| `PORT` | `8100` | HTTP port. |
| `OFFICE_PIN` | `1234` | 4-digit access code for new devices. |
| `OFFICE_DATA` | `./data` | State directory. |
| `OFFICE_WORKSPACE` | `./workspace` | Default workspace until you pick one in the UI. |
| `AGENT_PERMISSION_MODE` | `acceptEdits` | Claude permission mode. |
| `AGENT_ALLOWED_TOOLS` | built-in list | Comma-separated Claude tool list. |
| `AGENT_COMPACT_TOKENS` | `250000` | Auto-compact threshold for both CLIs. |
| `ANSWER_BATCH_MS` | `12000` | Inbox answers within this window are handled together. |
| `ANTHROPIC_API_KEY` | — | Optional; loads the full Claude model catalog. |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` | — | Fallback for the Microsoft Foundry provider when nothing is saved in Settings. |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | CLI paths. |

## Microsoft Foundry (Azure OpenAI)

Settings → Provider → **Microsoft Foundry (Azure OpenAI)** shows three boxes: **Endpoint** (`https://<resource>.openai.azure.com/`), **API key** and **Deployment name** (for example `gpt-5-mini`). Paste them and press Save.

- Boss and agents then run through the Codex CLI pointed at `<endpoint>/openai/v1` (Responses API), using the deployment name as the model. The model pickers show your deployment.
- The key is saved on this computer in `data/azure.json` (owner-only permissions), is never sent back to the browser or put on a command line, and a blank key box keeps the saved one. Only Azure OpenAI addresses (`…openai.azure.com` and similar) over https are accepted.
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_DEPLOYMENT` environment variables work as a fallback when nothing is saved.
- Costs are billed to your Azure subscription. The usage panel shows tokens but no dollars, as for any Codex run. Codex can't do releases (its rules block `git push`); use the Claude provider for those. Needs a Codex CLI version that supports custom model providers.

## Development

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

| Path | Contents |
|---|---|
| `server/index.ts` | HTTP server, JSON API (`/api/*`), live updates (`/api/events`), static files. |
| `server/auth.ts`, `public/unlock.html` | Access-code gate: code page, signed cookie, lockout after wrong guesses. |
| `server/office.ts` | Boss routing, tasks, dependencies, agents, Inbox. |
| `server/claude.ts`, `server/codex.ts` | Runners for each CLI. |
| `server/sessions.ts`, `server/store.ts` | Sessions and saved state. |
| `server/files.ts`, `server/skills.ts`, `server/models.ts` | Workspace browser, skills, model lists. |
| `public/index.html` | The UI: plain HTML/CSS/JS with no framework or build step. Also holds the pixel-art sprites and the 2D fallback office. |
| `public/office3d.js` | The 3D office (ES module). Three.js comes from the `three` npm package, served at `/vendor/three/`. |
| `test/` | `node:test` suites. |

## Tables

Click any column header in the Usage, Tasks and Skills tables to sort; click again to reverse. The Usage total row stays on top.

## Releases

Git is always allowed (commit, push, pull, `git -C`). Deploy and publish only happen when you ask for a **release**: put "release", "deploy" or "push" in your message to the Boss. Tasks created from that message (and any subtasks a manager plans from them) are marked as release tasks and get those commands; every other task has them denied. Agents never use `rm`; they move files to `.trash/` in the workspace for you to empty.

## Chrome access (Claude in Chrome)

Tick **Chrome access** on an agent in the Team tab (Claude provider only; Quinn the QA Engineer has it by default). That agent runs with `--chrome` and can drive your own Chrome through the Claude in Chrome extension to open `localhost` pages, click through the app, and read console and network errors. You watch it happen in your Chrome window.

- Needs the Claude in Chrome extension installed and connected; otherwise the task fails with a clear message.
- Only one browser agent works at a time (they share one Chrome).
- Agents use their own tab and are told to open only `localhost` / `127.0.0.1` pages. This is a prompt rule, not a hard block, and the agent acts inside your real Chrome, so grant it only to agents you trust.

## Owner decisions always reach you

Questions about money (price, budget, payments), legal (contracts, licences, trademarks), credentials or approvals, and food or medical safety are never auto-answered by the Boss or Project Manager unless you already answered the same thing. An "answer" that only says "only Akhil can decide" is treated as an escalation. Managers are told which agents can drive Chrome so they never ask you to browser-test. A wave of work that only applied your answers does not trigger an extra manager Review, and a Review does not report "Project complete" while teammates flagged conflicts between deliverables.

Plans are also checked for ordering: a step the Project Manager left with no prerequisite is ordered after the earlier pipeline stage (spec, then build, QA, fix, retest, release), so teammates never start before their inputs exist. A manager runs at most two reviews that may route more work (`MAX_ROUTING_REVIEWS`); the next is a final review that only summarises what is left, so polishing can't loop and burn money.

## Questions are triaged by the Boss

When an agent is blocked (`needs_input`), the Boss first tries to answer from the office state, finished teammates' results and earlier answers. Only real owner decisions (money, legal or public commitments, credentials, approvals) reach your Inbox, rewritten short. The Boss auto-answers at most twice per task, then asks you. The same happens for the non-blocking list of questions an agent raises while finishing: the Boss clears what it can in one call and only the rest reaches the Inbox. Boss answers appear in chat ("💬 Answered … myself") and are stored with `answeredBy: "boss"`. Fresh (non-resumed) runs are always given everything already answered on the task, and agents are told never to repeat an answered question.

## Managers follow through

Tasks a manager plans are tagged with him. When the whole wave has settled (nothing from the plan is still open, including after a failure or cancel), the manager gets a **Review** task: he sees what is done, failed or missing and either routes the next steps to teammates, or reports "Project complete: …". Failed planned tasks go to his review instead of the Boss, so there is one owner for the fix. Reviews run only when a wave settles, never while teammates are still working, and are capped at 6 per plan (`MAX_REVIEWS`). A review shows as the manager's current task in the Team and Office views.

## Dependencies and batching

- **Wait on open work:** a delegation or subtask can list the id of a task that is still open in `dependsOn`; it stays blocked until that task finishes (and is cancelled if it fails). The Boss sees task ids in its context, and managers get a "work already in flight" list.
- **Projects go through the manager:** multi-role projects, and every follow-up while one is in flight (answers, scope changes), are routed to the Project Manager as one task so he sequences and monitors it.
- **Answers are batched:** Inbox answers given within 12 seconds of each other (`ANSWER_BATCH_MS`) reach the Boss as one event, so they become one task per agent instead of one each.

Everything already answered (latest 15 across the office, plus all answers on the task) is passed to every agent run, the Boss and the question triage, with an instruction never to re-ask or repeat it; repeated items are answered from the earlier answer.

## Questions go to the Project Manager

When an agent is blocked or raises questions, a **manager** now settles them (the manager who planned the task, else any other manager; with none hired the Boss does, as before). It runs as a separate quick call with read-only workspace tools (`Read`, `Glob`, `Grep`; read-only sandbox on Codex), so it does not use his task slot. He can:

- **answer** (from files, teammates' results, earlier answers or good judgement),
- **ask a teammate**: a short "Answer for …" task is created for the person who knows, and its result becomes the answer for the blocked agent (a failed or cancelled one sends the question to you),
- **escalate** to your Inbox.

Always escalated to you: owner decisions (money, legal or public commitments, credentials, approvals), a question that repeats one the same task already asked (word overlap), and anything after 5 auto-answers on one task (`MAX_AUTO_ANSWERS`). For a finished agent's non-blocking list, the manager can also create one follow-up task so the agent applies his answers.

Your answers to non-blocking Inbox items go to the manager as one task ("Apply Akhil's answers", batched 12 s) so he re-sequences the plan; answers to a blocked task resume that task directly. Boss-raised questions still go to the Boss.

The Usage tab has a **Reset usage** button (with a confirmation). It zeroes this session's spend totals, call counts and run log; tasks, chat and agents are kept.

## License

MIT, see [LICENSE](LICENSE).
