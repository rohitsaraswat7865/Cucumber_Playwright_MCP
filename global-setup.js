import { chromium } from '@playwright/test';
import fs from 'node:fs';
import {
  SESSION_FILE,
  writeInitScript,
  writeSessionState,
} from './session-state.js';

export { SESSION_FILE };

// Runs once for the whole test run, in a dedicated process before any worker
// starts. Logs in a single time and captures session state to SESSION_FILE, so
// scenarios can inject that state into their own browser context instead of
// logging in each time.
//
// The file is written by writeSessionState() in Playwright's native
// storageState format (cookies + per-origin localStorage) with sessionStorage
// appended as an extra top-level field. That exact shape is what lets the same
// file serve both consumers unmodified - see the contract in session-state.js.
export default async function globalSetup() {
  // Always log in fresh - no session reuse. Wipe any leftover .auth/ artifacts
  // from a previous run so a stale or malformed file can never be trusted.
  fs.rmSync('.auth', { recursive: true, force: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
 
  await page.goto('https://www.saucedemo.com/');
  await page.locator("xpath=//input[@id='user-name']").click();
  await page.keyboard.type("standard_user");
  await page.locator("xpath=//input[@id='password']").click();
  await page.keyboard.type("secret_sauce");
  await page.locator("xpath=//input[@name='login-button']").click({
    delay: 1_00
  });
  //await page.keyboard.press("Enter");  
  await page.waitForURL('https://www.saucedemo.com/inventory.html', {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });

  // Captured from the page's current origin - storageState() does not include
  // sessionStorage, so it has to be read out separately.
  const sessionStorage = await page.evaluate(() => ({ ...window.sessionStorage }));

  const state = await writeSessionState(context, sessionStorage);

  // Companion artifact for the MCP server: --storage-state cannot carry web
  // storage, so the same captured values are emitted as an init script that
  // .mcp.json loads via --init-script. Written here so the two can never
  // drift out of sync.
  writeInitScript(state);

  await browser.close();
}
