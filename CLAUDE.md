# CLAUDE.md — Playwright + Cucumber BDD test framework

> 🚫 STOP sections gate an action, not advise on it. Where a rule and your judgment disagree, the rule wins.

---

## 0. Non-negotiables

| #      | Rule                                                                                                            | Enforced by | See |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----------- | --- |
| **N1** | Never run the test suite, `bddgen`, or global setup. Hand off instead.                                          | 🔒 hook     | §2  |
| **N2** | Never call `mcp__playwright__browser_*` until both `.auth/` artifacts pass the validity **and freshness** gate. | 🔒 hook     | §3  |
| **N3** | Never write a locator, role, accessible name, URL, or title you haven't confirmed against the live page.        | 🧠 you      | §4  |
| **N4** | Never hand-edit a generated file — any ❌ path in §1.                                                           | 🔒 hook     | §1  |
| **N5** | Never call a step passing/working/done without a real run result.                                               | 🧠 you      | §2  |
| **N6** | Never edit an existing step definition under [steps/](steps/) — only add new ones (`TODO`-stub exception, §4).  | 🔒 hook     | §4  |
| **N7** | Open every session with the start menu — no other tool call before it.                                          | 🔒 hook     | §9  |

🔒 = a `PreToolUse` hook in [.claude/settings.json](.claude/settings.json) denies violations; its message says why and what to do. 🧠 = rests on you. A denial is the rule working: hand off; never reword or reroute a call past a hook. Hooks catch common cases only — anything they miss is still forbidden. Hooks fail closed: if one crashes or can't start, tell the user (`npm run hooks:test` shows what broke). An approved **ask** prompt is not standing permission.

The §/N numbers are part of the interface: hook deny messages in [.claude/hooks/](.claude/hooks/) (`§1 (N4)`, `§1`, `§2 (N1)`, `§3 (N2)`, `§3.3`, `§4 (N6)`, `§9 (N7)`), §8 below, and [README.md](README.md) all cite them. Renumbering this file means updating those in the same change.

---

## 1. Overview

Playwright + Gherkin. ESM (`"type": "module"`). Tests run in Chromium only, headless by default — `test:parallel:headed` and `test:debug` run headed. The one-time login in global setup runs in Firefox, headless by default — set `LOGIN_HEADLESS=false` in `.env` to watch it headed (§5).

| Path                                                                                                                                                                               | Role                                                                     | Editable           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| [features/](features/), [steps/](steps/), [playwright.config.js](playwright.config.js), [global-setup.js](global-setup.js), [package.json](package.json), docs/config              | Scenarios, step definitions, runner config, one-time login (§5), scripts | ✅ (steps: N6)     |
| [session-state.js](session-state.js), [.mcp.json](.mcp.json) (§7), [.claude/settings.json](.claude/settings.json), `.claude/settings.local.json`, [.claude/hooks/](.claude/hooks/) | The harness — can switch a guardrail off or grant permissions            | ⚠️ only when asked |
| `.auth/`, `.features-gen/`, `test-results/`, `playwright-report/`, `blob-report/`, `node_modules/`, `.playwright-mcp/`, `package-lock.json`, `.claude/hooks/hook.log*`             | Generated output                                                         | ❌ never (N4)      |

The ❌ list is mirrored in [hook-utils.cjs](.claude/hooks/hook-utils.cjs), the `permissions.deny` list in [.claude/settings.json](.claude/settings.json), [.gitignore](.gitignore), [.prettierignore](.prettierignore) and [eslint.config.js](eslint.config.js) — keep them in step; `npm run hooks:test` fails if they drift. Never read ❌ paths either — denied for file tools (`permissions.deny`) and shell reads ([check-shell-reads.cjs](.claude/hooks/check-shell-reads.cjs)).

---

## 2. 🚫 STOP — never run the suite

Covers `playwright test`, any `test:*` script, `bddgen`, `npm test`, `node global-setup.js`. `clean`, `report`, `format`, `format:check`, `lint`, `hooks:test` are fine.

**Hand off** — tell the user (1) what you completed, (2) what's blocked + the exact command, e.g. `npm run test:debug -- <path to .feature>`, (3) what stays unverified (N5). Then wait.

---

## 3. 🚫 STOP — `.auth/` validity + freshness gate

The hook runs these on every `browser_*` call except `browser_close`.

1. **Existence/shape** — both `.auth/` files exist, native shape (§5), `sessionStorage` present, init script matches `session.json`.
2. **Cookie expiry** — no expired cookie; a navigated host must be covered by a cookie domain or `origins[]` entry.
3. **Freshness** — both files ≤ 1 hour old.
4. **Any fail** → stop, relay the denial's reasons, and give **`npm run test:debug`** (wipes `.auth/` and logs in fresh). Never create or repair the artifacts yourself.

---

## 4. Workflow — writing a step definition

Applies to anything in [steps/](steps/).

**N6:** if an existing step looks broken, report it. Edit `steps/` with the file tools only — a shell write there asks the user, since the step-edit hook can't inspect it. **`TODO` stub exception:** a `// TODO`-only body may be filled in once the user agrees, keeping its text and parameters — until then, tell the user scenarios using it aren't checking that line.

**Where steps live:** search **all** of [steps/](steps/) for the step text before writing anything — playwright-bdd loads every `steps/**/*.js`, and two files defining the same step text is a duplicate-definition error, not an override. Add a genuinely new step to the existing file that covers the same area; start a new `steps/<area>.steps.js` only for a new area, and match the `createBdd()` setup the other files use.

**N3 in practice:** never write a locator/role/name/URL/title from memory, the feature file's wording, or how the page "should" look — confirm live first. A plausible-looking locator still parses and runs; it just fails (or silently matches the wrong element) the first time the real page differs, and that's invisible until the user runs the suite.

1. The §3 gate runs automatically.
2. Load tools — `mcp__playwright__*` are deferred until schemas are fetched. Call `ToolSearch` (a tool call, not shell) to fetch the current `mcp__playwright__browser_*` schemas. Use only the exact tool names returned by the connected Playwright MCP server; do not rely on a hard-coded tool list because `.mcp.json` uses `@playwright/mcp@latest`.
3. `browser_navigate` to the page. Storage is already injected — make no manual storage calls (§7).
4. Confirm authenticated UI in the snapshot before trusting anything on the page. Login page → stop per §3; don't read locators off it.
5. `browser_snapshot` for real refs/roles/names. Perform the interaction, snapshot again to confirm the resulting title/URL/state.
6. **Verify every XPath you'll write** with `browser_evaluate` (`document.evaluate`) — a snapshot shows roles and names, not the classes/attributes an XPath depends on. Run the exact expression with a real parameter value substituted and check the match count: exactly 1 for a single element, the expected number for a list; 0 means it's wrong.
7. `browser_close`.
8. Write the step using only values confirmed in steps 3–6.
9. Hand off per §2 with `npm run test:debug -- <path to .feature>`.

---

## 5. Session state — how the pieces flow

Applies to [session-state.js](session-state.js), [global-setup.js](global-setup.js), `.auth/session.json`, the `"I inject session state from file"` step.

**Don't read [session-state.js](session-state.js) or [global-setup.js](global-setup.js) for routine work** (writing steps, editing features) — this section and §3 already cover what you need, and the §3 hook does the validation. Read them only when the task is about session handling: changing login or session capture, or debugging a `readSessionState()` / `validateSessionState()` error.

`global-setup.js` runs once per test run, before any worker, writing **two** artifacts from one capture (so they can't drift):

- `.auth/session.json` — native `storageState` (`cookies`, `origins[].localStorage`) + a top-level `sessionStorage` field (Playwright doesn't capture this natively; ignores the extra unknown key harmlessly).
- `.auth/session.init.js` — localStorage + sessionStorage inlined as a web-storage init script.

The test step reads the file through `readSessionState()` ([session-state.js](session-state.js)), which **throws** on a missing/unparseable/non-native file or an expired cookie rather than injecting nothing. The MCP server reads both files directly, so its guard is the §3 gate hook, which applies the same `validateSessionState()`:

| Consumer                                                           | cookies           | localStorage                        | sessionStorage  |
| ------------------------------------------------------------------ | ----------------- | ----------------------------------- | --------------- |
| `npx playwright test` (`Given "I inject session state from file"`) | `addCookies`      | `addInitScript`, per origin         | `addInitScript` |
| Playwright MCP (`.mcp.json`, §7)                                   | `--storage-state` | `--storage-state` + `--init-script` | `--init-script` |

**Required `session.json` shape** — `origins` plural array; each `localStorage` an **array of `{ name, value }`**, not an object (Playwright's native format, fed straight to `browser.newContext({ storageState })`):

```json
{
  "cookies": [{ "name": "…", "value": "…", "domain": "…", "path": "/" }],
  "origins": [{ "origin": "https://example.com", "localStorage": [{ "name": "k", "value": "v" }] }],
  "sessionStorage": { "k": "v" }
}
```

**sessionStorage workaround:** Playwright's `storageState` doesn't persist session storage (only cookies, localStorage, opt-in IndexedDB, passkeys), so this repo hand-rolls it: `page.addInitScript()` for the test step, the generated init script for MCP.

**Other facts:**

- **No session reuse** — every run (including `test:debug`) wipes `.auth/` and logs in fresh, so a stale or half-written pair never leaks into a run. That is the only way to refresh it; never tell the user to delete `.auth/` by hand.
- **IndexedDB not captured** (`storageState({ indexedDB: true })` isn't called) — a token stored there makes the session look valid but be incomplete.
- `session.init.js` holds **real session values as plaintext JS**. `.auth/` is gitignored — keep it that way; never paste its contents into logs/issues/commits/chat.
- **Invariant:** both consumers must end up with all three state pieces. Changing what `global-setup.js` writes requires updating `validateSessionState()`, `writeInitScript()`, and both readers together. The gate's extra checks (sessionStorage present, init script present, freshness) live in [.claude/hooks/check-session-gate.cjs](.claude/hooks/check-session-gate.cjs).

---

## 6. Conventions

### Step definitions (same scope as §4)

Match existing style in the step files already under [steps/](steps/).

- **XPath-only locators**: use `page.locator('xpath=...')` for all locators, not `getByRole`/`getByLabel`/`getByText`/CSS. ✅ `page.locator("xpath=//a[contains(@class,'docs-link')]")` ❌ `page.getByRole('link', { name: 'Docs' })`
- **Scope before assert**: narrow to a container first with a scoped xpath. ✅ `page.locator("xpath=//nav[@aria-label='Docs sidebar']//a[text()='Docs']")`
- **Lists go in a data table**: take the table as the last argument and iterate `table.hashes()`, with an UPPERCASE header column.
- **Quote-safe XPath**: a parameter pasted raw inside `'…'` in an XPath breaks on any value containing an apostrophe. In new steps, build the literal so it survives one — plain quotes when the value has none, XPath `concat()` when it does.
- **ESM imports**; Node builtins as `node:fs`/`node:path`.
- **Declarative, reusable step text** — values (names, labels, search terms) come in as `{string}` parameters, never hard-coded in the step text; specifics live in the feature file.

### Feature files ([features/](features/))

- **Logged-in scenarios start with** `Given I inject session state from file` — normally in the `Background`, before any navigation. Leaving it out gives a logged-out run (§8).
- **One `Feature` per file**, named after its test ID, with a matching tag on the scenario.
- **Reuse existing step text verbatim.** Any wording change — even punctuation or quotes — needs a new definition (§4).
- **Name the feature and scenario after the behaviour they check**, not a placeholder.

---

## 7. Reference — `.mcp.json`

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--isolated",
        "--storage-state=.auth/session.json",
        "--init-script=.auth/session.init.js"
      ],
      "env": {}
    }
  }
}
```

| Flag                                  | Effect                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--storage-state=.auth/session.json`  | Seeds cookies + localStorage (not sessionStorage). Silent no-op if missing/non-native → §3.                     |
| `--init-script=.auth/session.init.js` | Runs before every page's own scripts; carries localStorage + sessionStorage, closing the `--storage-state` gap. |
| `--isolated`                          | Fresh in-memory profile per session, seeded by `--storage-state`, discarded on close.                           |

The §3 gate matcher (`mcp__playwright__browser_.*`) must cover every Playwright MCP server, and `--caps=storage` stays off — `--init-script` already seeds storage; inspect it with `browser_evaluate`. `npm run hooks:test` checks both.

---

## 8. Failure modes

| Symptom                                                | Likely cause                                                             | Fix                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP browser shows a login page or behaves as anonymous | `.auth/` missing, expired, stale, or non-native shape                    | §3 — stop; tell user to re-login via `npm run test:debug`                                                                                           |
| `Tool not found: mcp__playwright__…`                   | Schemas never fetched, or tool needs `--caps=storage` (not enabled)      | §4 step 2 — `ToolSearch`; a missing storage/network/vision/pdf/devtools/testing/config tool means the capability flag isn't enabled here on purpose |
| Feature file edits have no effect                      | Stale `.features-gen/` — regenerates only when user runs the suite       | Ask user to re-run; never edit `.features-gen/`                                                                                                     |
| Step passes in MCP, fails in the run                   | Verified while logged out, or scenario missing session-injection `Given` | Re-verify per §4; confirm scenario injects session state                                                                                            |
| Flaky visibility assertion                             | Ambiguous locator matching several nodes                                 | Scope the XPath to a container; use exact `text()='…'` instead of `contains()`; avoid blind `.first()` / `[1]`                                      |
| Any hook denial or prompt                              | A rule fired — the message names the rule and the fix                    | Follow the message; hand off per §2; an unrequested harness-edit prompt means withdraw the change                                                   |

---

## 9. 🚫 STOP — session start menu

**On the first turn of a session, before anything else,** call `AskUserQuestion` once with a single question, "What would you like to do?", and exactly these options:

1. **Implement TODO steps** — fill in the `// TODO`-only step bodies under [steps/](steps/), following §4.
2. **Exit** — do nothing; end the turn with a one-line goodbye.

(The tool adds "Other" automatically for a different task, including one already in the user's first message.) Do not run searches, read files, or load tools before the user answers.

[check-session-menu.cjs](.claude/hooks/check-session-menu.cjs) denies every other tool call until that exact question and those two option labels have been asked once in the session. It records the session in a marker under the OS temp dir (`claude-session-menu/<session_id>`), so a resumed or compacted session isn't asked again; markers older than 7 days are pruned. The question text and labels are mirrored in that hook — change both together. A first turn that replies in plain text without any tool call isn't caught; that still rests on you.

**On every prompt, not just the first:** [check-todo-steps.cjs](.claude/hooks/check-todo-steps.cjs), a `UserPromptSubmit` hook, scans [steps/](steps/) for `// TODO`-only bodies. If any exist it clears that marker and lists them in the prompt's context, so the menu above must be shown again before any other tool. With no TODO steps the marker stays and nothing is asked. If the scan can't run, the prompt is blocked.
