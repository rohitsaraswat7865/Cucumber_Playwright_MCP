# CLAUDE.md — Playwright + Cucumber BDD test framework

> 🚫 STOP sections gate an action, not advise on it. Where a rule and your judgment disagree, the rule wins.

---

## 0. Non-negotiables

| #      | Rule                                                                                                                                                                                            | Enforced by                  | Full text |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------- |
| **N1** | Never run the test suite, `bddgen`, or global setup. Hand off instead.                                                                                                                          | 🔒 hook — common invocations | §2        |
| **N2** | Never call `mcp__playwright__browser_*` until both `.auth/` artifacts pass the validity **and freshness** gate.                                                                                 | 🔒 hook — fails closed       | §3        |
| **N3** | Never write a locator, role, accessible name, URL, or title you haven't confirmed against the live page.                                                                                        | 🧠 you                       | §4        |
| **N4** | Never hand-edit a generated file — any ❌ path in §1 (`.auth/*`, `.features-gen/`, report dirs, …).                                                                                             | 🔒 hook — file tools only    | §1        |
| **N5** | Never call a step passing/working/done without a real run result.                                                                                                                               | 🧠 you                       | §2, §4    |
| **N6** | Never edit an existing step definition in any file under [steps/](steps/). Only add new steps for what's missing — sole exception: filling in an empty `TODO` stub once the user approves (§4). | 🧠 you                       | §4        |

🔒 = a `PreToolUse` hook in [.claude/settings.json](.claude/settings.json) checks every matching tool call and denies violations, whether or not you remember the rule. 🧠 = no hook can judge it, so it rests entirely on you. Either way, a denial is the rule working: hand off, and never reword or reroute a call to get past a hook. Hooks catch common cases only, so anything they miss is still forbidden.

The §/N numbers are part of the interface: hook deny messages in [.claude/hooks/](.claude/hooks/) (`§1 (N4)`, `§2 (N1)`, `§3 (N2)`, `§3.3`), §8 below, and [README.md](README.md) all cite them. Renumbering this file means updating those in the same change.

---

## 1. Overview

Playwright + Gherkin. ESM (`"type": "module"`). Tests run in Chromium only, headless by default — `test:parallel:headed` and `test:debug` run headed. The one-time login in global setup runs in a headed Firefox window (§5).

| Path                                                                                                                            | Role                                                                                | Editable                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| [features/](features/) `**/*.feature`                                                                                           | Gherkin scenarios                                                                   | ✅                            |
| [steps/](steps/) `**/*.js`                                                                                                      | Step definitions via `createBdd()`                                                  | ✅ add only (N6)              |
| [playwright.config.js](playwright.config.js)                                                                                    | `defineBddConfig({ features, steps })` + runner config                              | ✅                            |
| [global-setup.js](global-setup.js)                                                                                              | One-time login → writes both `.auth/` artifacts (§5)                                | ✅                            |
| [session-state.js](session-state.js)                                                                                            | Format contract for session file (read/write/validate)                              | ✅                            |
| [package.json](package.json)                                                                                                    | npm scripts — `test:*` and `bddgen` fall under N1 (§2); the N1 hook reads them live | ✅                            |
| [.mcp.json](.mcp.json)                                                                                                          | Playwright MCP server config (§7)                                                   | ✅ never add `--caps=storage` |
| [README.md](README.md), `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.vscode/settings.json`, `.vscode/extensions.json` | Human docs; formatter, git, and editor config                                       | ✅                            |
| [.claude/settings.json](.claude/settings.json), [.claude/hooks/](.claude/hooks/)                                                | The harness: shared hooks enforcing N1, N2, N4                                      | ⚠️ only when asked            |
| `.claude/settings.local.json`                                                                                                   | The user's personal permission allow list (gitignored)                              | ⚠️ only when asked            |
| `.auth/session.json`                                                                                                            | Captured session state — shape in §5                                                | ❌ generated                  |
| `.auth/session.init.js`                                                                                                         | Web-storage init script loaded via `--init-script`                                  | ❌ generated                  |
| `package-lock.json`                                                                                                             | Dependency lock, rewritten by `npm install`                                         | ❌ generated                  |
| `.features-gen/` `test-results/` `playwright-report/` `blob-report/` `node_modules/` `.playwright-mcp/`                         | Build, report, and MCP output                                                       | ❌ generated                  |

⚠️ = these configure the harness itself. Changing them can switch a guardrail off or grant you permissions, so touch them only when the user explicitly asks.

N4: `.features-gen/` regenerates on every `bddgen` run, so hand-edits there are silently discarded.

**Enforcement:** [check-generated-files.cjs](.claude/hooks/check-generated-files.cjs) denies file-tool edits into any ❌ path above; shell writes aren't inspected but are still forbidden. Fails open. Its path list mirrors the ❌ rows here and [.prettierignore](.prettierignore) — keep all three in step.

Step definitions are spread across **every** `.js` file under [steps/](steps/) — [playwright.config.js](playwright.config.js) globs `steps/**/*.js`, so all of them load. Never assume a single file holds them all (today it happens to be [steps/test.steps.js](steps/test.steps.js); tomorrow it won't be). Search the whole folder before concluding a step is missing.

---

## 2. 🚫 STOP — never run the suite

Applies to: `npx playwright test`, any `npm run` script that wraps it (today `test:parallel:headed`, `test:parallel:headless`, `test:debug`), `bddgen`/`npx bddgen`/`npm run bddgen`, `node global-setup.js`, and `npm test` (no `test` script exists today; still forbidden) — the suite and global setup trigger a real login and `bddgen` rewrites `.features-gen/`, so all of it is the user's call, not yours. `clean`, `report`, `format`, `format:check` are not suite runs.

**Enforcement (best-effort):** [check-no-suite-run.cjs](.claude/hooks/check-no-suite-run.cjs) denies `Bash`/`PowerShell`/`Monitor` commands that start any of these — including in `&&` chains, subshells and `bash -c` — reading wrapper scripts live from [package.json](package.json). Ordinary invocations only; anything it misses is still forbidden. Fails open.

**Hand off instead** — stop and tell the user: (1) what you completed, (2) what's blocked + the exact unblocking command, (3) what stays unverified until it runs. Then wait.

Do not route around this by checking a logged-out page, and do not call a step passing on the assumption it would pass (N5).

---

## 3. 🚫 STOP — `.auth/` validity + freshness gate

Applies before **any** `mcp__playwright__browser_*` call, no exceptions.

**Enforcement:** [check-session-gate.cjs](.claude/hooks/check-session-gate.cjs) runs checks 1–3 below on every `mcp__playwright__browser_*` call and denies the call if any fail. Its shape and expiry checks are `validateSessionState()` + `findExpiredCookies()` imported from [session-state.js](session-state.js), so it can't pass a file a real run would reject. It fails **closed** if the script throws or is missing (the wrapper command in [.claude/settings.json](.claude/settings.json) turns that into a deny) — but if `node` itself isn't on PATH the hook can't run at all and the call goes through, so the rule still binds you. It does **not** replace §4 step 4 (confirming authenticated UI in the snapshot) — that needs judgment on the live page.

1. **Existence/shape** — `.auth/session.json` parses as a JSON object; `origins` present as an **array** whose entries have a string `origin` and, if present, an array `localStorage`; `cookies` present as an array; `.auth/session.init.js` exists. These are `validateSessionState()`'s rules (shape reference: §5), plus one the gate adds on top: `sessionStorage` must be **present** as an object — the validator treats it as optional, but global setup always writes it, so its absence means the file didn't come from global setup.
2. **Cookie expiry (authoritative)** — every cookie's `expires` is `-1` or a future Unix timestamp. Mirrors `findExpiredCookies()` in [session-state.js](session-state.js).
3. **Freshness (heuristic)** — mtime of both `.auth/session.json` and `.auth/session.init.js` must be **≤ 1 hour old**; otherwise fail the gate even if 1–2 pass. The hook reports each file's age in its denial — don't stat or read `.auth/` yourself. Why on top of expiry: cookies can look valid while the session is dead server-side (revoked token, IdP timeout, backend restart, or IndexedDB-held auth — not captured at all, §5). Age is the only local proxy. Bound is deliberately tight: a false block costs one `test:debug` run; a false pass costs confidently-wrong locators read off a login page.
4. **All pass** → §4. **Any fail** → stop, report which check failed (missing file / bad shape / expired cookie name+`expires` / mtime age), state the session must be re-created by logging in again, give the exact command **`npm run test:debug`** (or `test:parallel:*` — each wipes `.auth/` and logs in fresh, §5), then wait. Never create/repair/hand-write the artifacts yourself, and don't assume the session is probably fine.

Why existence alone isn't enough: a hand-written file with singular `origin` / object-shaped `localStorage` still parses (Playwright ignores unknown keys), but `--storage-state` **silently no-ops** on a non-native file — logged-out browser, no error, and every selector/role/name you then verify will be confidently wrong.

The hook re-runs checks 1–3 on every browser call, so a session that goes stale mid-task is caught at the next call, and its denial lists what failed. Don't read `session.json` to check it yourself — the hook already does, and the file holds live session tokens (§5). `.auth/` only refreshes when the user runs the suite, never by your own action.

---

## 4. Workflow — writing a step definition

Applies to anything in [steps/](steps/).

**N6 in practice:** only add new step definitions for steps that don't exist yet. Never modify, "fix", or refactor an existing step definition already in any file under [steps/](steps/) — even if it looks wrong, stale, or improvable. If an existing step seems broken, report it to the user instead of changing it.

**The one exception — `TODO` stubs:** a step whose body is empty apart from a `// TODO` comment is a placeholder, not an implementation — and re-adding it elsewhere would be a duplicate-definition error, so N6 would otherwise make it impossible to implement. Ask the user first; once they agree, fill in the body per steps 1–9 below, keeping the step text and parameter list exactly as they are. A stub passes vacuously, so until it's filled in, tell the user that any scenario using it isn't really checking that line.

**Where steps live:** search **all** of [steps/](steps/) for the step text before writing anything — playwright-bdd loads every `steps/**/*.js`, and two files defining the same step text is a duplicate-definition error, not an override. Add a genuinely new step to the existing file that covers the same area; start a new `steps/<area>.steps.js` only for a new area, and match the `createBdd()` setup the other files use.

**N3 in practice:** never write a locator/role/name/URL/title from memory, the feature file's wording, or how the page "should" look — confirm live first. A plausible-looking locator still parses and runs; it just fails (or silently matches the wrong element) the first time the real page differs, and that's invisible until the user runs the suite.

1. The §3 gate runs automatically on your first `browser_*` call (hook). If it denies, stop and hand off per §3 step 4.
2. Load tools — `mcp__playwright__*` are deferred until schemas are fetched. Call `ToolSearch` (a tool call, not shell) with:
   `select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_click,mcp__playwright__browser_evaluate,mcp__playwright__browser_close`
   plus any other `browser_*` names needed.
3. `browser_navigate` to the page. Cookies, localStorage, and sessionStorage are already injected via `--storage-state` + `--init-script` (§5) — make no manual storage calls even though `browser_sessionstorage_set`-style tools exist under `--caps=storage`; that capability is not enabled here (§7), and hand-setting storage would fight the init-script injection.
4. Confirm authenticated UI in the snapshot before trusting anything on the page. Login page → stop per §3; don't read locators off it.
5. `browser_snapshot` for real refs/roles/names. Perform the interaction, snapshot again to confirm the resulting title/URL/state.
6. **Verify every XPath you'll write** with `browser_evaluate` (`document.evaluate`) — a snapshot shows roles and names, not the classes/attributes an XPath depends on. Run the exact expression with a real parameter value substituted and check the match count: exactly 1 for a single element, the expected number for a list; 0 means it's wrong.
7. `browser_close`.
8. Write the step using only values confirmed in steps 3–6.
9. Hand off (§2): state what was confirmed by snapshot/evaluate and what's unverified, and give the exact command to run the scenario — `npm run test:debug -- <path to the .feature file>`. Never run it yourself; claim no result you haven't seen (N5).

---

## 5. Session state — how the pieces flow

Applies to [session-state.js](session-state.js), [global-setup.js](global-setup.js), `.auth/session.json`, the `"I inject session state from file"` step.

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

**sessionStorage workaround:** Playwright's `storageState` doesn't persist session storage (only cookies, localStorage, opt-in IndexedDB, passkeys), so this repo hand-rolls it: `page.addInitScript()` for the test step, the generated init script for MCP. `--caps=storage` tools (`browser_sessionstorage_*` etc.) exist but aren't enabled (§7) — `--init-script` already auto-seeds on every page load.

**Other facts:**

- **No session reuse** — `global-setup.js` deletes `.auth/` unconditionally first, then logs in fresh every run (including `test:debug`), so a stale/expired/half-written pair can never leak into a run.
- The login in `global-setup.js` is a real flow: it signs in to the OrangeHRM demo site in a headed Firefox window (the tests themselves run in Chromium).
- Fresh login happens by **running the suite** (`test:debug`, `test:parallel:*`), never by manually deleting `.auth/` — don't tell the user to do that.
- **IndexedDB not captured** (`storageState({ indexedDB: true })` isn't called) — a token stored there makes the session look valid but be incomplete.
- `session.init.js` holds **real session values as plaintext JS**. `.auth/` is gitignored — keep it that way; never paste its contents into logs/issues/commits/chat.
- **Invariant:** both consumers must end up with all three state pieces. Changing what `global-setup.js` writes requires updating `validateSessionState()`, `writeInitScript()`, and both readers together. The §3 gate hook imports `validateSessionState()` and `findExpiredCookies()`, so it follows automatically; only its extra checks (sessionStorage present, init script present, freshness) live in [.claude/hooks/check-session-gate.cjs](.claude/hooks/check-session-gate.cjs).

---

## 6. Conventions

### Step definitions (same scope as §4)

Match existing style in the step files already under [steps/](steps/).

- **XPath-only locators**: use `page.locator('xpath=...')` for all locators, not `getByRole`/`getByLabel`/`getByText`/CSS. ✅ `page.locator("xpath=//a[contains(@class,'docs-link')]")` ❌ `page.getByRole('link', { name: 'Docs' })`
- **Scope before assert**: narrow to a container first with a scoped xpath. ✅ `page.locator("xpath=//nav[@aria-label='Docs sidebar']//a[text()='Docs']")`
- **Lists go in a data table**: take the table as the last argument and iterate `table.hashes()`, with an UPPERCASE header column.
- **Quote-safe XPath**: a parameter pasted raw inside `'…'` in an XPath breaks on any value containing an apostrophe. In new steps, build the literal so it survives one — plain quotes when the value has none, XPath `concat()` when it does.
- **Web-first assertions only**: `toBeVisible`, `toHaveTitle`, `toHaveURL`. ❌ `waitForTimeout`/`setTimeout`/manual sleep. Don't add new `waitForLoadState('networkidle')` either — existing code may use it, but Playwright discourages it (slow, and flaky on pages that keep polling); assert on the element you need instead.
- **ESM imports**; Node builtins as `node:fs`/`node:path`.
- **Declarative, reusable step text** — values (names, labels, search terms) come in as `{string}` parameters, never hard-coded in the step text; specifics live in the feature file.

### Feature files ([features/](features/))

- **Logged-in scenarios start with** `Given I inject session state from file` — normally in the `Background`, before any navigation. Leaving it out gives a logged-out run (§8).
- **One `Feature` per file**, named after its test ID, with a matching tag on the scenario.
- **Reuse existing step text verbatim.** Any wording change — even punctuation or quotes — no longer matches the existing definition, so it needs a new one (§4). Search [steps/](steps/) for the phrase before writing a new line.
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

⚠️ **Do not add `--caps=storage`.** It's a real flag and would add `browser_cookie_*`/`browser_localstorage_*`/`browser_sessionstorage_*`/`browser_storage_state` tools, but this repo already auto-seeds sessionStorage on every page via `--init-script` (§5); adding manual get/set tools on top risks calls happening out of step with that injection, reintroducing the drift `global-setup.js` prevents. Need ad-hoc storage inspection? Use `browser_evaluate` instead.

---

## 8. Failure modes

| Symptom                                              | Likely cause                                                                | Fix                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP browser shows a login page                       | `.auth/session.json` missing, expired, stale, or non-native shape           | §3 — stop; tell user to re-login via `npm run test:debug`                                                                                           |
| Cookies restore but localStorage doesn't             | Singular `origin` / object-shaped `localStorage`; Playwright ignores both   | §5 — regenerate via global setup                                                                                                                    |
| App loads but behaves as anonymous                   | `.auth/session.init.js` missing/stale                                       | §3 — stop; re-login via `npm run test:debug`                                                                                                        |
| `Tool not found: mcp__playwright__…`                 | Schemas never fetched, or tool needs `--caps=storage` (not enabled)         | §4 step 2 — `ToolSearch`; a missing storage/network/vision/pdf/devtools/testing/config tool means the capability flag isn't enabled here on purpose |
| Feature file edits have no effect                    | Stale `.features-gen/` — regenerates only when user runs the suite          | Ask user to re-run; never edit `.features-gen/`                                                                                                     |
| Step passes in MCP, fails in the run                 | Verified while logged out, or scenario missing session-injection `Given`    | Re-verify per §4; confirm scenario injects session state                                                                                            |
| Flaky visibility assertion                           | Ambiguous locator matching several nodes                                    | Scope the XPath to a container; use exact `text()='…'` instead of `contains()`; avoid blind `.first()` / `[1]`                                      |
| Browser call denied: `Blocked by CLAUDE.md §3 (N2)`  | A §3 check failed (the denial lists which), or the gate hook couldn't start | Stop; relay the reasons; ask the user to run `npm run test:debug` (or to fix the hook, if it couldn't start)                                        |
| Shell command denied: `Blocked by CLAUDE.md §2 (N1)` | The command would run the suite, `bddgen`, or global setup                  | Hand off per §2 — never reword the command                                                                                                          |
| File edit denied: `Blocked by CLAUDE.md §1 (N4)`     | The target is generated output                                              | Change the source (`.feature`, `steps/`, `package.json`) or ask the user to re-run the suite                                                        |
