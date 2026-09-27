import { expect, firefox } from '@playwright/test';
import fs from 'node:fs';
import { writeInitScript, writeSessionState } from './session-state.js';

// Runs once for the whole test run, in a dedicated process before any worker
// starts. Logs in a single time and captures session state to .auth/session.json,
// so scenarios can inject that state into their own browser context instead of
// logging in each time.
//
// The file is written by writeSessionState() in Playwright's native
// storageState format (cookies + per-origin localStorage) with sessionStorage
// appended as an extra top-level field. That exact shape is what lets the same
// file serve both consumers unmodified - see the contract in session-state.js.
export default async function globalSetup() {
  // No session reuse: every run logs in fresh. Wipe .auth/ before the login
  // below so a stale, expired, or half-written pair from a previous run can
  // never be trusted, and so both artifacts always come from this capture.
  fs.rmSync('.auth', { recursive: true, force: true });

  const browser = await firefox.launch({
    headless: false,
    slowMo: 1_500,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/auth/login', {
    waitUntil: 'networkidle',
    timeout: 90_000,
  });
  await page.locator('css=input[name="username"]').click({
    timeout: 90_000,
  });
  await page.keyboard.type('Admin');
  await page.locator('css=input[name="password"]').click({
    timeout: 90_000,
  });

  await page.keyboard.type('admin123');
  await expect(page.locator('//button[contains(string(),"Login")]')).toHaveAttribute(
    'type',
    'submit',
  );

  await page.locator('//button[contains(string(),"Login")]').click({
    force: true,
  });

  await page.waitForURL('**/dashboard/index', {
    timeout: 40_000,
  });

  await page.waitForLoadState('networkidle');
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
