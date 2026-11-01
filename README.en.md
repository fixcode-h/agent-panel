# Agent Panel

[中文](README.md) | English

A web console that runs on your own machine. It organizes work by project and drives the coding CLIs installed locally
(Claude Code, Codex, Command Code, Pi). A lead agent and sub-agents execute tasks by following a workflow's flowchart:
edges decide the order, nodes without a dependency run at the same time, and every step in a node can have a review
flow attached that sends the work back for changes when it does not pass. The UI follows the style of Claude Code.

**Live preview**: <https://fixcode-h.github.io/agent-panel/> (the latest `dev` branch; it simulates execution in the
browser and never calls a real CLI).

The Chinese [README.md](README.md) is the full reference; this page is a short summary.

## What it does

- **Agents**: each agent is a "CLI + model + role" combination. Installed CLIs are detected automatically and the
  exact command line is previewed. Model tiers (high / medium / low) and reasoning effort can be switched globally.
- **Workflows**: arrange a lead agent and sub-agents on a flowchart, with sub-flows, multi-step nodes, start / end
  hooks, reviews with retry rounds, and "wait for my confirmation" gates.
- **Projects and tasks**: a project is a local directory. Tasks either run a workflow or chat with a single agent,
  with streamed output, plans, token usage, changed files and git status shown live. Failed or stopped tasks can be
  resumed from the unfinished step.
- **AI create / optimize**: describe an agent or workflow in one sentence and let a local CLI generate or revise it;
  changes are previewed before they are written.
- **Project lessons, MCP and Skills**: rules learned from rework, MCP servers and skill folders are managed per project.
- **Settings**: per-CLI models, limits, permissions, environment variables, one-click install / update of CLIs, and
  in-app version updates from GitHub Releases. Light and dark themes.

## Download and install

Download a package from **[Releases](https://github.com/fixcode-h/agent-panel/releases)** (packages are only built
from `main`). After unpacking, the only requirement is **Node.js 22+**.

- **Windows**: double-click `AgentPanel.exe`. It runs without a console window, puts an icon in the notification
  area and opens the browser; right-click the icon to quit. If Windows shows "Windows protected your PC", the tray
  program is not code-signed: click "More info" → "Run anyway".
- **macOS / Linux**: run `./start.sh`. To start it automatically in the background at login, run
  `./install-service.sh` once.

You also need at least one coding CLI, logged in once in a terminal (or with an API key set in the panel's
environment-variable settings):

| CLI          | Install                                          | Default command |
| ------------ | ------------------------------------------------ | --------------- |
| Claude Code  | `npm install -g @anthropic-ai/claude-code`       | `claude`        |
| Codex        | `npm install -g @openai/codex`                   | `codex`         |
| Command Code | `npm install -g command-code`                    | `cmdc`          |
| Pi           | `npm install -g @earendil-works/pi-coding-agent` | `pi`            |

Data lives in a local data directory (default `~/.agent-panel`, plain JSON files); set `AGENT_PANEL_DATA` to use
another one. The server only listens on `127.0.0.1`, because it starts CLIs and reads and writes project directories.

## Quick start from source

Requires Node.js 22.12+ and git.

```bash
npm ci             # install exactly what package-lock.json lists
npm run dev        # web http://localhost:5173, server http://127.0.0.1:8787
```

Production mode (single port):

```bash
npm run build
npm start          # http://127.0.0.1:8787
```

## Development commands

```bash
npm run typecheck      # TypeScript + missing-translation check
npm run lint           # oxlint, Prettier check, repository rules, secret scan
npm run test:affected  # only the unit tests affected by your change
npm run test:unit      # all unit tests
npm run test:e2e       # end-to-end tests with fake CLIs (macOS / Linux; on Windows use WSL: npm run test:e2e:wsl)
node scripts/ui-check.mjs   # UI check against the demo build; screenshots in ui-shots/
npx vite build --mode demo  # the in-browser demo build
npm run package        # release packages into release/
```

The UI check drives chromium through Playwright; install the browser once before the first run:
`npx playwright install chromium`.

Development happens on the `dev` branch; `main` is only updated for releases. Project conventions (written in
Chinese) are in [AGENTS.md](AGENTS.md) and the docs index is [docs/README.md](docs/README.md).

## Contributing, security and license

- How to propose changes and which checks must pass: [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese).
- Please report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.
- Licensed under the [Apache License 2.0](LICENSE); third-party notices are in [NOTICE](NOTICE).
