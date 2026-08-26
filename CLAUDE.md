# CLAUDE.md — Playwright + Cucumber BDD test framework

> 🚫 STOP sections gate an action, not advise on it. Where a rule and your judgment disagree, the rule wins.

---

## 0. Non-negotiables

| #      | Rule                                                                                                            | Full text |
| ------ | --------------------------------------------------------------------------------------------------------------- | --------- |
| **N1** | Never run the test suite, `bddgen`, or global setup. Hand off instead.                                          | §2        |
| **N2** | Never call `mcp__playwright__browser_*` until both `.auth/` artifacts pass the validity **and freshness** gate. | §3        |
| **N3** | Never write a locator, role, accessible name, URL, or title you haven't confirmed against the live page.        | §4        |
| **N4** | Never hand-edit a generated file (`.auth/*`, `.features-gen/`, report dirs).                                    | §1        |
| **N5** | Never call a step passing/working/done without a real run result.                                               | §2, §4    |

---

## 1. Overview

Playwright + Gherkin. ESM (`"type": "module"`), Chromium only, headed by default.

| Path                                                                                 | Role                                                   | Editable     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------ |
| [features/](features/) `**/*.feature`                                                | Gherkin scenarios                                      | ✅           |
| [steps/test.steps.js](steps/test.steps.js)                                           | Step definitions via `createBdd()`                     | ✅           |
| [playwright.config.js](playwright.config.js)                                         | `defineBddConfig({ features, steps })` + runner config | ✅           |
| [global-setup.js](global-setup.js)                                                   | One-time login → writes both `.auth/` artifacts (§5)   | ✅           |
| [session-state.js](session-state.js)                                                 | Format contract for session file (read/write/validate) | ✅           |
| `.auth/session.json`                                                                 | Captured session state — shape in §5                   | ❌ generated |
| `.auth/session.init.js`                                                              | Web-storage init script loaded via `--init-script`     | ❌ generated |
| `.features-gen/` `test-results/` `playwright-report/` `blob-report/` `node_modules/` | Build/report output                                    | ❌ generated |

N4: `.features-gen/` regenerates on every `bddgen` run, so hand-edits there are silently discarded.

---

## 2. 🚫 STOP — never run the suite

Applies to: `npx playwright test`, `npm test`, any wrapping `npm run` script, `bddgen`/`npx bddgen`, `node global-setup.js` — running any of these triggers a real login, which is the user's call, not yours.

**Hand off instead** — stop and tell the user: (1) what you completed, (2) what's blocked + the exact unblocking command, (3) what stays unverified until it runs. Then wait.

Do not route around this by checking a logged-out page, and do not call a step passing on the assumption it would pass (N5).

---

## 3. 🚫 STOP — `.auth/` validity + freshness gate

Applies before **any** `mcp__playwright__browser_*` call, no exceptions.

1. **Existence/shape** — read `.auth/session.json`, confirm all: file parses as JSON; `origins` present as an **array**; `cookies` present; `sessionStorage` present; `.auth/session.init.js` exists. Shape reference: §5.
2. **Cookie expiry (authoritative)** — every cookie's `expires` is `-1` or a future Unix timestamp. Mirrors `findExpiredCookies()` in [session-state.js](session-state.js).
3. **Freshness (heuristic)** — mtime of both `.auth/session.json` and `.auth/session.init.js` must be **≤ 1 hour old**; otherwise fail the gate even if 1–2 pass. Check both time values in one call:
   ```
   node -e "const s=require('fs').statSync('.auth/session.json');console.log(s.mtime.toISOString(),((Date.now()-s.mtimeMs)/3.6e6).toFixed(2)+'h old')"
   ```
   Why on top of expiry: cookies can look valid while the session is dead server-side (revoked token, IdP timeout, backend restart, or IndexedDB-held auth — not captured at all, §5). Age is the only local proxy. Bound is deliberately tight: a false block costs one `test:debug` run; a false pass costs confidently-wrong locators read off a login page.
4. **All pass** → §4. **Any fail** → stop, report which check failed (missing file / bad shape / expired cookie name+`expires` / mtime age), state the session must be re-created by logging in again, give the exact command **`npm run test:debug`** (or `test:parallel:*` — each wipes `.auth/` and logs in fresh, §5), then wait. Never create/repair/hand-write the artifacts yourself, and don't assume the session is probably fine.

Why existence alone isn't enough: a hand-written file with singular `origin` / object-shaped `localStorage` still parses (Playwright ignores unknown keys), but `--storage-state` **silently no-ops** on a non-native file — logged-out browser, no error, and every selector/role/name you then verify will be confidently wrong.

Re-run all three checks at the start of every browsing session and again if >1 hour has passed mid-session — `.auth/` only refreshes when the user runs the suite, never by your own action.

---

## 4. Workflow — writing/changing a step definition

Applies to anything in [steps/](steps/).

**N3 in practice:** never write a locator/role/name/URL/title from memory, the feature file's wording, or how the page "should" look — confirm live first. A plausible-looking locator still parses and runs; it just fails (or silently matches the wrong element) the first time the real page differs, and that's invisible until the user runs the suite.

1. Run the §3 gate.
2. Load tools — `mcp__playwright__*` are deferred until schemas are fetched. Call `ToolSearch` (a tool call, not shell) with:
   `select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_click,mcp__playwright__browser_close`
   plus any other `browser_*` names needed.
3. `browser_navigate` to the page. Cookies/localStorage/sessionStorage are already injected via `--init-script` (§5) — make no manual storage calls even though `browser_sessionstorage_set`-style tools exist under `--caps=storage`; that capability is not enabled here (§7), and hand-setting storage would fight the init-script injection.
4. Confirm authenticated UI in the snapshot before trusting anything on the page. Login page → stop per §3; don't read locators off it.
5. `browser_snapshot` for real refs/roles/names. Perform the interaction, snapshot again to confirm the resulting title/URL/state.
6. `browser_close`.
7. Write the step using only values confirmed in steps 3–6.
8. Hand off (§2): state what was confirmed by snapshot and what's unverified, ask the user to run the scenario. Never run it yourself; claim no result you haven't seen (N5).

---

## 5. Session state — how the pieces flow

Applies to [session-state.js](session-state.js), [global-setup.js](global-setup.js), `.auth/session.json`, the `"I inject session state from file"` step.

`global-setup.js` runs once per test run, before any worker, writing **two** artifacts from one capture (so they can't drift):

- `.auth/session.json` — native `storageState` (`cookies`, `origins[].localStorage`) + a top-level `sessionStorage` field (Playwright doesn't capture this natively; ignores the extra unknown key harmlessly).
- `.auth/session.init.js` — localStorage + sessionStorage inlined as a web-storage init script.

Both consumers go through `readSessionState()` ([session-state.js](session-state.js)), which **throws** on a missing/unparseable/non-native file rather than injecting nothing:

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
- Login body is still a `TODO` stub in `global-setup.js`.
- Fresh login happens by **running the suite** (`test:debug`, `test:parallel:*`), never by manually deleting `.auth/` — don't tell the user to do that.
- **IndexedDB not captured** (`storageState({ indexedDB: true })` isn't called) — a token stored there makes the session look valid but be incomplete.
- `session.init.js` holds **real session values as plaintext JS**. `.auth/` is gitignored — keep it that way; never paste its contents into logs/issues/commits/chat.
- **Invariant:** both consumers must end up with all three state pieces. Changing what `global-setup.js` writes requires updating `validateSessionState()`, `writeInitScript()`, and both readers together.

---

## 6. Conventions (step definitions, same scope as §4)

Match existing style in [steps/test.steps.js](steps/test.steps.js).

- **Role-first locators**: `getByRole`/`getByLabel`/`getByText` over CSS/XPath. ✅ `page.getByRole('link', { name: 'Docs' })` ❌ `page.locator('.nav > a.docs-link')`
- **Scope before assert**: narrow to a container first. ✅ `page.getByRole('navigation', { name: 'Docs sidebar' }).getByRole('link', { name })`
- **Parameterize with `{string}`**. ✅ `When("I click link {string}", async ({ page }, str) => …)` ❌ `When("I click the Docs link", …)`
- **Web-first assertions only**: `toBeVisible`, `toHaveTitle`, `toHaveURL`. ❌ `waitForTimeout`/`setTimeout`/manual sleep.
- **ESM imports**; Node builtins as `node:fs`/`node:path`.
- **Declarative, reusable step text** — specifics live in the feature file.

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

⚠️ **Do not add `--caps=storage`.** It's valid (verified against `@playwright/mcp@latest` v0.0.79) and would add `browser_cookie_*`/`browser_localstorage_*`/`browser_sessionstorage_*`/`browser_storage_state` tools, but this repo already auto-seeds sessionStorage on every page via `--init-script` (§5); adding manual get/set tools on top risks calls happening out of step with that injection, reintroducing the drift `global-setup.js` prevents. Need ad-hoc storage inspection? Use `browser_evaluate` instead.

---

## 8. Failure modes

| Symptom                                  | Likely cause                                                              | Fix                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP browser shows a login page           | `.auth/session.json` missing, expired, stale, or non-native shape         | §3 — stop; tell user to re-login via `npm run test:debug`                                                                                           |
| Cookies restore but localStorage doesn't | Singular `origin` / object-shaped `localStorage`; Playwright ignores both | §5 — regenerate via global setup                                                                                                                    |
| App loads but behaves as anonymous       | `.auth/session.init.js` missing/stale                                     | §3 — stop; re-login via `npm run test:debug`                                                                                                        |
| `Tool not found: mcp__playwright__…`     | Schemas never fetched, or tool needs `--caps=storage` (not enabled)       | §4 step 2 — `ToolSearch`; a missing storage/network/vision/pdf/devtools/testing/config tool means the capability flag isn't enabled here on purpose |
| Feature file edits have no effect        | Stale `.features-gen/` — regenerates only when user runs the suite        | Ask user to re-run; never edit `.features-gen/`                                                                                                     |
| Step passes in MCP, fails in the run     | Verified while logged out, or scenario missing session-injection `Given`  | Re-verify per §4; confirm scenario injects session state                                                                                            |
| Flaky visibility assertion               | Ambiguous locator matching several nodes                                  | Scope to a container; add `exact: true`; avoid blind `.first()`                                                                                     |
