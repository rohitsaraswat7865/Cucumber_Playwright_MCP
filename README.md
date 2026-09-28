# 🎭 test01 — Playwright BDD Test Suite

> End-to-end browser tests written in plain-English Gherkin, powered by [Playwright](https://playwright.dev/) and [playwright-bdd](https://github.com/vitalets/playwright-bdd).

## ✨ Capabilities

- 🥒 **Gherkin scenarios** — test cases in `Given / When / Then` under [features/](features/), run by the Playwright test runner
- 🔐 **One login per run** — [global-setup.js](global-setup.js) captures the session once and every scenario replays it ([Session state](#-session-state))
- 📊 **Reporting** — HTML report in `playwright-report/`, JSON results in `test-results/results.json`
- 🔁 **Parallel runs** — fully parallel test files; the `test:parallel:*` scripts use 3 workers
- 🤖 **Claude Code, with guardrails** — Claude drafts steps against the live app through the Playwright MCP browser, and hooks stop it from breaking the project's rules ([Working with Claude Code](#-working-with-claude-code))
- 🧩 **Editor setup** — [.vscode/settings.json](.vscode/settings.json) wires up Specwright and Prettier format-on-save

## 📁 Project structure

```
├── features/             🥒 Gherkin .feature files (test scenarios)
├── steps/                🪜 Step definitions implementing the Gherkin steps
├── playwright.config.js  ⚙️ Playwright + BDD configuration
├── global-setup.js       🔐 Logs in once, captures the session before tests run
├── session-state.js      📜 Session-file format contract (read / write / validate)
├── .mcp.json             🤖 Playwright MCP server for Claude's browser
├── CLAUDE.md             🤖 Instructions Claude Code reads every session
├── .claude/settings.json 🛡️ The harness: hooks that enforce CLAUDE.md's key rules
├── .claude/hooks/        🛡️ The hook scripts
├── .prettierrc.json      🎨 Prettier config, including the Gherkin plugin
└── .vscode/settings.json 🧩 Specwright paths + Prettier format-on-save
```

Generated — gitignored, never hand-edit: `.auth/` (the captured session), `.features-gen/`, `test-results/`, `playwright-report/`, `.playwright-mcp/`.

## 🚀 Getting started

Needs Node.js with npm; the Claude Code hooks also need `node` on your PATH.

```bash
npm install
npx playwright install     # browser binaries: Chromium runs the tests, Firefox runs the one-time login
```

## ▶️ Running tests

| Command                                            | Description                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run bddgen`                                   | ⚙️ Generate BDD spec files from `.feature` files into `.features-gen/`       |
| `npm run clean`                                    | 🧹 Delete `.features-gen/` (every test script does this first)               |
| `npm run test:parallel:headed`                     | 🖼️ Clean, generate, and run with 3 workers, browser visible (`--headed`)     |
| `npm run test:parallel:headless`                   | 🤖 Clean, generate, and run with 3 workers, no browser UI                    |
| `npm run test:debug`                               | 🐞 Clean, generate, and run in the Playwright Inspector (headed, one worker) |
| `npm run test:debug -- features/TEST-XXX1.feature` | 🐞 Same, for a single `.feature` file                                        |
| `npm run report`                                   | 📊 Open the last Playwright HTML report                                      |
| `npm run format` / `npm run format:check`          | 🎨 Format with Prettier / only check formatting                              |

Every test run starts with global setup: a headed Firefox window opens, logs in, and writes a fresh `.auth/` (see [Session state](#-session-state)).

## 🖊️ Writing a new scenario

1. Add a `Scenario` to a `.feature` file in [features/](features/). To run it logged in, start with `Given I inject session state from file`, as the `Background` in [features/TEST-XXX1.feature](features/TEST-XXX1.feature) does
2. Add any missing steps in [steps/](steps/) using `createBdd()` from `playwright-bdd` — or ask Claude Code to draft them ([below](#-working-with-claude-code))
3. Run `npm run test:parallel:headed` (or `test:parallel:headless`); `bddgen` generates the Playwright spec files from your Gherkin first

## 🔐 Session state

[global-setup.js](global-setup.js) logs in **once per test run**, before any worker starts, and writes two files into `.auth/` from the same capture:

| File              | Holds                                                                                                                        | Used by                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `session.json`    | Cookies and per-origin `localStorage` in Playwright's native `storageState` format, plus `sessionStorage` as one extra field | The `I inject session state from file` step; the MCP browser's `--storage-state` |
| `session.init.js` | `localStorage` + `sessionStorage` as a script that runs before every page                                                    | The MCP browser's `--init-script`                                                |

Two files are needed because Playwright's `storageState` can't carry `sessionStorage` — the [auth docs](https://playwright.dev/docs/auth) say _"Playwright does not provide API to persist session storage."_ Together they restore cookies, `localStorage` and `sessionStorage` in both the tests and the MCP browser.

[session-state.js](session-state.js) owns the format: it's the only code that writes the file, and everything that checks it — the test step and Claude's session gate — uses its validator, which **throws** instead of letting a malformed file through. That matters because Playwright silently ignores keys it doesn't recognise, so a hand-written file (singular `origin`, object-shaped `localStorage`) gives you a logged-out browser and no error.

**Gotchas**

- 🚫 **Never hand-edit `.auth/`.** Every run wipes it and logs in fresh (including `test:debug`), so re-running the suite is how you replace an expired session.
- 📇 **IndexedDB isn't captured** (that needs `storageState({ indexedDB: true })`). If your app keeps its token there, the session will be incomplete.
- 🔑 **`session.init.js` holds real session values in plaintext.** `.auth/` is gitignored — keep it that way.
- 🔨 **The login targets the OrangeHRM demo site** (headed Firefox, in [global-setup.js](global-setup.js)); replace that flow to point the suite at your own app.

## 🤖 Working with Claude Code

Two layers keep Claude in line:

- **[CLAUDE.md](CLAUDE.md) is instructions.** Claude Code reads it at the start of every session, but nothing enforces it — Claude follows it by choice.
- **The harness is enforcement.** `PreToolUse` hooks in [.claude/settings.json](.claude/settings.json) run on every matching tool call and block the ones that break a rule, whether or not Claude remembers it.

### CLAUDE.md

It maps the repo — which files Claude may edit and which are generated — and sets a verify-before-writing workflow for steps: Claude checks every locator against the real page in the Playwright MCP browser ([.mcp.json](.mcp.json)) instead of guessing. That browser reuses the tests' captured session, so it needs a fresh `.auth/` (less than an hour old). CLAUDE.md's six non-negotiables (N1–N6) include an "Enforced by" column showing which ones the harness backs.

### The harness

| Hook                                                                      | Runs on                                    | Blocks                                                                                                                                                                 | If the hook itself breaks |
| ------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [check-session-gate.cjs](.claude/hooks/check-session-gate.cjs) (N2)       | Every Playwright MCP browser call          | Any browser call while `.auth/` is missing, malformed, holds an expired cookie, or is more than an hour old                                                            | Blocks the call           |
| [check-no-suite-run.cjs](.claude/hooks/check-no-suite-run.cjs) (N1)       | Shell commands (Bash, PowerShell, Monitor) | Running the suite, `bddgen`, or `node global-setup.js`, including npm scripts that wrap them (read live from [package.json](package.json))                             | Lets the command through  |
| [check-generated-files.cjs](.claude/hooks/check-generated-files.cjs) (N4) | Claude's file edits                        | Edits to generated output: `.auth/`, `.features-gen/`, `test-results/`, `playwright-report/`, `blob-report/`, `node_modules/`, `.playwright-mcp/`, `package-lock.json` | Lets the edit through     |

**When Claude gets blocked**, it sees a message starting `Blocked by CLAUDE.md …` and should stop and tell you. What to do:

- **`§3 (N2)`** — the session is missing or stale. Run `npm run test:debug` (or a `test:parallel:*` script) yourself, then ask Claude to carry on.
- **`§2 (N1)`** — Claude tried to run the suite. It should hand you the exact command instead; run it yourself.
- **`§1 (N4)`** — Claude tried to edit generated output. It should change the source instead: a `.feature` file, `steps/`, or `package.json`.

**Limits**

- The suite guard recognises ordinary commands — npm scripts, `npx`, the binaries themselves, `&&` chains, `bash -c` — not deliberate workarounds.
- The file guard covers Claude's edit tools, not shell writes.
- N3 (confirm locators on the live page), N5 (no "it passes" without a real run) and N6 (never edit existing steps, except filling in an empty `TODO` stub you've approved) have no hook; they rely on Claude following CLAUDE.md.
- The hooks run inside Claude Code only; your terminal and the Specwright runner are unaffected. If a command you type with Claude Code's `!` prefix is ever blocked, run it in your terminal.

**Checking and changing the hooks**

- Run `/hooks` in Claude Code to see what's active. Changes to `.claude/settings.json` take effect after you restart Claude Code; edits to the scripts in `.claude/hooks/` apply on the next tool call.
- To change or switch off a hook, edit or remove its entry in `.claude/settings.json`. The file is shared, so the change applies to everyone using the repo.
- Your personal permission allow list lives in `.claude/settings.local.json` (gitignored). A hook's block overrides it.
- Hooks run under Git Bash, or PowerShell where Git Bash isn't installed; the commands work in both.

**Workflow Dig.**
![alt text](image.png)

## 🛠️ Recommended VS Code extensions

[.vscode/settings.json](.vscode/settings.json) is already configured for these — install them from the Extensions view:

- 🥒 **Specwright — BDD Authoring for Playwright** (`upscaled-dev.specwright`) — Gherkin syntax highlighting, step navigation/autocomplete, and a test runner for `playwright-bdd`, pointed at [features/](features/) and [steps/](steps/) via `playwrightBddRunner.testFilePattern` / `playwrightBddRunner.stepDefinitionPaths`
- 🎨 **Prettier** (`esbenp.prettier-vscode`) — the workspace's default formatter, run on every save
- 🤖 **Claude Code** (`anthropic.claude-code`) — AI pair-programming inside VS Code
