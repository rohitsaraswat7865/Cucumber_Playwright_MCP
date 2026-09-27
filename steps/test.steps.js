import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { localStorageByOrigin, readSessionState } from '../session-state.js';

const { Given, When, Then } = createBdd();

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  const parts = value.split("'").map((part) => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

Given('I inject session state from file', async ({ context, page }) => {
  // Throws if the file is missing or not in native storageState format, rather
  // than quietly injecting nothing and letting the scenario run logged out.
  const { cookies, origins, sessionStorage } = readSessionState();

  await context.addCookies(cookies);

  const byOrigin = localStorageByOrigin(origins);

  await page.addInitScript(
    ({ byOrigin, sessionStorage }) => {
      for (const [key, value] of Object.entries(byOrigin[window.location.origin] ?? {})) {
        window.localStorage.setItem(key, value);
      }
      for (const [key, value] of Object.entries(sessionStorage)) {
        window.sessionStorage.setItem(key, value);
      }
    },
    { byOrigin, sessionStorage },
  );
});

Given('Load default page', async ({ page }) => {
  await page.goto('https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index');

  await page.waitForURL('**/dashboard/index', {
    timeout: 40_000,
  });

  await page.waitForLoadState('networkidle');
});

When('I click on {string} in left navigation panel', async ({ page }, str) => {
  await page
    .locator(
      `xpath=//nav[@aria-label='Sidepanel']//a[contains(@class,'oxd-main-menu-item')][.//span[text()='${str}']]`,
    )
    .click();
});

Then('Top bar header contains text {string}', async ({ page }, str) => {
  await expect(
    page.locator(
      `xpath=//span[contains(@class,'oxd-topbar-header-breadcrumb')]/h6[contains(.,'${str}')]`,
    ),
  ).toBeVisible();
});

Then('Left navigation panel contains following items', async ({ page }, table) => {
  for (const { NAME } of table.hashes()) {
    await expect(
      page.locator(
        `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')][.//span[text()='${NAME}']]`,
      ),
    ).toBeVisible();
  }
});

When('I type {string} in Search', async ({ page }, str) => {
  await page
    .locator("xpath=//nav[@aria-label='Sidepanel']//input[@placeholder='Search']")
    .fill(str);
});

Then('Only {string} is visible in left navigation panel', async ({ page }, str) => {
  await expect(
    page.locator(
      "xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')]",
    ),
  ).toHaveCount(1);

  await expect(
    page.locator(
      `xpath=//nav[@aria-label='Sidepanel']//ul[contains(@class,'oxd-main-menu')]//a[contains(@class,'oxd-main-menu-item')][.//span[text()=${xpathLiteral(str)}]]`,
    ),
  ).toBeVisible();
});

When('I click on main menu {string} in left navigation panel', async ({ page }, str) => {
  await page
    .locator(`xpath=//nav[@aria-label='Sidepanel']//input[@placeholder=${xpathLiteral(str)}]`)
    .click();
});
