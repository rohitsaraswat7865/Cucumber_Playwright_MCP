import { expect, firefox } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SESSION_FILE, writeInitScript, writeSessionState } from './session-state.js';

export { SESSION_FILE };

const AES_ALGORITHM = 'aes-256-cbc';

// Password at rest is AES-256-CBC encrypted, keyed off the login username so
// the plaintext credential never appears in source. Format: "<iv-hex>:<ciphertext-hex>".
function decryptWithKey(encryptedText, key) {
  const [ivHex, dataHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const derivedKey = crypto.createHash('sha256').update(key, 'utf8').digest();
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, derivedKey, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Credentials come from the environment: CI variables in the pipeline, or a
// local .env file otherwise. loadEnvFile never overrides variables already set.
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
const ENCRYPTED_PASSWORD = process.env.LOGIN_ENCRYPTED_PASSWORD;
// Login browser is headless unless LOGIN_HEADLESS is explicitly "false".
const LOGIN_HEADLESS = process.env.LOGIN_HEADLESS?.trim().toLowerCase() !== 'false';

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
  if (!LOGIN_USERNAME || !ENCRYPTED_PASSWORD) {
    throw new Error(
      'LOGIN_USERNAME and LOGIN_ENCRYPTED_PASSWORD must be set (see package.json scripts).',
    );
  }

  fs.rmSync('.auth', { recursive: true, force: true });

  const browser = await firefox.launch({
    headless: LOGIN_HEADLESS,
    slowMo: 1_500,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://magentabuiltstg.t-mobile.com/Login.do', {
    waitUntil: 'networkidle',
    timeout: 90_000,
  });
  await page.locator('xpath=//input[@type="email"]').click({
    force: true,
    timeout: 90_000,
  });
  await page.keyboard.type(LOGIN_USERNAME);
  await page.locator('xpath=//input[@type="submit" and @value="Next"]').click({
    force: true,
    timeout: 90_000,
  });

  await expect(page.locator('xpath=//div[text()="Enter password"]')).toBeVisible({
    timeout: 90_000,
  });

  await page.locator('xpath=//input[@placeholder="Password"]').click({
    force: true,
    timeout: 90_000,
  });
  await page.keyboard.type(decryptWithKey(ENCRYPTED_PASSWORD, LOGIN_USERNAME));
  await page.locator('xpath=//input[@type="submit" and @value="Sign in"]').click({
    force: true,
    delay: 1_00,
    timeout: 90_000,
  });

  await page.waitForURL('https://magentabuiltstg.t-mobile.com/Default.do', {
    waitUntil: 'networkidle',
    timeout: 100_000,
  });

  await expect(
    page.locator('xpath=//label[contains(string(),"Welcome To MagentaBuilt")]'),
  ).toBeAttached({
    timeout: 20_000,
    toBeVisible: true,
  });

  const sessionStorage = await page.evaluate(() => ({ ...window.sessionStorage }));

  const state = await writeSessionState(context, sessionStorage);

  writeInitScript(state);

  await browser.close();
}
